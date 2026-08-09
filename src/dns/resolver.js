"use strict";

const { DnsCache } = require("./cache");
const { buildResponse, minimumAnswerTtl, parseMessage } = require("./message");
const { RecordStore } = require("./records");

class UpstreamError extends Error {
  constructor(message, { retryable = true, cause } = {}) {
    super(message, { cause });
    this.name = "UpstreamError";
    this.retryable = retryable;
  }
}

function cacheKey(message) {
  const question = message.questions[0];
  const opt = message.additionals.find((record) => record.type === "OPT");
  return [question.name, question.type, question.class, message.flags.cd ? 1 : 0, opt?.dnssecOk ? 1 : 0].join("|");
}

function withTransactionId(wire, id) {
  const copy = Buffer.from(wire);
  copy.writeUInt16BE(id, 0);
  return copy;
}

function createResolver({ records = new RecordStore(), upstreams = [], cache = new DnsCache(), onEvent = () => {} } = {}) {
  if (!records || typeof records.find !== "function") throw new TypeError("records must provide find(name, type)");

  return {
    async resolve(queryWire) {
      const query = parseMessage(queryWire);
      if (query.questions.length !== 1) return buildResponse(queryWire, [], { rcode: "FORMERR" });
      const question = query.questions[0];
      if (question.type === "AXFR" || question.type === "IXFR") {
        return buildResponse(queryWire, [], { rcode: "NOTIMP" });
      }

      const customRecords = records.find(question.name, question.type);
      if (customRecords.length > 0) {
        onEvent({ kind: "dns", source: "custom", name: question.name, type: question.type });
        return buildResponse(queryWire, customRecords, { authoritative: true });
      }

      const key = cacheKey(query);
      const cached = cache.get(key);
      if (cached) {
        onEvent({ kind: "dns", source: "cache", name: question.name, type: question.type });
        return withTransactionId(cached, query.id);
      }

      for (const upstream of upstreams) {
        try {
          const responseWire = await upstream.resolve(queryWire);
          const response = parseMessage(responseWire);
          if (!response.flags.qr || response.id !== query.id || response.questions.length !== 1) {
            throw new UpstreamError("Invalid DNS response from upstream", { retryable: true });
          }
          const ttl = minimumAnswerTtl(responseWire);
          cache.set(key, responseWire, ttl, { successful: response.flags.rcode === 0 && response.answers.length > 0 });
          onEvent({ kind: "dns", source: upstream.name || "upstream", name: question.name, type: question.type });
          return responseWire;
        } catch (error) {
          const normalized = error instanceof UpstreamError
            ? error
            : new UpstreamError(error.message || "Upstream request failed", { retryable: true, cause: error });
          onEvent({ kind: "upstream-error", upstream: upstream.name, message: normalized.message });
          if (!normalized.retryable) break;
        }
      }
      return buildResponse(queryWire, [], { rcode: "SERVFAIL" });
    },
  };
}

module.exports = { UpstreamError, cacheKey, createResolver, withTransactionId };
