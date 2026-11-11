// Spuštění: node index.js  (Node 22.13+)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// .env bez závislostí
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { openDb } = require('./db.js');
const { start } = require('./bot.js');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Chybí DISCORD_TOKEN. Zkopíruj .env.example do .env a vyplň token bota z Discord Developer Portalu.');
  process.exit(1);
}

const store = openDb({
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  eloK: Number(process.env.ELO_K || 32),
  riot: {
    key: process.env.RIOT_API_KEY || '',
    platform: (process.env.RIOT_PLATFORM || 'eun1').toLowerCase(),
    region: (process.env.RIOT_REGION || 'europe').toLowerCase(),
  },
});
require('./render.js').setCacheDir(path.join(store.dataDir, 'cache'));
store.loadChampions(); // na pozadí, bez internetu se championi jen nesjednotí

if (Number(process.env.DEV_FAKE_PLAYERS || 0) > 0) console.log(`[bot] TESTOVACÍ REŽIM: do /scrim se přidávají falešní hráči (DEV_FAKE_PLAYERS=${process.env.DEV_FAKE_PLAYERS})`);

start(store, {
  token,
  guildIds: (process.env.DISCORD_GUILD_ID || '').split(',').map((x) => x.trim()).filter(Boolean),
}).catch((e) => {
  console.error('[bot] přihlášení selhalo:', e.message);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { store.db.close(); } catch { /* už zavřená */ } process.exit(0); });
}
