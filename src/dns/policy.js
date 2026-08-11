"use strict";

const net = require("node:net");

const { normalizeName, TYPES } = require("./message");
const { isIpInCidrs, normalizeCidrs } = require("../services/proxy-security");

const NAME_MATCH_KINDS = new Set(["exact", "suffix", "wildcard"]);
const ACTION_TYPES = new Set(["NXDOMAIN", "REFUSED", "A", "AAAA", "CNAME"]);
const WEEKDAYS = Object.freeze(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

function normalizeDomain(value, label = "domain") {
  const name = normalizeName(value);
  if (!name || name.length > 253) throw new TypeError(`${label} must be a valid domain`);
  for (const part of name.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)) {
      throw new TypeError(`${label} must be a valid domain`);
    }
  }
  return name;
}

function normalizeClock(value, label) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new TypeError(`${label} must use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new TypeError(`${label} must use HH:MM`);
  return { text: `${match[1]}:${match[2]}`, minutes: hour * 60 + minute };
}

function normalizeSchedule(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Policy schedule must be an object");
  const timezone = value.timezone === undefined || value.timezone === ""
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : String(value.timezone);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new TypeError(`Invalid IANA time zone: ${timezone}`);
  }
  const weekdays = value.weekdays === undefined ? [...WEEKDAYS] : value.weekdays.map((day) => String(day).toLowerCase());
  if (!Array.isArray(value.weekdays ?? []) || weekdays.length === 0 || weekdays.some((day) => !WEEKDAYS.includes(day))) {
    throw new TypeError("Policy weekdays are invalid");
  }
  const start = normalizeClock(value.start ?? "00:00", "Policy schedule start");
  const end = normalizeClock(value.end ?? "00:00", "Policy schedule end");
  return { timezone, weekdays: [...new Set(weekdays)], start: start.text, end: end.text, startMinutes: start.minutes, endMinutes: end.minutes };
}

function normalizeNameMatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Policy name matcher is required");
  const kind = String(value.kind || "").toLowerCase();
  if (!NAME_MATCH_KINDS.has(kind)) throw new TypeError(`Unsupported policy name matcher: ${value.kind}`);
  let source = String(value.value || "").trim();
  if (kind === "wildcard") {
    if (!source.startsWith("*.")) throw new TypeError("Wildcard policy names must start with *.");
    source = source.slice(2);
  }
  const domain = normalizeDomain(source, "Policy name");
  return { kind, value: kind === "wildcard" ? `*.${domain}` : domain, domain };
}

function normalizeAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Policy action is required");
  const type = String(value.type || "").toUpperCase();
  if (!ACTION_TYPES.has(type)) throw new TypeError(`Unsupported policy action: ${value.type}`);
  if (type === "NXDOMAIN" || type === "REFUSED") return { type };
  const ttl = value.ttl === undefined ? 60 : Number(value.ttl);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff) throw new TypeError("Policy action TTL is invalid");
  if (type === "A" && net.isIP(value.value) !== 4) throw new TypeError("Policy A action requires an IPv4 address");
  if (type === "AAAA" && net.isIP(value.value) !== 6) throw new TypeError("Policy AAAA action requires an IPv6 address");
  const target = type === "CNAME" ? normalizeDomain(value.value, "Policy CNAME target") : String(value.value);
  return { type, value: target, ttl };
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new TypeError("Policy rule must be an object");
  const id = String(rule.id || "").trim();
  if (!id) throw new TypeError("Policy rule id is required");
  const priority = Number(rule.priority);
  if (!Number.isInteger(priority)) throw new TypeError("Policy priority must be an integer");
  const match = rule.match;
  if (!match || typeof match !== "object" || Array.isArray(match)) throw new TypeError("Policy match is required");
  const qtypes = match.qtypes === undefined
    ? []
    : [...new Set(match.qtypes.map((type) => String(type).toUpperCase()))];
  if (!Array.isArray(match.qtypes ?? []) || qtypes.some((type) => !TYPES[type] || ["OPT", "AXFR", "IXFR", "ANY"].includes(type))) {
    throw new TypeError("Policy qtypes are invalid");
  }
  return {
    id,
    enabled: rule.enabled !== false,
    priority,
    index,
    source: String(rule.source || "local"),
    match: {
      name: normalizeNameMatch(match.name),
      qtypes,
      clientCidrs: normalizeCidrs(match.clientCidrs ?? [], "Policy client CIDRs"),
      schedule: normalizeSchedule(match.schedule),
    },
    action: normalizeAction(rule.action),
  };
}

function nameMatches(matcher, name) {
  if (matcher.kind === "exact") return name === matcher.domain;
  if (matcher.kind === "suffix") return name === matcher.domain || name.endsWith(`.${matcher.domain}`);
  return name.endsWith(`.${matcher.domain}`) && name !== matcher.domain;
}

function zonedTime(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday.toLowerCase().slice(0, 3),
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function previousWeekday(day) {
  const index = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(index + 6) % 7];
}

function scheduleMatches(schedule, now) {
  if (!schedule) return true;
  const local = zonedTime(now, schedule.timezone);
  if (schedule.startMinutes === schedule.endMinutes) return schedule.weekdays.includes(local.weekday);
  if (schedule.startMinutes < schedule.endMinutes) {
    return schedule.weekdays.includes(local.weekday)
      && local.minutes >= schedule.startMinutes
      && local.minutes < schedule.endMinutes;
  }
  if (local.minutes >= schedule.startMinutes) return schedule.weekdays.includes(local.weekday);
  return local.minutes < schedule.endMinutes && schedule.weekdays.includes(previousWeekday(local.weekday));
}

function ruleMatches(rule, request) {
  const name = normalizeName(request.name);
  const type = String(request.type || "").toUpperCase();
  if (!nameMatches(rule.match.name, name)) return false;
  if (rule.match.qtypes.length && !rule.match.qtypes.includes(type)) return false;
  if (rule.action.type === "A" && type !== "A") return false;
  if (rule.action.type === "AAAA" && type !== "AAAA") return false;
  if (rule.match.clientCidrs.length && !isIpInCidrs(request.clientIp, rule.match.clientCidrs)) return false;
  const now = request.now instanceof Date ? request.now : new Date(request.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new TypeError("Policy request time is invalid");
  return scheduleMatches(rule.match.schedule, now);
}

function parseHostsList(source) {
  const names = new Set();
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.replace(/\s*[#;].*$/, "").trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const candidates = net.isIP(fields[0]) ? fields.slice(1) : fields;
    if (candidates.length === 0) throw new TypeError("Hosts entry must contain a domain");
    for (const candidate of candidates) names.add(normalizeDomain(candidate, "Hosts domain"));
  }
  return [...names].sort();
}

class PolicyStore {
  constructor({ rules = [] } = {}) {
    this.replace(rules);
  }

  replace(rules = []) {
    if (!Array.isArray(rules)) throw new TypeError("Policy rules must be an array");
    const normalized = rules.map(normalizeRule);
    const ids = new Set();
    for (const rule of normalized) {
      if (ids.has(rule.id)) throw new TypeError(`Duplicate policy rule id: ${rule.id}`);
      ids.add(rule.id);
    }
    this.rules = normalized.filter((rule) => rule.enabled).sort((left, right) => left.priority - right.priority || left.index - right.index);
  }

  evaluate(request) {
    for (const rule of this.rules) {
      if (ruleMatches(rule, request)) return { ruleId: rule.id, source: rule.source, action: { ...rule.action } };
    }
    return null;
  }

  toJSON() {
    return this.rules.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      priority: rule.priority,
      ...(rule.source === "local" ? {} : { source: rule.source }),
      match: {
        name: { kind: rule.match.name.kind, value: rule.match.name.value },
        ...(rule.match.qtypes.length ? { qtypes: [...rule.match.qtypes] } : {}),
        ...(rule.match.clientCidrs.length ? { clientCidrs: [...rule.match.clientCidrs] } : {}),
        ...(rule.match.schedule ? {
          schedule: {
            timezone: rule.match.schedule.timezone,
            weekdays: [...rule.match.schedule.weekdays],
            start: rule.match.schedule.start,
            end: rule.match.schedule.end,
          },
        } : {}),
      },
      action: { ...rule.action },
    }));
  }
}

module.exports = {
  PolicyStore,
  normalizeAction,
  normalizeRule,
  parseHostsList,
  ruleMatches,
  scheduleMatches,
};
