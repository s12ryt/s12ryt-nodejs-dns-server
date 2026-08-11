"use strict";

const crypto = require("node:crypto");

const { nextSoaSerial, normalizeDomainName, normalizeDomains } = require("../admin/domains");
const { normalizeName } = require("./message");
const { normalizeRecord, RecordStore } = require("./records");

const RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"]);
const CLASS = "IN";

function belongsTo(name, zone) {
  return name === zone || name.endsWith(`.${zone}`);
}

function logicalStatements(source) {
  const statements = [];
  let text = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let comment = false;
  let leadingWhitespace = false;
  let statementStarted = false;

  for (let index = 0; index <= source.length; index += 1) {
    const character = index === source.length ? "\n" : source[index];
    if (comment) {
      if (character !== "\n") continue;
      comment = false;
    }
    if (escaped) {
      text += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      text += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      text += character;
      statementStarted = true;
      continue;
    }
    if (!quoted && character === ";") {
      comment = true;
      continue;
    }
    if (!quoted && character === "(") {
      depth += 1;
      text += " ";
      continue;
    }
    if (!quoted && character === ")") {
      depth -= 1;
      if (depth < 0) throw new TypeError("Zone file has an unmatched closing parenthesis");
      text += " ";
      continue;
    }
    if (character === "\n") {
      if (depth === 0) {
        if (text.trim()) statements.push({ text: text.trim(), ownerOmitted: leadingWhitespace });
        text = "";
        leadingWhitespace = false;
        statementStarted = false;
      } else {
        text += " ";
      }
      continue;
    }
    if (!statementStarted) {
      if (/\s/.test(character)) leadingWhitespace = true;
      else statementStarted = true;
    }
    text += character;
  }
  if (quoted) throw new TypeError("Zone file has an unterminated quoted string");
  if (depth !== 0) throw new TypeError("Zone file has unmatched parentheses");
  return statements;
}

function tokenize(text) {
  const tokens = [];
  let value = "";
  let quoted = false;
  let escaped = false;
  let active = false;
  for (const character of text) {
    if (escaped) {
      value += character;
      escaped = false;
      active = true;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
      active = true;
    } else if (!quoted && /\s/.test(character)) {
      if (active) tokens.push(value);
      value = "";
      active = false;
    } else {
      value += character;
      active = true;
    }
  }
  if (quoted || escaped) throw new TypeError("Zone record has an invalid quoted value");
  if (active) tokens.push(value);
  return tokens;
}

function dnsName(value, origin, zone, label) {
  if (!value) throw new TypeError(`${label} is required`);
  const name = value === "@"
    ? origin
    : normalizeName(value.endsWith(".") ? value : `${value}.${origin}`);
  if (!belongsTo(name, zone)) throw new TypeError(`${label} is outside the target zone`);
  return name;
}

function targetName(value, origin, label) {
  if (!value) throw new TypeError(`${label} is required`);
  return value === "@" ? origin : normalizeName(value.endsWith(".") ? value : `${value}.${origin}`);
}

