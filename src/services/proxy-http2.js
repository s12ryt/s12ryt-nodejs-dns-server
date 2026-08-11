"use strict";

const http2 = require("node:http2");

class Http2SessionPool {
  constructor({ connect = http2.connect } = {}) {
    if (typeof connect !== "function") throw new TypeError("connect must be a function");
    this.connect = connect;
    this.sessions = new Map();
    this.http1Origins = new Set();
    this.closed = false;
  }

  markHttp1(url) {
    if (!(url instanceof URL) || url.protocol !== "https:") throw new TypeError("HTTP/2 upstream must use HTTPS");
    this.http1Origins.add(url.origin);
    const session = this.sessions.get(url.origin);
    this.sessions.delete(url.origin);
    session?.close?.();
  }

  prefersHttp1(url) {
    return url instanceof URL && this.http1Origins.has(url.origin);
  }

  getSession(url) {
    if (this.closed) throw new Error("HTTP/2 session pool is closed");
    if (!(url instanceof URL) || url.protocol !== "https:") throw new TypeError("HTTP/2 upstream must use HTTPS");
    const origin = url.origin;
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = this.connect(origin);
    this.sessions.set(origin, session);
    const evict = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.once("goaway", evict);
    session.once("close", evict);
    session.once("error", evict);
    return session;
  }

  request(url, headers, options) {
    const session = this.getSession(url);
    return { session, stream: session.request(headers, options) };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.http1Origins.clear();
    await Promise.all(sessions.map((session) => new Promise((resolve) => {
      if (session.closed || session.destroyed) {
        resolve();
        return;
      }
      const done = () => resolve();
      session.once("close", done);
      session.close(done);
    })));
  }
}

module.exports = { Http2SessionPool };
