"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { Http2SessionPool } = require("../../src/services/proxy-http2");

class FakeSession extends EventEmitter {
  constructor(origin) {
    super();
    this.origin = origin;
    this.closed = false;
    this.destroyed = false;
    this.requests = [];
  }

  request(headers) {
    const stream = new EventEmitter();
    stream.headers = headers;
    stream.end = (body) => { stream.body = body; };
    stream.close = () => {};
    this.requests.push(stream);
    return stream;
  }

  close(callback) { this.closed = true; callback?.(); }
  destroy() { this.destroyed = true; }
}

test("HTTP/2 pool reuses sessions per HTTPS origin and evicts unusable sessions", async () => {
  const sessions = [];
  const pool = new Http2SessionPool({
    connect(origin) {
      const session = new FakeSession(origin);
      sessions.push(session);
      return session;
    },
  });

  const first = pool.request(new URL("https://upstream.example.test/base"), { ":method": "GET", ":path": "/one" });
  const second = pool.request(new URL("https://upstream.example.test/other"), { ":method": "GET", ":path": "/two" });
  assert.equal(sessions.length, 1);
  assert.equal(first.session, second.session);

  sessions[0].emit("goaway");
  const third = pool.request(new URL("https://upstream.example.test"), { ":method": "GET", ":path": "/three" });
  assert.equal(sessions.length, 2);
  assert.notEqual(third.session, first.session);

  sessions[1].emit("error", new Error("connection lost"));
  pool.request(new URL("https://upstream.example.test"), { ":method": "GET", ":path": "/four" });
  assert.equal(sessions.length, 3);

  pool.markHttp1(new URL("https://legacy.example.test/path"));
  assert.equal(pool.prefersHttp1(new URL("https://legacy.example.test/other")), true);
  assert.equal(pool.prefersHttp1(new URL("https://upstream.example.test")), false);

  await pool.close();
  assert.equal(sessions[2].closed, true);
});

test("HTTP/2 pool rejects non-HTTPS origins", () => {
  const pool = new Http2SessionPool({ connect: () => new FakeSession("unused") });
  assert.throws(() => pool.request(new URL("http://upstream.example.test"), {}), /HTTPS/i);
});
