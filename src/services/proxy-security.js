"use strict";

const net = require("node:net");

function normalizeIp(value) {
  const address = String(value || "").trim().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : address;
}

function ipv4Value(address) {
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv6Value(address) {
  let source = address.toLowerCase();
  const ipv4 = source.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4) {
    const value = ipv4Value(ipv4);
    source = `${source.slice(0, -ipv4.length)}${(value >> 16n).toString(16)}:${(value & 0xffffn).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) throw new TypeError(`Invalid IPv6 address: ${address}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) throw new TypeError(`Invalid IPv6 address: ${address}`);
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n);
}

function parseIp(value) {
  const address = normalizeIp(value);
  const version = net.isIP(address);
  if (version === 4) return { address, bits: 32, value: ipv4Value(address) };
  if (version === 6) return { address, bits: 128, value: ipv6Value(address) };
  throw new TypeError(`Invalid IP address: ${value}`);
}

function parseCidr(value) {
  const text = String(value || "").trim();
  const [address, rawPrefix, ...extra] = text.split("/");
  if (!address || extra.length) throw new TypeError(`Invalid CIDR: ${value}`);
  const parsed = parseIp(address);
  const prefix = rawPrefix === undefined ? parsed.bits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) throw new TypeError(`Invalid CIDR: ${value}`);
  const shift = BigInt(parsed.bits - prefix);
  const network = shift === 0n ? parsed.value : (parsed.value >> shift) << shift;
  return { ...parsed, prefix, network, text: `${parsed.address}/${prefix}` };
}

function normalizeCidrs(values = [], label = "CIDR list") {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return [...new Set(values.map((value) => parseCidr(value).text))];
}

function isIpInCidrs(address, cidrs = []) {
  let parsed;
  try {
    parsed = parseIp(address);
  } catch {
    return false;
  }
  return cidrs.some((cidr) => {
    const range = typeof cidr === "string" ? parseCidr(cidr) : cidr;
    if (range.bits !== parsed.bits) return false;
    const shift = BigInt(parsed.bits - range.prefix);
    return (shift === 0n ? parsed.value : (parsed.value >> shift) << shift) === range.network;
  });
}

function resolveClientIp(peerAddress, forwardedFor, trustedProxyCidrs = []) {
  const peer = normalizeIp(peerAddress);
  if (!isIpInCidrs(peer, trustedProxyCidrs)) return peer;
  const forwarded = String(forwardedFor || "").split(",").map((entry) => normalizeIp(entry)).find((entry) => net.isIP(entry));
  return forwarded || peer;
}

function isClientAllowed(address, { allow = [], deny = [] } = {}) {
  if (isIpInCidrs(address, deny)) return false;
  return allow.length === 0 || isIpInCidrs(address, allow);
}

class MemoryRateLimiter {
  #windows = new Map();

  constructor({ now = Date.now, maxKeys = 10000 } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
  }

  consume(key, { requests, windowMs }) {
    const now = this.now();
    let entry = this.#windows.get(key);
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
    if (entry.count >= requests) return { allowed: false, retryAfterMs: Math.max(1, entry.resetAt - now) };
    entry.count += 1;
    this.#windows.delete(key);
    this.#windows.set(key, entry);
    while (this.#windows.size > this.maxKeys) this.#windows.delete(this.#windows.keys().next().value);
    return { allowed: true, retryAfterMs: 0 };
  }

  clear() {
    this.#windows.clear();
  }
}

module.exports = {
  MemoryRateLimiter,
  isClientAllowed,
  isIpInCidrs,
  normalizeCidrs,
  normalizeIp,
  parseCidr,
  parseIp,
  resolveClientIp,
};