function integer(value, label, { min = 0, max = 0xffffffff } = {}) {
  if (!/^\d+$/.test(String(value || ""))) throw new TypeError(`${label} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError(`${label} is outside its range`);
  return result;
}

function recordData(type, values, context) {
  const { owner, ttl, origin } = context;
  if (type === "A" || type === "AAAA") {
    if (values.length !== 1) throw new TypeError(`${type} record requires one address`);
    return { name: owner, type, ttl, value: values[0], enabled: true };
  }
  if (type === "CNAME" || type === "NS") {
    if (values.length !== 1) throw new TypeError(`${type} record requires one target`);
    return { name: owner, type, ttl, value: targetName(values[0], origin, `${type} target`), enabled: true };
  }
  if (type === "MX") {
    if (values.length !== 2) throw new TypeError("MX record requires priority and exchange");
    return {
      name: owner,
      type,
      ttl,
      priority: integer(values[0], "MX priority", { max: 65535 }),
      exchange: targetName(values[1], origin, "MX exchange"),
      enabled: true,
    };
  }
  if (type === "TXT") {
    if (values.length === 0) throw new TypeError("TXT record requires a value");
    return { name: owner, type, ttl, value: values.join(" "), enabled: true };
  }
  if (type === "SRV") {
    if (values.length !== 4) throw new TypeError("SRV record requires priority, weight, port and target");
    return {
      name: owner,
      type,
      ttl,
      priority: integer(values[0], "SRV priority", { max: 65535 }),
      weight: integer(values[1], "SRV weight", { max: 65535 }),
      port: integer(values[2], "SRV port", { min: 1, max: 65535 }),
      target: targetName(values[3], origin, "SRV target"),
      enabled: true,
    };
  }
  throw new TypeError(`Unsupported zone record type: ${type}`);
}

function canonicalRecords(records) {
  return [...records].sort((left, right) => {
    const leftKey = `${left.name}\0${left.type}\0${JSON.stringify(left)}`;
    const rightKey = `${right.name}\0${right.type}\0${JSON.stringify(right)}`;
    return leftKey.localeCompare(rightKey);
  });
}

function parseZoneFile(source, { origin } = {}) {
  if (typeof source !== "string") throw new TypeError("Zone file must be text");
  const targetZone = normalizeDomainName(origin);
  let currentOrigin = targetZone;
  let defaultTtl = 300;
  let previousOwner = null;
  let soa = null;
  const records = [];

  for (const statement of logicalStatements(source)) {
    const tokens = tokenize(statement.text);
    if (tokens[0]?.startsWith("$")) {
      const directive = tokens[0].toUpperCase();
      if (directive === "$ORIGIN" && tokens.length === 2) {
        currentOrigin = dnsName(tokens[1], targetZone, targetZone, "Origin");
      } else if (directive === "$TTL" && tokens.length === 2) {
        defaultTtl = integer(tokens[1], "Default TTL", { max: 0x7fffffff });
      } else {
        throw new TypeError(`Unsupported zone directive: ${tokens[0]}`);
      }
      continue;
    }

    let offset = 0;
    const owner = statement.ownerOmitted
      ? previousOwner
      : dnsName(tokens[offset++], currentOrigin, targetZone, "Record owner");
    if (!owner) throw new TypeError("An omitted record owner requires a previous owner");
    previousOwner = owner;
    let ttl = defaultTtl;
    let recordClass = CLASS;
    while (offset < tokens.length) {
      const token = tokens[offset].toUpperCase();
      if (/^\d+$/.test(token)) ttl = integer(tokens[offset++], "Record TTL", { max: 0x7fffffff });
      else if (token === CLASS) recordClass = tokens[offset++].toUpperCase();
      else break;
    }
    if (recordClass !== CLASS) throw new TypeError(`Unsupported DNS class: ${recordClass}`);
    const type = tokens[offset++]?.toUpperCase();
    if (type === "SOA") {
      const values = tokens.slice(offset);
      if (values.length !== 7) throw new TypeError("SOA record requires two names and five numeric fields");
      if (owner !== targetZone) throw new TypeError("SOA record must be at the zone apex");
      if (soa) throw new TypeError("Zone file contains duplicate SOA records");
      soa = {
        mname: targetName(values[0], currentOrigin, "SOA primary nameserver"),
        rname: targetName(values[1], currentOrigin, "SOA responsible mailbox"),
        serial: integer(values[2], "SOA serial"),
        refresh: integer(values[3], "SOA refresh"),
        retry: integer(values[4], "SOA retry"),
        expire: integer(values[5], "SOA expire"),
        minimum: integer(values[6], "SOA minimum"),
      };
    } else {
      if (!RECORD_TYPES.has(type)) throw new TypeError(`Unsupported zone record type: ${type || "missing"}`);
      records.push(recordData(type, tokens.slice(offset), { owner, ttl, origin: currentOrigin }));
    }
  }
  new RecordStore(records);
  return { origin: targetZone, defaultTtl, soa, records: canonicalRecords(records) };
}

function relativeName(name, origin) {
  if (name === origin) return "@";
  return name.slice(0, -(origin.length + 1));
}

function absoluteName(name) {
  return `${normalizeName(name)}.`;
}

function escapedText(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function exportRecord(record, origin) {
  const prefix = `${relativeName(record.name, origin)} ${record.ttl} IN ${record.type}`;
  if (record.type === "A" || record.type === "AAAA") return `${prefix} ${record.value}`;
  if (record.type === "CNAME" || record.type === "NS") return `${prefix} ${absoluteName(record.value)}`;
  if (record.type === "MX") return `${prefix} ${record.priority} ${absoluteName(record.exchange)}`;
  if (record.type === "TXT") return `${prefix} ${escapedText(record.value)}`;
  if (record.type === "SRV") {
    return `${prefix} ${record.priority ?? 0} ${record.weight ?? 0} ${record.port} ${absoluteName(record.target)}`;
  }
  throw new TypeError(`Unsupported zone record type: ${record.type}`);
}

function exportZoneFile({ domain, records }) {
  const [zone] = normalizeDomains([domain]);
  const direct = canonicalRecords(records.filter((record) => belongsTo(normalizeName(record.name), zone.name)));
  const soa = zone.soa;
  const lines = [
    `$ORIGIN ${absoluteName(zone.name)}`,
    `$TTL ${zone.defaultTtl}`,
    `@ ${zone.defaultTtl} IN SOA ${absoluteName(soa.mname)} ${absoluteName(soa.rname)} (`,
    `  ${soa.serial}`,
    `  ${soa.refresh}`,
    `  ${soa.retry}`,
    `  ${soa.expire}`,
    `  ${soa.minimum}`,
    ")",
    ...direct.map((record) => exportRecord(record, zone.name)),
    "",
  ];
  return lines.join("\n");
}

function recordIdentity(record) {
  const value = { ...record };
  delete value.id;
  delete value.enabled;
  return JSON.stringify(value, Object.keys(value).sort());
}

function classify(domains, name) {
  const normalized = normalizeName(name);
  return domains.filter((domain) => belongsTo(normalized, domain.name))
    .sort((left, right) => right.name.length - left.name.length)[0] || null;
}

function assertCnameCompatibility(records) {
  const owners = new Map();
  for (const record of records) {
    const values = owners.get(record.name) || [];
    values.push(record);
    owners.set(record.name, values);
  }
  for (const values of owners.values()) {
    const cnames = values.filter((record) => record.type === "CNAME");
    if (cnames.length > 0 && values.length > 1) throw new TypeError("CNAME records cannot coexist with other data");
  }
}

function planZoneImport(config, domainName, parsed, {
  mode,
  uuid = crypto.randomUUID,
  now = new Date(),
} = {}) {
  if (!new Set(["merge", "replace"]).has(mode)) throw new TypeError("Zone import mode must be merge or replace");
  const result = structuredClone(config);
  const domains = normalizeDomains(result.domains || [], { now });
  const zoneName = normalizeDomainName(domainName);
  const domain = domains.find((candidate) => candidate.name === zoneName);
  if (!domain) throw new TypeError(`Unknown zone: ${zoneName}`);
  if (parsed.origin !== zoneName) throw new TypeError("Imported origin does not match the target zone");
  for (const record of parsed.records) {
    if (classify(domains, record.name)?.name !== zoneName) {
      throw new TypeError(`Imported record is outside the direct target zone: ${record.name}`);
    }
  }

  const direct = (result.records || []).filter((record) => classify(domains, record.name)?.name === zoneName);
  const untouched = (result.records || []).filter((record) => classify(domains, record.name)?.name !== zoneName);
  let imported;
  let summary;
  if (mode === "replace") {
    imported = parsed.records.map((record) => ({ ...record, id: uuid() }));
    summary = { added: imported.length, removed: direct.length, skipped: 0 };
  } else {
    const identities = new Set(direct.map(recordIdentity));
    const additions = parsed.records.filter((record) => !identities.has(recordIdentity(record)))
      .map((record) => ({ ...record, id: uuid() }));
    imported = [...direct, ...additions];
    summary = { added: additions.length, removed: 0, skipped: parsed.records.length - additions.length };
  }
  assertCnameCompatibility(imported);
  new RecordStore(imported);
  result.records = [...untouched, ...imported];
  result.domains = domains;
  const target = result.domains.find((candidate) => candidate.name === zoneName);
  if (parsed.soa) {
    target.soa = { ...parsed.soa, serial: Math.max(parsed.soa.serial, nextSoaSerial(domain.soa.serial, now)) };
  } else {
    target.soa.serial = nextSoaSerial(domain.soa.serial, now);
  }
  return { config: result, summary };
}

function planZoneRecordBatch(config, domainName, batch, { uuid = crypto.randomUUID, now = new Date() } = {}) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    throw new TypeError("Zone record batch must be an object");
  }
  const create = batch.create ?? [];
  const update = batch.update ?? [];
  const remove = batch.delete ?? [];
  if (![create, update, remove].every(Array.isArray)) {
    throw new TypeError("Zone record batch fields must be arrays");
  }
  const result = structuredClone(config);
  const domains = normalizeDomains(result.domains || [], { now });
  const zoneName = normalizeDomainName(domainName);
  if (!domains.some((domain) => domain.name === zoneName)) throw new TypeError(`Unknown zone: ${zoneName}`);

  const directRecords = (result.records || []).filter((record) => classify(domains, record.name)?.name === zoneName);
  const directById = new Map(directRecords.map((record) => [record.id, record]));
  const touched = new Set();
  const updateById = new Map();
  for (const [index, item] of update.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string"
      || !item.record || typeof item.record !== "object" || Array.isArray(item.record)) {
      throw new TypeError(`Zone record update ${index} is invalid`);
    }
    if (!directById.has(item.id)) throw new TypeError(`Unknown direct zone record id: ${item.id}`);
    if (touched.has(item.id)) throw new TypeError(`Zone record id is repeated: ${item.id}`);
    touched.add(item.id);
    const record = normalizeRecord({ ...item.record, id: item.id }, index);
    if (classify(domains, record.name)?.name !== zoneName) {
      throw new TypeError(`Updated record is outside the direct target zone: ${record.name}`);
    }
    updateById.set(item.id, record);
  }
  const deleteIds = new Set();
  for (const id of remove) {
    if (typeof id !== "string" || !directById.has(id)) throw new TypeError(`Unknown direct zone record id: ${id}`);
    if (touched.has(id)) throw new TypeError(`Zone record id is repeated: ${id}`);
    touched.add(id);
    deleteIds.add(id);
  }
  const created = create.map((record, index) => {
    const normalized = normalizeRecord({ ...record, id: uuid() }, index);
    if (classify(domains, normalized.name)?.name !== zoneName) {
      throw new TypeError(`Created record is outside the direct target zone: ${normalized.name}`);
    }
    return normalized;
  });

  const nextDirect = directRecords
    .filter((record) => !deleteIds.has(record.id))
    .map((record) => updateById.get(record.id) || record)
    .concat(created);
  assertCnameCompatibility(nextDirect);
  const untouched = (result.records || []).filter((record) => classify(domains, record.name)?.name !== zoneName);
  result.records = [...untouched, ...nextDirect];
  new RecordStore(result.records);
  return {
    config: result,
    summary: { created: created.length, updated: updateById.size, deleted: deleteIds.size },
  };
}

module.exports = {
  exportZoneFile,
  parseZoneFile,
  planZoneImport,
  planZoneRecordBatch,
};
