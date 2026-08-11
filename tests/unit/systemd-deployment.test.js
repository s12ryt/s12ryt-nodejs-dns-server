"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("systemd deployment provisions a dedicated user, state directory and hardened service", async () => {
  const [service, sysusers, tmpfiles, install] = await Promise.all([
    fs.readFile(path.join(ROOT, "deploy", "systemd", "s12-dns-server.service"), "utf8"),
    fs.readFile(path.join(ROOT, "deploy", "systemd", "s12-dns-server.sysusers"), "utf8"),
    fs.readFile(path.join(ROOT, "deploy", "systemd", "s12-dns-server.tmpfiles"), "utf8"),
    fs.readFile(path.join(ROOT, "deploy", "systemd", "install.sh"), "utf8"),
  ]);

  assert.match(service, /^User=s12-dns$/m);
  assert.match(service, /^Group=s12-dns$/m);
  assert.match(service, /^WorkingDirectory=\/var\/lib\/s12-dns-server$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/s12-dns-server\/index\.js$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^TimeoutStopSec=30s$/m);
  assert.match(service, /^KillSignal=SIGTERM$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ProtectHome=true$/m);
  assert.match(service, /^ReadWritePaths=\/var\/lib\/s12-dns-server$/m);
  assert.match(service, /^StandardOutput=journal$/m);
  assert.match(service, /^StandardError=journal$/m);

  assert.match(sysusers, /^u s12-dns - "S12 DNS Server"/m);
  assert.match(tmpfiles, /^d \/var\/lib\/s12-dns-server 0700 s12-dns s12-dns/m);
  assert.match(install, /systemd-sysusers/);
  assert.match(install, /systemd-tmpfiles/);
  assert.match(install, /install[^\n]+index\.js/);
  assert.match(install, /systemctl enable --now s12-dns-server\.service/);
});
