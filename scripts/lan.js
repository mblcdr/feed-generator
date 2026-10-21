// Starts the server so other devices on the local network can open it.
// Binds to 0.0.0.0 and allows the Host headers of this machine's LAN addresses and hostname.
const os = require('os');

const port = process.env.PORT || '3000';
const names = new Set();
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a.family === 'IPv4' && !a.internal) names.add(a.address);
  }
}
const hostname = os.hostname();
names.add(hostname);
if (!hostname.includes('.')) names.add(`${hostname}.local`);

const extra = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const allowed = [...new Set([...[...names].map((n) => `${n}:${port}`), ...extra])];

process.env.HOST = '0.0.0.0';
process.env.ALLOWED_HOSTS = allowed.join(',');

console.log('LAN mode: the app has no login, only use this on a trusted network.');
for (const n of names) console.log(`  http://${n}:${port}`);

require('../server.js');
