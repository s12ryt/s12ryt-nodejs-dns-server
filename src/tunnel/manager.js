"use strict";

const { spawn } = require("node:child_process");

class TunnelManager {
  #child = null;
  #logs = [];
  #state = "stopped";
  #lastError = null;
  #version = null;
  #token;
  #tokenSource;
  #hasStoredToken;

  constructor({
    token = process.env.CLOUDFLARE_TUNNEL_TOKEN || "",
    tokenSource = token ? "environment" : "none",
    hasStoredToken = false,
    ensureBinary = async () => { throw new Error("cloudflared binary is not configured"); },
    spawnImpl = spawn,
    maxLogs = 100,
  } = {}) {
    this.#token = String(token);
    this.#tokenSource = tokenSource;
    this.#hasStoredToken = Boolean(hasStoredToken);
    this.ensureBinary = ensureBinary;
    this.spawnImpl = spawnImpl;
    this.maxLogs = maxLogs;
  }

  status() {
    return {
      available: Boolean(this.#token),
      tokenSource: this.#tokenSource,
      hasStoredToken: this.#hasStoredToken,
      state: this.#state,
      version: this.#version,
      lastError: this.#lastError,
      logs: [...this.#logs],
    };
  }

  configure({ token, tokenSource, hasStoredToken }) {
    if (typeof token !== "string") throw new TypeError("Tunnel token must be a string");
    if (!new Set(["environment", "config", "none"]).has(tokenSource)) {
      throw new TypeError("Tunnel token source is invalid");
    }
    if (this.#child && token !== this.#token) throw new Error("Tunnel must be stopped before replacing its token");
    this.#token = token;
    this.#tokenSource = tokenSource;
    this.#hasStoredToken = Boolean(hasStoredToken);
    return this.status();
  }

  #redact(value) {
    const text = String(value);
    return this.#token ? text.split(this.#token).join("[redacted]") : text;
  }

  #addLog(chunk) {
    const redacted = this.#redact(chunk);
    for (const line of redacted.split(/\r?\n/).filter(Boolean)) this.#logs.push(line);
    if (this.#logs.length > this.maxLogs) this.#logs.splice(0, this.#logs.length - this.maxLogs);
  }

  async start() {
    if (!this.#token) throw new Error("CLOUDFLARE_TUNNEL_TOKEN is not configured");
    if (this.#child) return this.status();
    this.#state = "starting";
    this.#lastError = null;
    try {
      const binary = await this.ensureBinary();
      this.#version = binary.version || null;
      const child = this.spawnImpl(binary.path, ["tunnel", "run"], {
        env: { ...process.env, TUNNEL_TOKEN: this.#token },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.#child = child;
      child.stdout?.on("data", (chunk) => this.#addLog(chunk));
      child.stderr?.on("data", (chunk) => this.#addLog(chunk));
      child.once("error", (error) => {
        this.#lastError = this.#redact(error.message);
        this.#state = "error";
      });
      child.once("exit", (code) => {
        this.#child = null;
        if (this.#state !== "stopping" && code !== 0) {
          this.#lastError = `cloudflared exited with code ${code}`;
          this.#state = "error";
        } else {
          this.#state = "stopped";
        }
      });
      this.#state = "running";
      return this.status();
    } catch (error) {
      this.#state = "error";
      this.#lastError = this.#redact(error.message);
      throw error;
    }
  }

  async stop() {
    const child = this.#child;
    if (!child) {
      if (this.#state !== "error") this.#state = "stopped";
      return this.status();
    }
    this.#state = "stopping";
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    return this.status();
  }
}

module.exports = { TunnelManager };
