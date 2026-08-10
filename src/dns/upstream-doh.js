"use strict";

const { performance } = require("node:perf_hooks");

const { createQuery } = require("./message");
const { UpstreamError } = require("./resolver");

function mediaType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function createDohUpstream({ name = "DoH", url, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!url || new URL(url).protocol !== "https:") throw new TypeError("DoH upstream URL must use HTTPS");
  let currentStatus = { healthy: null, latencyMs: null, lastError: null };

  return {
    name,
    status() {
      return { ...currentStatus };
    },
    async probe() {
      return this.resolve(createQuery("example.com", "A", { id: 0 }));
    },
    async resolve(queryWire) {
      const started = performance.now();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
          },
          body: queryWire,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          throw new UpstreamError(`DoH upstream returned HTTP ${response.status}`, {
            retryable: response.status >= 500,
          });
        }
        if (mediaType(response.headers.get("content-type")) !== "application/dns-message") {
          throw new UpstreamError("DoH upstream returned an invalid media type");
        }
        const result = Buffer.from(await response.arrayBuffer());
        if (result.length < 12 || result.length > 65535) {
          throw new UpstreamError("DoH upstream returned an invalid DNS message size");
        }
        currentStatus = {
          healthy: true,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          lastError: null,
        };
        return result;
      } catch (error) {
        const normalized = error instanceof UpstreamError
          ? error
          : new UpstreamError(error.message || "DoH upstream request failed", { cause: error });
        currentStatus = {
          healthy: false,
          latencyMs: Math.max(0, Math.round(performance.now() - started)),
          lastError: normalized.message,
        };
        throw normalized;
      }
    },
  };
}

module.exports = { createDohUpstream, mediaType };
