"use strict";

const { encodeName, normalizeName } = require("../dns/message");
const { RecordStore } = require("../dns/records");

function normalizeDomainName(value) {
  const name = normalizeName(String(value || "").trim());
  if (!name || name.includes("*")) throw new TypeError("Domain name is invalid");
  encodeName(name);
  return name;
}

function normalizeDomain(domain, index = 0) {
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    throw new TypeError(`Domain ${index} must be an object`);
  }
  const name = normalizeDomainName(domain.name);
  const defaultTtl = Number(domain.defaultTtl ?? 300);
  if (!Number.isInteger(defaultTtl) || defaultTtl < 0 || defaultTtl > 0x7fffffff) {
    throw new RangeError(`Domain ${index} has an invalid default TTL`);
  }
  if (domain.note !== undefined && typeof domain.note !== "string") {
    throw new TypeError(`Domain ${index} note must be a string`);
  }
  return {
    ...domain,
    name,
    enabled: domain.enabled !== false,
    defaultTtl,
    note: domain.note || "",
  };
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains)) throw new TypeError("Domains must be an array");
  const normalized = domains.map(normalizeDomain);
  const names = new Set();
  for (const domain of normalized) {
    if (names.has(domain.name)) throw new TypeError(`Duplicate domain: ${domain.name}`);
    names.add(domain.name);
  }
  return normalized;
}

function belongsTo(name, domainName) {
  const normalized = normalizeName(name);
  return normalized === domainName || normalized.endsWith(`.${domainName}`);
}

function classifyDomain(domains, name) {
  const normalized = normalizeName(name);
  return normalizeDomains(domains)
    .filter((domain) => belongsTo(normalized, domain.name))
    .sort((left, right) => right.name.length - left.name.length)[0] || null;
}

function qualifyDomainName(domainName, input) {
  const domain = normalizeDomainName(domainName);
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) throw new TypeError("DNS name is required");
  if (raw === "@") return domain;

  const normalized = normalizeName(raw);
  if (belongsTo(normalized, domain)) {
    encodeName(normalized);
    return normalized;
  }
  if (raw.endsWith(".") || (normalized.includes(".") && !normalized.split(".").every((label) => label.startsWith("_")))) {
    throw new TypeError("Fully qualified DNS name is outside the domain workspace");
  }
  const qualified = `${normalized}.${domain}`;
  encodeName(qualified);
  return qualified;
}

function domainIsEnabled(domains, name) {
  return domains.filter((domain) => belongsTo(name, domain.name)).every((domain) => domain.enabled);
}

function applyDomainState(config) {
  const next = structuredClone(config);
  const domains = normalizeDomains(next.domains || []);
  next.domains = domains;
  next.records = (next.records || []).map((record) => ({
    ...record,
    enabled: record.enabled !== false && domainIsEnabled(domains, record.name),
  }));
  next.routes = (next.routes || []).map((route) => ({
    ...route,
    enabled: route.enabled !== false && domainIsEnabled(domains, route.host),
  }));
  return next;
}

function setDomainEnabled(config, domainName, enabled) {
  const name = normalizeDomainName(domainName);
  const next = structuredClone(config);
  const domain = next.domains.find((candidate) => normalizeName(candidate.name) === name);
  if (!domain) throw new TypeError(`Unknown domain: ${name}`);
  domain.enabled = Boolean(enabled);
  return next;
}

function updateDomain(config, domainName, updates) {
  const previousName = normalizeDomainName(domainName);
  const requestedName = updates.name === undefined ? previousName : normalizeDomainName(updates.name);
  const next = requestedName === previousName
    ? structuredClone(config)
    : renameDomainTree(config, previousName, requestedName);
  const index = next.domains.findIndex((domain) => normalizeName(domain.name) === requestedName);
  if (index === -1) throw new TypeError(`Unknown domain: ${previousName}`);
  next.domains[index] = normalizeDomain({ ...next.domains[index], ...updates, name: requestedName }, index);
  return next;
}

function rewriteSuffix(value, previousName, nextName) {
  if (typeof value !== "string") return value;
  const normalized = normalizeName(value);
  if (!belongsTo(normalized, previousName)) return value;
  if (normalized === previousName) return nextName;
  return `${normalized.slice(0, -(previousName.length + 1))}.${nextName}`;
}

function domainTreeNames(domains, root) {
  return new Set(domains.filter((domain) => belongsTo(domain.name, root)).map((domain) => domain.name));
}

