"use strict";

const { spawn } = require("node:child_process");

class TunnelManager {
  #child = null;
  #logs = [];
  #state = "stopped";
  #lastError = null;
  #version = null;

  constructor({
    token = process.env.CLOUDFLARE_TUNNEL_TOKEN || "",
    ensureBinary = async () => { throw new Error("cloudflared binary is not configured"); },
    spawnImpl = spawn,
    maxLogs = 100,
  } = {}) {
    this.token = String(token);
    this.ensureBinary = ensureBinary;
    this.spawnImpl = spawnImpl;
    this.maxLogs = maxLogs;
  }

  status() {
    return {
      available: Boolean(this.token),
      state: this.#state,
      version: this.#version,
      lastError: this.#lastError,
      logs: [...this.#logs],
    };
  }

  #addLog(chunk) {
    const redacted = String(chunk).split(this.token).join("[redacted]");
    for (const line of redacted.split(/\r?\n/).filter(Boolean)) this.#logs.push(line);
    if (this.#logs.length > this.maxLogs) this.#logs.splice(0, this.#logs.length - this.maxLogs);
  }

  async start() {
    if (!this.token) throw new Error("CLOUDFLARE_TUNNEL_TOKEN is not configured");
    if (this.#child) return this.status();
    this.#state = "starting";
    this.#lastError = null;
    try {
      const binary = await this.ensureBinary();
      this.#version = binary.version || null;
      const child = this.spawnImpl(binary.path, ["tunnel", "run"], {
        env: { ...process.env, TUNNEL_TOKEN: this.token },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.#child = child;
      child.stdout?.on("data", (chunk) => this.#addLog(chunk));
      child.stderr?.on("data", (chunk) => this.#addLog(chunk));
      child.once("error", (error) => {
        this.#lastError = error.message;
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
      this.#lastError = error.message;
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
