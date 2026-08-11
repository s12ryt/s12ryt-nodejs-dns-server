"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const TYPES = Object.freeze({
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  AXFR: 252,
  IXFR: 251,
  ANY: 255,
});

const CLASSES = Object.freeze({ IN: 1 });
const TYPE_NAMES = new Map(Object.entries(TYPES).map(([name, code]) => [code, name]));
const CLASS_NAMES = new Map(Object.entries(CLASSES).map(([name, code]) => [code, name]));

function typeCode(type) {
  if (Number.isInteger(type)) return type;
  const code = TYPES[String(type).toUpperCase()];
  if (!code) throw new TypeError(`Unsupported DNS record type: ${type}`);
  return code;
}

function classCode(recordClass = "IN") {
  if (Number.isInteger(recordClass)) return recordClass;
  const code = CLASSES[String(recordClass).toUpperCase()];
  if (!code) throw new TypeError(`Unsupported DNS record class: ${recordClass}`);
  return code;
}

function normalizeName(name) {
  if (name === ".") return "";
  return String(name).replace(/\.$/, "").toLowerCase();
}

function encodeName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return Buffer.from([0]);

  const labels = normalized.split(".");
  const chunks = [];
  let length = 1;
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length === 0 || bytes.length > 63) {
      throw new RangeError("DNS labels must contain between 1 and 63 bytes");
    }
    length += bytes.length + 1;
    if (length > 255) throw new RangeError("DNS name exceeds 255 bytes");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeName(buffer, startOffset, visited = new Set()) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("DNS message must be a Buffer");
  if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset >= buffer.length) {
    throw new RangeError("DNS name offset is outside the message");
  }

  const labels = [];
  let offset = startOffset;
  let nextOffset = null;
  while (true) {
    if (offset >= buffer.length) throw new RangeError("Truncated DNS name");
    const length = buffer[offset];

    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new RangeError("Truncated DNS compression pointer");
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      if (pointer >= buffer.length) throw new RangeError("DNS compression pointer is outside the message");
      if (visited.has(pointer)) throw new Error("DNS compression pointer loop detected");
      visited.add(pointer);
      if (nextOffset === null) nextOffset = offset + 2;
      const decoded = decodeName(buffer, pointer, visited);
      if (decoded.name) labels.push(decoded.name);
      break;
    }

    if ((length & 0xc0) !== 0) throw new Error("Invalid DNS label length marker");
    offset += 1;
    if (length === 0) {
      if (nextOffset === null) nextOffset = offset;
      break;
    }
    if (length > 63 || offset + length > buffer.length) throw new RangeError("Truncated DNS label");
    labels.push(buffer.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }

  return { name: labels.join(".").toLowerCase(), nextOffset };
}

function parseFlags(value) {
  return {
    qr: Boolean(value & 0x8000),
    opcode: (value >> 11) & 0x0f,
    aa: Boolean(value & 0x0400),
    tc: Boolean(value & 0x0200),
    rd: Boolean(value & 0x0100),
    ra: Boolean(value & 0x0080),
    ad: Boolean(value & 0x0020),
    cd: Boolean(value & 0x0010),
    rcode: value & 0x000f,
    value,
  };
}