function assertUniqueProxyNames(routes) {
  const names = new Set();
  for (const route of routes) {
    for (const value of [route.host, ...(route.aliases || [])]) {
      const name = normalizeName(value);
      if (names.has(name)) throw new TypeError(`Proxy host conflict: ${name}`);
      names.add(name);
    }
  }
}

function renameDomainTree(config, domainName, replacementName) {
  const previousName = normalizeDomainName(domainName);
  const nextName = normalizeDomainName(replacementName);
  const next = structuredClone(config);
  const domains = normalizeDomains(next.domains || []);
  if (!domains.some((domain) => domain.name === previousName)) throw new TypeError(`Unknown domain: ${previousName}`);
  const tree = domainTreeNames(domains, previousName);
  const replacements = new Set([...tree].map((name) => rewriteSuffix(name, previousName, nextName)));
  if (domains.some((domain) => !tree.has(domain.name) && replacements.has(domain.name))) {
    throw new TypeError(`Domain rename conflict: ${nextName}`);
  }

  next.domains = domains.map((domain) => ({
    ...domain,
    name: tree.has(domain.name) ? rewriteSuffix(domain.name, previousName, nextName) : domain.name,
  }));
  next.records = (next.records || []).map((record) => {
    const updated = { ...record, name: rewriteSuffix(record.name, previousName, nextName) };
    if (["CNAME", "NS"].includes(record.type)) updated.value = rewriteSuffix(record.value, previousName, nextName);
    if (record.type === "MX") updated.exchange = rewriteSuffix(record.exchange, previousName, nextName);
    if (record.type === "SRV") updated.target = rewriteSuffix(record.target, previousName, nextName);
    return updated;
  });
  next.routes = (next.routes || []).map((route) => ({
    ...route,
    host: rewriteSuffix(route.host, previousName, nextName),
    aliases: route.aliases?.map((alias) => rewriteSuffix(alias, previousName, nextName)),
    dnsName: rewriteSuffix(route.dnsName, previousName, nextName),
  }));
  assertUniqueProxyNames(next.routes);
  return next;
}

function deleteDomainTree(config, domainName) {
  const root = normalizeDomainName(domainName);
  const next = structuredClone(config);
  const domains = normalizeDomains(next.domains || []);
  if (!domains.some((domain) => domain.name === root)) throw new TypeError(`Unknown domain: ${root}`);
  next.domains = domains.filter((domain) => !belongsTo(domain.name, root));
  next.records = (next.records || []).filter((record) => !belongsTo(record.name, root));
  next.routes = (next.routes || []).filter((route) => !belongsTo(route.host, root));
  return next;
}

function createDomainPlan(config, input) {
  const domain = normalizeDomain(input);
  const next = structuredClone(config);
  const domains = normalizeDomains(next.domains || []);
  if (domains.some((candidate) => candidate.name === domain.name)) throw new TypeError(`Duplicate domain: ${domain.name}`);

  const records = [];
  const routes = [];
  const website = input.website;
  if (website) {
    if (website.ipv4) records.push({ name: domain.name, type: "A", value: website.ipv4, ttl: domain.defaultTtl, enabled: true });
    if (website.ipv6) records.push({ name: domain.name, type: "AAAA", value: website.ipv6, ttl: domain.defaultTtl, enabled: true });
    if (website.createWww) records.push({ name: `www.${domain.name}`, type: "CNAME", value: domain.name, ttl: domain.defaultTtl, enabled: true });
    if (website.upstreamUrl) {
      const target = new URL(website.upstreamUrl);
      if (!["http:", "https:"].includes(target.protocol)) throw new TypeError("Website upstream must use HTTP or HTTPS");
      routes.push({
        host: domain.name,
        aliases: website.createWww ? [`www.${domain.name}`] : [],
        target: target.href.replace(/\/$/, ""),
        enabled: true,
      });
    }
  }
  new RecordStore(records);
  const storedDomain = { ...domain };
  delete storedDomain.website;
  next.domains = [...domains, storedDomain];
  next.records = [...(next.records || []), ...records];
  next.routes = [...(next.routes || []), ...routes];
  assertUniqueProxyNames(next.routes);
  return { config: next, additions: { domain: storedDomain, records, routes } };
}

module.exports = {
  applyDomainState,
  belongsTo,
  classifyDomain,
  createDomainPlan,
  deleteDomainTree,
  normalizeDomain,
  normalizeDomainName,
  normalizeDomains,
  qualifyDomainName,
  renameDomainTree,
  rewriteSuffix,
  setDomainEnabled,
  updateDomain,
};
