"use strict";

const dgram = require("node:dgram");
const http = require("node:http");

const { createQuery, parseMessage } = require("../dns/message");
const { RecordStore } = require("../dns/records");
const { createResolver } = require("../dns/resolver");
const { ZoneStore } = require("../dns/zones");
const { createDnsService } = require("../services/dns-server");
const { ProxyRoutes } = require("../services/proxy-routes");
const { createProxyService } = require("../services/proxy-server");
const { createBenchmarkConfig } = require("./dataset");
const { runSoakLoad } = require("./load");

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function createDnsBenchmarkClient({ host, port, timeoutMs = 2000 }) {
  const socket = dgram.createSocket("udp4");
  const pending = new Map();
  let nextId = 0;
  let sequence = 0;
  socket.on("message", (wire) => {
    if (wire.length < 2) return;
    const request = pending.get(wire.readUInt16BE(0));
    if (!request) return;
    pending.delete(request.id);
    clearTimeout(request.timer);
    try {
      const response = parseMessage(wire);
      if (response.flags.rcode !== 0 || response.answers.length === 0) throw new Error("DNS benchmark response failed");
      request.resolve();
    } catch (error) {
      request.reject(error);
    }
  });
  socket.on("error", (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });
  function allocateId() {
    for (let attempts = 0; attempts < 0x10000; attempts += 1) {
      const id = nextId++ & 0xffff;
      if (!pending.has(id)) return id;
    }
    throw new Error("DNS benchmark transaction IDs are exhausted");
  }
  return {
    async start() {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(0, "127.0.0.1", resolve);
      });
    },
    query(recordCount) {
      const id = allocateId();
      const name = `r${sequence++ % recordCount}.benchmark.test`;
      const wire = createQuery(name, "A", { id, edns: false });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("DNS benchmark query timed out"));
        }, timeoutMs);
        pending.set(id, { id, timer, resolve, reject });
        socket.send(wire, port, host, (error) => {
          if (!error) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("DNS benchmark client closed"));
      }
      pending.clear();
      return new Promise((resolve) => socket.close(resolve));
    },
  };
}

function createDnsBenchmarkClientPool({ host, port, size, timeoutMs = 2000, createClient = createDnsBenchmarkClient }) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("DNS benchmark client socket count must be a positive integer");
  const clients = Array.from({ length: size }, () => createClient({ host, port, timeoutMs }));
  let nextClient = 0;
  return {
    async start() {
      await Promise.all(clients.map((client) => client.start()));
    },
    query(recordCount) {
      const client = clients[nextClient++ % clients.length];
      return client.query(recordCount);
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

function proxyRequest({ agent, port, site }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      agent,
      host: "127.0.0.1",
      port,
      path: "/benchmark",
      method: "GET",
      headers: { host: `site-${site}.benchmark.test` },
    }, (response) => {
      response.resume();
      response.once("end", () => response.statusCode === 200
        ? resolve()
        : reject(new Error(`Proxy benchmark returned HTTP ${response.statusCode}`)));
    });
    request.once("error", reject);
    request.end();
  });
}

function environment() {
  const header = process.report?.getReport?.().header || {};
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    libc: header.glibcVersionRuntime ? `glibc-${header.glibcVersionRuntime}` : "unknown",
  };
}

async function runTransportBenchmark({
  records,
  proxySites,
  durationMs,
  intervalMs = 1000,
  dnsOperationsPerInterval,
  proxyOperationsPerInterval,
  dnsClientSockets = 8,
  dnsConcurrency = 512,
  proxyConcurrency = 256,
  maintenanceEveryIntervals = 300,
} = {}) {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "2" });
    response.end("ok");
  });
  let dnsService;
  let proxyService;
  let dnsClient;
  const proxyAgent = new http.Agent({ keepAlive: true, maxSockets: proxyConcurrency });
  const startedAt = new Date();
  try {
    const upstreamAddress = await listen(upstream);
    const config = createBenchmarkConfig({
      records,
      proxySites,
      upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    });
    const recordStore = new RecordStore(config.records);
    const zones = new ZoneStore({ domains: config.domains, records: config.records });
    dnsService = createDnsService({
      host: "127.0.0.1",
      port: 0,
      resolver: createResolver({ records: recordStore, zones }),
    });
    const routes = new ProxyRoutes(config.routes, { records: recordStore });
    proxyService = createProxyService({ routes, host: "127.0.0.1", port: 0 });
    await dnsService.start();
    await proxyService.start();
    const dnsAddress = dnsService.address().udp;
    const proxyAddress = proxyService.address();
    dnsClient = createDnsBenchmarkClientPool({
      host: "127.0.0.1",
      port: dnsAddress.port,
      size: dnsClientSockets,
    });
    await dnsClient.start();
    let proxySequence = 0;
    const result = await runSoakLoad({
      durationMs,
      intervalMs,
      dnsRate: dnsOperationsPerInterval,
      proxyRate: proxyOperationsPerInterval,
      dnsConcurrency,
      proxyConcurrency,
      dnsOperation: () => dnsClient.query(records),
      proxyOperation: () => proxyRequest({ agent: proxyAgent, port: proxyAddress.port, site: proxySequence++ % proxySites }),
      maintenanceOperation: ({ tick }) => {
        if (tick % maintenanceEveryIntervals !== 0) return false;
        recordStore.replace(config.records);
        zones.replace({ domains: config.domains, records: config.records });
        routes.replace(config.routes);
        return true;
      },
      checkCore: async () => Boolean(dnsService.address().udp && proxyService.address()),
    });
    return {
      formatVersion: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment: environment(),
      dataset: { records, proxySites },
      dns: {
        requests: result.dns.requests,
        errors: result.dns.errors,
        qps: result.dns.throughput,
        p95Ms: result.dns.p95Ms,
      },
      proxy: {
        requests: result.proxy.requests,
        errors: result.proxy.errors,
        rps: result.proxy.throughput,
        p95Ms: result.proxy.p95Ms,
      },
      soak: { ...result.soak, durationMs: Math.round(result.soak.durationMs) },
    };
  } finally {
    proxyAgent.destroy();
    await dnsClient?.close().catch(() => {});
    await proxyService?.close().catch(() => {});
    await dnsService?.close().catch(() => {});
    await closeServer(upstream).catch(() => {});
  }
}

module.exports = { createDnsBenchmarkClient, createDnsBenchmarkClientPool, environment, runTransportBenchmark };
