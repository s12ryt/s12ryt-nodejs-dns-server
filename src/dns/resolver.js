"use strict";

const { DnsCache } = require("./cache");
const { buildResponse, createQuery, minimumAnswerTtl, normalizeName, parseMessage } = require("./message");
const { RecordStore } = require("./records");

const MAX_CNAME_DEPTH = 16;
const RCODE_NAMES = Object.freeze([
  "NOERROR",
  "FORMERR",
  "SERVFAIL",
  "NXDOMAIN",
  "NOTIMP",
  "REFUSED",
]);

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

function recordForEncoding(record) {
  if (record.type === "A" || record.type === "AAAA") return { ...record, value: record.address };
  return { ...record };
}

function followUpQuery(query, target) {
  const opt = query.additionals.find((record) => record.type === "OPT");
  return createQuery(target, query.questions[0].type, {
    id: query.id,
    class: query.questions[0].class,
    recursionDesired: query.flags.rd,
    edns: Boolean(opt),
    udpPayloadSize: opt?.udpPayloadSize,
    dnssecOk: opt?.dnssecOk,
  });
}

function addSource(context, source) {
  if (source && context.sources.at(-1) !== source) context.sources.push(source);
}

function rcodeName(code) {
  return RCODE_NAMES[code] || `RCODE_${code}`;
}