function formatIpv6(data) {
  const groups = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(data.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

function parseRecordData(buffer, type, classValue, ttl, start, length) {
  const end = start + length;
  if (end > buffer.length) throw new RangeError("Truncated DNS record data");

  if (type === TYPES.A && length === 4) return { address: [...buffer.subarray(start, end)].join(".") };
  if (type === TYPES.AAAA && length === 16) return { address: formatIpv6(buffer.subarray(start, end)) };
  if ([TYPES.NS, TYPES.CNAME].includes(type)) return { value: decodeName(buffer, start).name };
  if (type === TYPES.SOA) {
    const mname = decodeName(buffer, start);
    const rname = decodeName(buffer, mname.nextOffset);
    if (rname.nextOffset + 20 > end) throw new RangeError("Truncated SOA record");
    return {
      mname: mname.name,
      rname: rname.name,
      serial: buffer.readUInt32BE(rname.nextOffset),
      refresh: buffer.readUInt32BE(rname.nextOffset + 4),
      retry: buffer.readUInt32BE(rname.nextOffset + 8),
      expire: buffer.readUInt32BE(rname.nextOffset + 12),
      minimum: buffer.readUInt32BE(rname.nextOffset + 16),
    };
  }
  if (type === TYPES.MX) {
    if (length < 3) throw new RangeError("Truncated MX record");
    return { priority: buffer.readUInt16BE(start), exchange: decodeName(buffer, start + 2).name };
  }
  if (type === TYPES.TXT) {
    const values = [];
    let offset = start;
    while (offset < end) {
      const textLength = buffer[offset++];
      if (offset + textLength > end) throw new RangeError("Truncated TXT record");
      values.push(buffer.subarray(offset, offset + textLength));
      offset += textLength;
    }
    return { value: Buffer.concat(values).toString("utf8") };
  }
  if (type === TYPES.SRV) {
    if (length < 7) throw new RangeError("Truncated SRV record");
    return {
      priority: buffer.readUInt16BE(start),
      weight: buffer.readUInt16BE(start + 2),
      port: buffer.readUInt16BE(start + 4),
      target: decodeName(buffer, start + 6).name,
    };
  }
  if (type === TYPES.OPT) {
    return {
      udpPayloadSize: classValue,
      extendedRcode: ttl >>> 24,
      version: (ttl >>> 16) & 0xff,
      dnssecOk: Boolean(ttl & 0x8000),
      data: Buffer.from(buffer.subarray(start, end)),
    };
  }
  return { data: Buffer.from(buffer.subarray(start, end)) };
}

function parseQuestion(buffer, offset) {
  const decoded = decodeName(buffer, offset);
  if (decoded.nextOffset + 4 > buffer.length) throw new RangeError("Truncated DNS question");
  const type = buffer.readUInt16BE(decoded.nextOffset);
  const recordClass = buffer.readUInt16BE(decoded.nextOffset + 2);
  return {
    value: {
      name: decoded.name,
      type: TYPE_NAMES.get(type) || type,
      class: CLASS_NAMES.get(recordClass) || recordClass,
    },
    nextOffset: decoded.nextOffset + 4,
  };
}

function parseRecord(buffer, offset) {
  const decoded = decodeName(buffer, offset);
  if (decoded.nextOffset + 10 > buffer.length) throw new RangeError("Truncated DNS resource record");
  const type = buffer.readUInt16BE(decoded.nextOffset);
  const recordClass = buffer.readUInt16BE(decoded.nextOffset + 2);
  const ttl = buffer.readUInt32BE(decoded.nextOffset + 4);
  const length = buffer.readUInt16BE(decoded.nextOffset + 8);
  const dataOffset = decoded.nextOffset + 10;
  const data = parseRecordData(buffer, type, recordClass, ttl, dataOffset, length);
  const value = {
    name: decoded.name,
    type: TYPE_NAMES.get(type) || type,
    class: type === TYPES.OPT ? recordClass : (CLASS_NAMES.get(recordClass) || recordClass),
    ttl,
    ...data,
  };
  return { value, nextOffset: dataOffset + length };
}

function parseMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new RangeError("DNS message is shorter than its header");
  const counts = [
    buffer.readUInt16BE(4),
    buffer.readUInt16BE(6),
    buffer.readUInt16BE(8),
    buffer.readUInt16BE(10),
  ];
  let offset = 12;
  const sections = [[], [], [], []];
  for (let section = 0; section < sections.length; section += 1) {
    for (let index = 0; index < counts[section]; index += 1) {
      const parsed = section === 0 ? parseQuestion(buffer, offset) : parseRecord(buffer, offset);
      sections[section].push(parsed.value);
      offset = parsed.nextOffset;
    }
  }
  return {
    id: buffer.readUInt16BE(0),
    flags: parseFlags(buffer.readUInt16BE(2)),
    questions: sections[0],
    answers: sections[1],
    authorities: sections[2],
    additionals: sections[3],
    trailingData: Buffer.from(buffer.subarray(offset)),
  };
}

function createQuery(name, type = "A", options = {}) {
  const includeOpt = options.edns !== false;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(options.id ?? crypto.randomInt(0, 0x10000), 0);
  header.writeUInt16BE(options.recursionDesired === false ? 0 : 0x0100, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(includeOpt ? 1 : 0, 10);

  const questionTail = Buffer.alloc(4);
  questionTail.writeUInt16BE(typeCode(type), 0);
  questionTail.writeUInt16BE(classCode(options.class), 2);
  const chunks = [header, encodeName(name), questionTail];

  if (includeOpt) {
    const opt = Buffer.alloc(11);
    opt.writeUInt16BE(TYPES.OPT, 1);
    opt.writeUInt16BE(options.udpPayloadSize ?? 1232, 3);
    opt.writeUInt32BE(options.dnssecOk ? 0x00008000 : 0, 5);
    chunks.push(opt);
  }
  return Buffer.concat(chunks);
}

function encodeIpv6(address) {
  validateAddress(TYPES.AAAA, address);
  let input = address.toLowerCase();
  const ipv4Index = input.lastIndexOf(":");
  if (input.includes(".") && ipv4Index !== -1) {
    const octets = input.slice(ipv4Index + 1).split(".").map(Number);
    input = `${input.slice(0, ipv4Index)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) throw new TypeError("Invalid IPv6 address");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) throw new TypeError("Invalid IPv6 address");
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  const result = Buffer.alloc(16);
  groups.forEach((group, index) => result.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2));
  return result;
}

function encodeTxt(value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length === 0) return Buffer.from([0]);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const part = bytes.subarray(offset, offset + 255);
    chunks.push(Buffer.from([part.length]), part);
  }
  return Buffer.concat(chunks);
}

function encodeRecordData(record, type) {
  if (type === TYPES.A) {
    validateAddress(type, record.value);
    return Buffer.from(record.value.split(".").map(Number));
  }
  if (type === TYPES.AAAA) return encodeIpv6(record.value);
  if ([TYPES.NS, TYPES.CNAME].includes(type)) return encodeName(record.value);
  if (type === TYPES.SOA) {
    const values = [record.serial, record.refresh, record.retry, record.expire, record.minimum];
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
      throw new RangeError("SOA numeric fields must be unsigned 32-bit integers");
    }
    const numbers = Buffer.alloc(20);
    values.forEach((value, index) => numbers.writeUInt32BE(value, index * 4));
    return Buffer.concat([encodeName(record.mname), encodeName(record.rname), numbers]);
  }
  if (type === TYPES.TXT) return encodeTxt(record.value);
  if (type === TYPES.MX) {
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(record.priority ?? 0);
    return Buffer.concat([prefix, encodeName(record.exchange)]);
  }
  if (type === TYPES.SRV) {
    const prefix = Buffer.alloc(6);
    prefix.writeUInt16BE(record.priority ?? 0, 0);
    prefix.writeUInt16BE(record.weight ?? 0, 2);
    prefix.writeUInt16BE(record.port, 4);
    return Buffer.concat([prefix, encodeName(record.target)]);
  }
  if (Buffer.isBuffer(record.data)) return record.data;
  throw new TypeError(`Cannot encode DNS record type: ${record.type}`);
}

function encodeQuestion(question) {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(typeCode(question.type), 0);
  tail.writeUInt16BE(classCode(question.class), 2);
  return Buffer.concat([encodeName(question.name), tail]);
}

function encodeRecord(record) {
  const type = typeCode(record.type);
  const data = encodeRecordData(record, type);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(classCode(record.class), 2);
  fixed.writeUInt32BE(Math.max(0, record.ttl ?? 300), 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(record.name), fixed, data]);
}

function responseCode(value) {
  if (Number.isInteger(value)) return value & 0x0f;
  const codes = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
  const code = codes[String(value || "NOERROR").toUpperCase()];
  if (code === undefined) throw new TypeError(`Unsupported DNS response code: ${value}`);
  return code;
}

function buildResponse(queryWire, answers = [], options = {}) {
  const query = parseMessage(queryWire);
  const questions = query.questions.map(encodeQuestion);
  const encodedAnswers = answers.map(encodeRecord);
  const authorities = (options.authorities || []).map(encodeRecord);
  const additionals = (options.additionals || []).map(encodeRecord);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  let flags = 0x8000 | (query.flags.opcode << 11) | responseCode(options.rcode);
  if (query.flags.rd) flags |= 0x0100;
  if (options.authoritative) flags |= 0x0400;
  if (options.recursionAvailable !== false) flags |= 0x0080;
  if (options.authenticatedData) flags |= 0x0020;
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(encodedAnswers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([header, ...questions, ...encodedAnswers, ...authorities, ...additionals]);
}

function minimumAnswerTtl(wire) {
  const answers = parseMessage(wire).answers;
  if (answers.length === 0) return 0;
  return Math.min(...answers.map((answer) => answer.ttl));
}

function validateAddress(type, address) {
  const family = net.isIP(address);
  if ((type === TYPES.A && family !== 4) || (type === TYPES.AAAA && family !== 6)) {
    throw new TypeError(`Invalid address for ${TYPE_NAMES.get(type)} record`);
  }
}

module.exports = {
  CLASSES,
  TYPES,
  buildResponse,
  classCode,
  createQuery,
  decodeName,
  encodeName,
  minimumAnswerTtl,
  normalizeName,
  parseMessage,
  typeCode,
  validateAddress,
};
