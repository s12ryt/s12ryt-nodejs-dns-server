"use strict";

class EventLog {
  #events = [];

  constructor(maxEntries = 500, now = Date.now) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  add(event) {
    this.#events.push({ ...event, timestamp: event.timestamp || new Date(this.now()).toISOString() });
    if (this.#events.length > this.maxEntries) this.#events.splice(0, this.#events.length - this.maxEntries);
  }

  list() {
    return this.#events.map((event) => ({ ...event }));
  }
}

module.exports = { EventLog };