function createResolver({ records = new RecordStore(), zones = null, policies = null, upstreams = [], cache = new DnsCache(), onEvent = () => {} } = {}) {
  if (!records || typeof records.find !== "function") throw new TypeError("records must provide find(name, type)");
  if (zones && typeof zones.resolve !== "function") throw new TypeError("zones must provide resolve(name, type)");
  if (policies && typeof policies.evaluate !== "function") throw new TypeError("policies must provide evaluate(request)");

  async function resolveInternal(queryWire, context = { depth: 0, visited: new Set(), sources: [], request: {} }) {
      const query = parseMessage(queryWire);
      if (query.questions.length !== 1) return buildResponse(queryWire, [], { rcode: "FORMERR" });
      const question = query.questions[0];
      if (question.type === "AXFR" || question.type === "IXFR") {
        return buildResponse(queryWire, [], { rcode: "NOTIMP" });
      }

      const policy = policies?.evaluate({
        name: question.name,
        type: question.type,
        clientIp: context.request.clientIp,
        now: context.request.now,
      });
      if (policy) {
        addSource(context, "policy");
        context.policy = policy;
        if (policy.action.type === "NXDOMAIN" || policy.action.type === "REFUSED") {
          return buildResponse(queryWire, [], { rcode: policy.action.type });
        }
        const record = {
          name: question.name,
          type: policy.action.type,
          value: policy.action.value,
          ttl: policy.action.ttl,
        };
        if (policy.action.type === "CNAME" && ["A", "AAAA"].includes(question.type)) {
          const target = normalizeName(policy.action.value);
          const visited = new Set(context.visited);
          visited.add(normalizeName(question.name));
          if (!target || context.depth >= MAX_CNAME_DEPTH || visited.has(target)) {
            return buildResponse(queryWire, [], { rcode: "SERVFAIL" });
          }
          const targetWire = await resolveInternal(followUpQuery(query, target), {
            depth: context.depth + 1,
            visited,
            sources: context.sources,
            request: context.request,
            policy: context.policy,
          });
          const targetResponse = parseMessage(targetWire);
          if (targetResponse.flags.rcode !== 0) return buildResponse(queryWire, [], { rcode: targetResponse.flags.rcode });
          return buildResponse(queryWire, [record, ...targetResponse.answers.map(recordForEncoding)], {
            rcode: targetResponse.flags.rcode,
            authorities: targetResponse.authorities.map(recordForEncoding),
            additionals: targetResponse.additionals.map(recordForEncoding),
          });
        }
        return buildResponse(queryWire, [record]);
      }

      const zoneResult = zones?.resolve(question.name, question.type);
      if (zoneResult) {
        addSource(context, "custom");
        const aliases = zoneResult.answers.filter((record) => record.type === "CNAME");
        if (["A", "AAAA"].includes(question.type) && aliases.length > 0) {
          const target = normalizeName(aliases[0].value);
          const visited = new Set(context.visited);
          visited.add(normalizeName(question.name));
          if (!target || context.depth >= MAX_CNAME_DEPTH || visited.has(target)) {
            return buildResponse(queryWire, [], { rcode: "SERVFAIL" });
          }
          const targetWire = await resolveInternal(followUpQuery(query, target), {
            depth: context.depth + 1,
            visited,
            sources: context.sources,
            request: context.request,
          });
          const targetResponse = parseMessage(targetWire);
          if (targetResponse.flags.rcode === 2) return buildResponse(queryWire, [], { rcode: "SERVFAIL" });
          return buildResponse(queryWire, [
            ...aliases,
            ...targetResponse.answers.map(recordForEncoding),
          ], {
            authoritative: zoneResult.authoritative,
            rcode: targetResponse.flags.rcode,
            authorities: targetResponse.authorities.map(recordForEncoding),
            additionals: targetResponse.additionals.map(recordForEncoding),
          });
        }
        return buildResponse(queryWire, zoneResult.answers, {
          authoritative: zoneResult.authoritative,
          rcode: zoneResult.rcode,
          authorities: zoneResult.authorities,
          additionals: zoneResult.additionals,
        });
      }

       const customRecords = records.find(question.name, question.type);
       if (customRecords.length > 0) {
         addSource(context, "custom");
         const aliases = customRecords.filter((record) => record.type === "CNAME");
        if (["A", "AAAA"].includes(question.type) && aliases.length > 0) {
          const target = normalizeName(aliases[0].value);
          const visited = new Set(context.visited);
          visited.add(normalizeName(question.name));
          if (!target || context.depth >= MAX_CNAME_DEPTH || visited.has(target)) {
            return buildResponse(queryWire, [], { rcode: "SERVFAIL" });
          }

           const targetWire = await resolveInternal(followUpQuery(query, target), {
             depth: context.depth + 1,
             visited,
              sources: context.sources,
              request: context.request,
           });
          const targetResponse = parseMessage(targetWire);
          if (targetResponse.flags.rcode === 2) return buildResponse(queryWire, [], { rcode: "SERVFAIL" });

          return buildResponse(queryWire, [
            ...aliases,
            ...targetResponse.answers.map(recordForEncoding),
          ], {
            authoritative: true,
            rcode: targetResponse.flags.rcode,
            authorities: targetResponse.authorities.map(recordForEncoding),
          });
        }
        return buildResponse(queryWire, customRecords, { authoritative: true });
      }

      const key = cacheKey(query);
       const cached = cache.get(key);
       if (cached) {
         addSource(context, "cache");
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
           const source = upstream.name || "upstream";
           addSource(context, source);
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
  }

  return {
    async resolve(queryWire, request = {}) {
      const startedAt = process.hrtime.bigint();
      const query = parseMessage(queryWire);
      const sources = [];
       const context = { depth: 0, visited: new Set(), sources, request };
       const responseWire = await resolveInternal(queryWire, context);
      const response = parseMessage(responseWire);
      const question = query.questions[0];
      onEvent({
        ...request,
        kind: "dns",
        source: sources.at(-1) || "none",
        name: question?.name || "",
        type: question?.type || "unknown",
        rcode: rcodeName(response.flags.rcode),
         durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
         ...(context.policy ? {
           policyRule: context.policy.ruleId,
           policyAction: context.policy.action.type,
         } : {}),
      });
      return responseWire;
    },
    async diagnose(name, type) {
      const normalizedName = normalizeName(name);
      const normalizedType = String(type).toUpperCase();
      const sources = [];
      const responseWire = await resolveInternal(createQuery(normalizedName, normalizedType), {
        depth: 0,
        visited: new Set(),
         sources,
         request: {},
      });
      const response = parseMessage(responseWire);
      return {
        name: normalizedName,
        type: normalizedType,
        rcode: rcodeName(response.flags.rcode),
        sources,
        answers: response.answers,
        authorities: response.authorities,
      };
    },
  };
}

module.exports = {
  MAX_CNAME_DEPTH,
  RCODE_NAMES,
  UpstreamError,
  cacheKey,
  createResolver,
  rcodeName,
  recordForEncoding,
  withTransactionId,
};
