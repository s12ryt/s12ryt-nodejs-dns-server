"use strict";

function createUpstreamHealthMonitor({
  getUpstreams,
  intervalMs = 300000,
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  if (typeof getUpstreams !== "function") throw new TypeError("getUpstreams must be a function");
  let timer = null;

  async function probeNow() {
    const upstreams = getUpstreams();
    if (!Array.isArray(upstreams)) throw new TypeError("getUpstreams must return an array");
    return Promise.allSettled(upstreams.map((upstream) => upstream.probe()));
  }

  return {
    probeNow,
    start() {
      if (timer) return;
      void probeNow();
      timer = schedule(probeNow, intervalMs);
      timer?.unref?.();
    },
    close() {
      if (!timer) return;
      cancel(timer);
      timer = null;
    },
  };
}

module.exports = { createUpstreamHealthMonitor };
