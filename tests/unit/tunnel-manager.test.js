"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { TunnelManager } = require("../../src/tunnel/manager");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

test("TunnelManager reports unavailable without a token", async () => {
  const manager = new TunnelManager({ token: "" });
  assert.equal(manager.status().available, false);
  await assert.rejects(manager.start(), /token/i);
});

test("TunnelManager starts with an environment token, captures bounded logs, and stops", async () => {
  const child = new FakeChild();
  let invocation;
  const manager = new TunnelManager({
    token: "secret-token-value",
    ensureBinary: async () => ({ path: "C:/cloudflared.exe", version: "2026.7.3" }),
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
    maxLogs: 2,
  });

  await manager.start();
  assert.equal(invocation.command, "C:/cloudflared.exe");
  assert.deepEqual(invocation.args, ["tunnel", "run"]);
  assert.equal(invocation.options.env.TUNNEL_TOKEN, "secret-token-value");
  assert.equal(invocation.args.includes("secret-token-value"), false);
  child.stdout.emit("data", Buffer.from("connected\n"));
  child.stderr.emit("data", Buffer.from("retrying\nready\n"));

  const running = manager.status();
  assert.equal(running.state, "running");
  assert.equal(running.version, "2026.7.3");
  assert.deepEqual(running.logs, ["retrying", "ready"]);
  assert.equal(JSON.stringify(running).includes("secret-token-value"), false);

  await manager.stop();
  assert.equal(child.killedWith, "SIGTERM");
  assert.equal(manager.status().state, "stopped");
});

test("TunnelManager preserves core availability when binary preparation fails", async () => {
  const manager = new TunnelManager({
    token: "token",
    ensureBinary: async () => { throw new Error("download failed"); },
  });
  await assert.rejects(manager.start(), /download failed/);
  assert.equal(manager.status().state, "error");
  assert.equal(manager.status().lastError, "download failed");
});
