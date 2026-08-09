"use strict";

const dgram = require("node:dgram");
const net = require("node:net");

const MAX_DNS_MESSAGE = 65535;

function createDnsService({ resolver, host = "0.0.0.0", port = 5354 } = {}) {
  if (!resolver || typeof resolver.resolve !== "function") throw new TypeError("resolver must provide resolve(wire)");
  let udp;
  let tcp;

  async function answer(wire) {
    if (!wire.length || wire.length > MAX_DNS_MESSAGE) return null;
    try {
      return await resolver.resolve(wire);
    } catch {
      return null;
    }
  }

  return {
    async start() {
      if (udp || tcp) throw new Error("DNS service is already started");
      udp = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
      udp.on("message", async (wire, remote) => {
        const response = await answer(wire);
        if (response) udp.send(response, remote.port, remote.address);
      });
      await new Promise((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(port, host, resolve);
      });

      const boundPort = udp.address().port;
      tcp = net.createServer((socket) => {
        let pending = Buffer.alloc(0);
        socket.on("data", async (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 2) {
            const length = pending.readUInt16BE(0);
            if (length === 0 || length > MAX_DNS_MESSAGE) return socket.destroy();
            if (pending.length < length + 2) return;
            const wire = pending.subarray(2, length + 2);
            pending = pending.subarray(length + 2);
            const response = await answer(wire);
            if (response && !socket.destroyed) {
              const prefix = Buffer.alloc(2);
              prefix.writeUInt16BE(response.length);
              socket.write(Buffer.concat([prefix, response]));
            }
          }
        });
        socket.on("error", () => {});
      });
      try {
        await new Promise((resolve, reject) => {
          tcp.once("error", reject);
          tcp.listen(boundPort, host, resolve);
        });
      } catch (error) {
        udp.close();
        udp = undefined;
        tcp = undefined;
        throw error;
      }
    },
    address() {
      return { udp: udp?.address(), tcp: tcp?.address() };
    },
    async close() {
      const closing = [];
      if (udp) closing.push(new Promise((resolve) => udp.close(resolve)));
      if (tcp) closing.push(new Promise((resolve) => tcp.close(resolve)));
      await Promise.all(closing);
      udp = undefined;
      tcp = undefined;
    },
  };
}

module.exports = { MAX_DNS_MESSAGE, createDnsService };
