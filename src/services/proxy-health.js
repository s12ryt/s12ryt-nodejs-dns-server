"use strict";

const http = require("node:http");
const https = require("node:https");

function defaultProbe(target) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(target.url);
    url.pathname = target.health.path;
    url.search = "";
    url.hash = "";
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      timeout: target.health.timeoutMs,
      headers: { accept: "*/*", "user-agent": "s12-proxy-health/1" },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const statusCode = response.statusCode || 0;
        resolve({
          healthy: statusCode >= target.health.statusMin && statusCode <= target.health.statusMax,
          statusCode,
          latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
          checkedAt: new Date().toISOString(),
        });
      });
    });
    request.once("timeout", () => request.destroy(Object.assign(new Error("Proxy health check timed out"), { code: "ETIMEDOUT" })));
    request.once("error", reject);
    request.end();
  });
}

class ProxyHealthMonitor {
  constructor({ routes, probe = defaultProbe, schedule = setTimeout, cancel = clearTimeout, onEvent = () => {} } = {}) {
    if (!routes || typeof routes.healthTargets !== "function" || typeof routes.recordActiveProbe !== "function") {
      throw new TypeError("Proxy routes with health target support are required");
    }
    if (typeof probe !== "function") throw new TypeError("Proxy health probe must be a function");
    this.routes = routes;
    this.probe = probe;
    this.schedule = schedule;
    this.cancel = cancel;
    this.onEvent = onEvent;
    this.timers = new Map();
    this.running = false;
    this.closed = false;
  }

  async probeTarget(target) {
    let result;
    try {
      result = await this.probe(target);
    } catch (error) {
      result = { healthy: false, statusCode: null, latencyMs: null, checkedAt: new Date().toISOString(), error: error.message };
    }
    const transition = this.routes.recordActiveProbe(target, result) || {};
    this.onEvent({
      kind: "proxy-health",
      site: target.site,
      location: target.location,
      upstream: target.id,
      fallback: target.fallback,
      ...result,
      ...transition,
    });
    return result;
  }

  async probeNow() {
    const targets = this.routes.healthTargets().filter((target) => target.health.enabled);
    return Promise.all(targets.map((target) => this.probeTarget(target)));
  }

  scheduleTarget(target) {
    if (!this.running || this.closed) return;
    const timer = this.schedule(async () => {
      this.timers.delete(target);
      await this.probeTarget(target);
      this.scheduleTarget(target);
    }, target.health.intervalMs);
    timer.unref?.();
    this.timers.set(target, timer);
  }

  start() {
    if (this.closed) throw new Error("Proxy health monitor is closed");
    if (this.running) return;
    this.running = true;
    for (const target of this.routes.healthTargets().filter((candidate) => candidate.health.enabled)) {
      void this.probeTarget(target).finally(() => this.scheduleTarget(target));
    }
  }

  pause() {
    this.running = false;
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
  }

  close() {
    this.pause();
    this.closed = true;
  }

  status() {
    return { running: this.running, targets: this.routes.healthTargets().length };
  }
}

module.exports = { ProxyHealthMonitor, defaultProbe };
