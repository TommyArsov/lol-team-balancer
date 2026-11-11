// Databáze, rating a statistiky scrimů (SQLite vestavěné v Node 22.13+)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const PROVISIONAL_GAMES = 5;   // prvních pár her se rating hýbe rychleji
const PROVISIONAL_MULT = 1.5;

class UserError extends Error {}

function openDb({ dataDir, eloK = 32, riot = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'scrim.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT UNIQUE,
      name TEXT NOT NULL,
      riot_id TEXT,
      roles TEXT NOT NULL DEFAULT '{}',
      base_rating REAL NOT NULL DEFAULT 1000,
      rating REAL NOT NULL DEFAULT 1000,
      rank_tier TEXT, rank_division TEXT, rank_lp INTEGER, rank_updated TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      played_at TEXT NOT NULL,
      winner TEXT CHECK (winner IN ('blue','red')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS match_players (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id),
      team TEXT NOT NULL CHECK (team IN ('blue','red')),
      role TEXT,
      champion TEXT,
      kills INTEGER, deaths INTEGER, assists INTEGER,
      rating_change REAL,
      PRIMARY KEY (match_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
      PRIMARY KEY (guild_id, key)
    );
    CREATE TABLE IF NOT EXISTS roll_sessions (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // migrace starších databází
  const hasCol = (t, c) => !!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
  if (!hasCol('players', 'avatar_url')) db.exec('ALTER TABLE players ADD COLUMN avatar_url TEXT');
  if (!hasCol('matches', 'series_id')) db.exec('ALTER TABLE matches ADD COLUMN series_id TEXT');

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const playerRow = (p) => ({
    id: p.id, discordId: p.discord_id, name: p.name, riotId: p.riot_id || null, avatar: p.avatar_url || null,
    roles: { ...Object.fromEntries(ROLES.map((r) => [r, 1])), ...JSON.parse(p.roles || '{}') },
    baseRating: Math.round(p.base_rating), rating: Math.round(p.rating), active: !!p.active,
    rank: p.rank_tier ? { tier: p.rank_tier, division: p.rank_division, lp: p.rank_lp, updated: p.rank_updated } : null,
  });

  /* ---------- hráči ---------- */
  const getPlayerByDiscord = (id) => { const r = db.prepare('SELECT * FROM players WHERE discord_id = ?').get(id); return r ? playerRow(r) : null; };
  const getPlayer = (id) => { const r = db.prepare('SELECT * FROM players WHERE id = ?').get(id); return r ? playerRow(r) : null; };

  // Najde nebo založí hráče podle Discord účtu, jméno a avatar drží aktuální.
  function ensurePlayer(discordId, displayName, avatarUrl) {
    const name = String(displayName || 'Hráč').trim().slice(0, 32) || 'Hráč';
    const row = db.prepare('SELECT * FROM players WHERE discord_id = ?').get(discordId);
    if (row) {
      if (row.name !== name || !row.active || (avatarUrl && row.avatar_url !== avatarUrl)) {
        db.prepare('UPDATE players SET name = ?, active = 1, avatar_url = COALESCE(?, avatar_url) WHERE id = ?').run(name, avatarUrl || null, row.id);
      }
      return { player: getPlayer(row.id), created: false };
    }
    const roles = JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, 1])));
    const r = db.prepare('INSERT INTO players (discord_id, name, roles, avatar_url) VALUES (?, ?, ?, ?)').run(discordId, name, roles, avatarUrl || null);
    return { player: getPlayer(Number(r.lastInsertRowid)), created: true };
  }

  function setRole(playerId, role, value) {
    const p = getPlayer(playerId);
    const roles = { ...p.roles, [role]: [0, 1, 2].includes(value) ? value : 1 };
    db.prepare('UPDATE players SET roles = ? WHERE id = ?').run(JSON.stringify(roles), playerId);
    return { ...p, roles };
  }

  function updatePlayer(playerId, { name, baseRating, active }) {
    if (name !== undefined && name !== null) db.prepare('UPDATE players SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 32), playerId);
    if (active !== undefined && active !== null) db.prepare('UPDATE players SET active = ? WHERE id = ?').run(active ? 1 : 0, playerId);
    if (baseRating !== undefined && baseRating !== null) {
      db.prepare('UPDATE players SET base_rating = ? WHERE id = ?').run(Math.max(0, Math.min(3500, Number(baseRating))), playerId);
      recomputeRatings();
    }
    return getPlayer(playerId);
  }

  const gamesOf = (playerId) => db.prepare(
    'SELECT COUNT(*) AS n FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.player_id = ? AND m.winner IS NOT NULL',
  ).get(playerId).n;

  /* ---------- rating ---------- */
  // Elo na úrovni týmů; nováčci mají prvních pár her větší K, aby se rychle usadili.
  function recomputeRatings() {
    const rating = new Map(db.prepare('SELECT id, base_rating FROM players').all().map((p) => [p.id, p.base_rating]));
    const played = new Map();
    const matches = db.prepare('SELECT id, winner FROM matches WHERE winner IS NOT NULL ORDER BY played_at, id').all();
    const mpStmt = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?');
    const upd = db.prepare('UPDATE match_players SET rating_change = ? WHERE match_id = ? AND player_id = ?');
    tx(() => {
      db.exec('UPDATE match_players SET rating_change = NULL');
      for (const m of matches) {
        const mps = mpStmt.all(m.id);
        const blue = mps.filter((x) => x.team === 'blue');
        const red = mps.filter((x) => x.team === 'red');
        if (!blue.length || !red.length) continue;
        const avg = (t) => t.reduce((s, x) => s + rating.get(x.player_id), 0) / t.length;
        const expBlue = 1 / (1 + 10 ** ((avg(red) - avg(blue)) / 400));
        const base = (m.winner === 'blue' ? 1 : 0) - expBlue;
        for (const x of mps) {
          const n = played.get(x.player_id) || 0;
          const k = eloK * (n < PROVISIONAL_GAMES ? PROVISIONAL_MULT : 1);
          const d = k * (x.team === 'blue' ? base : -base);
          rating.set(x.player_id, rating.get(x.player_id) + d);
          played.set(x.player_id, n + 1);
          upd.run(d, m.id, x.player_id);
        }
      }
      const setR = db.prepare('UPDATE players SET rating = ? WHERE id = ?');
      for (const [id, r] of rating) setR.run(r, id);
    });
  }

  function rankToRating(tier, division, lp) {
    const t = TIERS.indexOf(tier);
    if (t < 0) return null;
    if (t >= 7) return Math.round(2000 + Math.min(lp || 0, 1500) / 5);
    const div = { IV: 0, III: 1, II: 2, I: 3 }[division] ?? 0;
    return Math.round(600 + t * 200 + div * 50 + Math.min(lp || 0, 100) / 2);
  }

  /* ---------- zápasy ---------- */
  function createMatch(guildId, blue, red, seriesId = null) {
    if (!blue.length || !red.length || blue.length > 5 || red.length > 5) throw new UserError('Každý tým musí mít 1–5 hráčů.');
    return tx(() => {
      const r = db.prepare('INSERT INTO matches (guild_id, played_at, series_id) VALUES (?, ?, ?)').run(guildId, new Date().toISOString(), seriesId);
      const ins = db.prepare('INSERT INTO match_players (match_id, player_id, team, role) VALUES (?, ?, ?, ?)');
      for (const x of blue) ins.run(r.lastInsertRowid, x.playerId, 'blue', ROLES.includes(x.role) ? x.role : null);
      for (const x of red) ins.run(r.lastInsertRowid, x.playerId, 'red', ROLES.includes(x.role) ? x.role : null);
      return Number(r.lastInsertRowid);
    });
  }

  function getMatch(id) {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!m) return null;
    const ps = db.prepare(`SELECT mp.*, p.name, p.discord_id, p.avatar_url, p.rating FROM match_players mp
      JOIN players p ON p.id = mp.player_id WHERE match_id = ?`).all(id).map((x) => ({
      playerId: x.player_id, discordId: x.discord_id, name: x.name, avatar: x.avatar_url, team: x.team, role: x.role,
      champion: x.champion, kills: x.kills, deaths: x.deaths, assists: x.assists, rating: Math.round(x.rating),
      ratingChange: x.rating_change === null ? null : Math.round(x.rating_change),
    }));
    const order = (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
    return { id: m.id, guildId: m.guild_id, playedAt: m.played_at, winner: m.winner, seriesId: m.series_id || null,
      blue: ps.filter((x) => x.team === 'blue').sort(order), red: ps.filter((x) => x.team === 'red').sort(order) };
  }

  function recentMatches(guildId, limit = 10) {
    return db.prepare('SELECT id FROM matches WHERE guild_id = ? ORDER BY played_at DESC, id DESC LIMIT ?').all(guildId, limit).map((x) => getMatch(x.id));
  }

  // Skóre série: kolikrát vyhrál modrý a červený tým (týmy si v sérii drží barvu)
  function seriesScore(seriesId) {
    if (!seriesId) return null;
    const r = db.prepare(`SELECT COUNT(*) AS games, SUM(winner = 'blue') AS blue, SUM(winner = 'red') AS red
      FROM matches WHERE series_id = ?`).get(seriesId);
    return { games: r.games, blue: r.blue || 0, red: r.red || 0 };
  }

  function setWinner(id, winner) {
    db.prepare('UPDATE matches SET winner = ? WHERE id = ?').run(winner === 'blue' || winner === 'red' ? winner : null, id);
    recomputeRatings();
    return getMatch(id);
  }

  function deleteMatch(id) {
    const r = db.prepare('DELETE FROM matches WHERE id = ?').run(id);
    recomputeRatings();
    return r.changes > 0;
  }

  function saveStats(matchId, playerId, { champion, kills, deaths, assists }) {
    db.prepare('UPDATE match_players SET champion = ?, kills = ?, deaths = ?, assists = ? WHERE match_id = ? AND player_id = ?')
      .run(champion || null, kills, deaths, assists, matchId, playerId);
  }

  // Dvojice, které hrály spolu v jednom týmu v posledních N zápasech (pro pestřejší losování)
  function recentTeammatePairs(guildId, lastN = 2) {
    const ids = db.prepare('SELECT id FROM matches WHERE guild_id = ? ORDER BY played_at DESC, id DESC LIMIT ?').all(guildId, lastN).map((x) => x.id);
    const pairs = new Set();
    for (const id of ids) {
      const mps = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ?').all(id);
      for (const a of mps) for (const b of mps) if (a.player_id < b.player_id && a.team === b.team) pairs.add(`${a.player_id}-${b.player_id}`);
    }
    return pairs;
  }

  /* ---------- statistiky ---------- */
  function computeStats(guildId) {
    const players = db.prepare('SELECT * FROM players').all().map(playerRow);
    const rows = db.prepare(`SELECT mp.*, m.winner, m.played_at FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE m.winner IS NOT NULL ${guildId ? 'AND m.guild_id = ?' : ''} ORDER BY m.played_at, m.id`).all(...(guildId ? [guildId] : []));

    const byId = new Map(players.map((p) => [p.id, {
      ...p, games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, kdaGames: 0,
      roleStats: Object.fromEntries(ROLES.map((r) => [r, { games: 0, wins: 0 }])), champs: {}, form: [], streak: 0,
      history: [], with: new Map(), against: new Map(),
    }]));

    // seskupit podle zápasu kvůli dvojicím
    const byMatch = new Map();
    for (const r of rows) { if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, []); byMatch.get(r.match_id).push(r); }
    const matchOrder = [...byMatch.keys()];
    const bump = (map, key, won) => { const v = map.get(key) || { games: 0, wins: 0 }; v.games++; if (won) v.wins++; map.set(key, v); };

    for (const [matchId, mps] of byMatch) {
      for (const r of mps) {
        const s = byId.get(r.player_id); if (!s) continue;
        const won = r.team === r.winner;
        s.games++; won ? s.wins++ : s.losses++;
        if (r.kills !== null) { s.kdaGames++; s.kills += r.kills; s.deaths += r.deaths || 0; s.assists += r.assists || 0; }
        if (r.role && s.roleStats[r.role]) { s.roleStats[r.role].games++; if (won) s.roleStats[r.role].wins++; }
        if (r.champion) { const c = (s.champs[r.champion] ||= { games: 0, wins: 0, k: 0, d: 0, a: 0, kdaGames: 0 }); c.games++; if (won) c.wins++;
          if (r.kills !== null) { c.kdaGames++; c.k += r.kills; c.d += r.deaths || 0; c.a += r.assists || 0; } }
        s.form.push(won ? 'W' : 'L');
        s.history.push({ matchId, idx: matchOrder.indexOf(matchId), delta: r.rating_change || 0, won, role: r.role,
          champion: r.champion, kills: r.kills, deaths: r.deaths, assists: r.assists, playedAt: r.played_at });
        for (const o of mps) {
          if (o.player_id === r.player_id) continue;
          bump(o.team === r.team ? s.with : s.against, o.player_id, won);
        }
      }
    }

    const named = (map) => [...map].map(([id, v]) => ({ id, name: byId.get(id)?.name || '?', avatar: byId.get(id)?.avatar,
      discordId: byId.get(id)?.discordId, ...v, winrate: v.wins / v.games }));
    for (const s of byId.values()) {
      s.winrate = s.games ? s.wins / s.games : null;
      s.kda = s.kdaGames ? (s.kills + s.assists) / Math.max(1, s.deaths) : null;
      s.avg = s.kdaGames ? { k: s.kills / s.kdaGames, d: s.deaths / s.kdaGames, a: s.assists / s.kdaGames } : null;
      let n = 0; const last = s.form[s.form.length - 1];
      for (let i = s.form.length - 1; i >= 0 && s.form[i] === last; i--) n++;
      s.streak = last ? (last === 'W' ? n : -n) : 0;
      s.formAll = s.form;
      s.form = s.form.slice(-10);
      s.recentWinrate = s.form.length ? s.form.filter((f) => f === 'W').length / s.form.length : null;
      let r = s.baseRating;
      s.ratingHistory = [r, ...s.history.map((h) => Math.round((r += h.delta)))];
      s.peak = Math.max(...s.ratingHistory);
      s.provisional = s.games < PROVISIONAL_GAMES;
      s.champs = Object.entries(s.champs).map(([name, v]) => ({ name, ...v, kda: v.kdaGames ? (v.k + v.a) / Math.max(1, v.d) : null }))
        .sort((a, b) => b.games - a.games || b.wins - a.wins);
      s.teammates = named(s.with).sort((a, b) => b.games - a.games);
      s.opponents = named(s.against).sort((a, b) => b.games - a.games);
      const MIN = 2;
      const duo = s.teammates.filter((x) => x.games >= MIN).sort((a, b) => b.winrate - a.winrate || b.games - a.games);
      s.bestDuo = duo[0] || null;
      s.worstDuo = duo.length > 1 ? duo[duo.length - 1] : null;
      const opp = s.opponents.filter((x) => x.games >= MIN).sort((a, b) => a.winrate - b.winrate || b.games - a.games);
      s.nemesis = opp[0] && opp[0].winrate < 0.5 ? opp[0] : null;
      s.favoriteVictim = opp.length && opp[opp.length - 1].winrate > 0.5 ? opp[opp.length - 1] : null;
      delete s.with; delete s.against;
    }
    const t = db.prepare(`SELECT COUNT(*) AS n, SUM(winner = 'blue') AS blue FROM matches WHERE winner IS NOT NULL ${guildId ? 'AND guild_id = ?' : ''}`)
      .get(...(guildId ? [guildId] : []));
    return { players: [...byId.values()].sort((a, b) => b.rating - a.rating), totals: { matches: t.n, blueWins: t.blue || 0 }, matchCount: matchOrder.length };
  }

  /* ---------- rozpracovaná losování (přežijí restart) ---------- */
  function saveSession(s) {
    db.prepare('INSERT INTO roll_sessions (id, guild_id, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(s.id, s.guildId, JSON.stringify(s), s.at);
    db.prepare('DELETE FROM roll_sessions WHERE created_at < ?').run(Date.now() - 48 * 3600e3);
  }
  const loadSession = (id) => { const r = db.prepare('SELECT data FROM roll_sessions WHERE id = ?').get(id); return r ? JSON.parse(r.data) : null; };
  const sessionForMatch = (matchId) => {
    const r = db.prepare("SELECT data FROM roll_sessions WHERE json_extract(data, '$.matchId') = ? ORDER BY created_at DESC LIMIT 1").get(matchId);
    return r ? JSON.parse(r.data) : null;
  };

  /* ---------- nastavení serveru ---------- */
  const getSetting = (g, k) => db.prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?').get(g, k)?.value || null;
  const setSetting = (g, k, v) => db.prepare('INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?) ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value').run(g, k, v);

  /* ---------- Riot API ---------- */
  async function riotGet(url) {
    const r = await fetch(url, { headers: { 'X-Riot-Token': riot.key }, signal: AbortSignal.timeout(8000) });
    if (r.status === 404) throw new UserError('Riot ID nebyl nalezen. Zkontroluj jméno a tag, třeba Hráč#EUNE.');
    if (r.status === 401 || r.status === 403) throw new UserError('Riot API odmítlo klíč. Development klíč platí 24 hodin, je potřeba vygenerovat nový.');
    if (r.status === 429) throw new UserError('Riot API hlásí moc požadavků. Zkus to za minutu.');
    if (!r.ok) throw new UserError(`Riot API vrátilo chybu ${r.status}.`);
    return r.json();
  }

  async function linkRiot(playerId, riotId) {
    const [gameName, tagLine] = String(riotId).split('#').map((x) => x && x.trim());
    if (!gameName || !tagLine) throw new UserError('Riot ID musí mít tvar Jméno#TAG.');
    if (!riot.key) {
      db.prepare('UPDATE players SET riot_id = ? WHERE id = ?').run(`${gameName}#${tagLine}`, playerId);
      return { player: getPlayer(playerId), solo: null, lookedUp: false };
    }
    const acc = await riotGet(`https://${riot.region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    const entries = await riotGet(`https://${riot.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(acc.puuid)}`);
    const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') || entries.find((e) => e.queueType === 'RANKED_FLEX_SR') || null;
    db.prepare(`UPDATE players SET riot_id = ?, rank_tier = ?, rank_division = ?, rank_lp = ?, rank_updated = datetime('now') WHERE id = ?`)
      .run(`${acc.gameName}#${acc.tagLine}`, solo?.tier || 'UNRANKED', solo?.rank || null, solo?.leaguePoints ?? null, playerId);
    let ratingSet = null;
    const suggested = solo ? rankToRating(solo.tier, solo.rank, solo.leaguePoints) : null;
    if (suggested && gamesOf(playerId) === 0) { updatePlayer(playerId, { baseRating: suggested }); ratingSet = suggested; }
    return { player: getPlayer(playerId), solo, lookedUp: true, suggested, ratingSet };
  }

  /* ---------- championi (Data Dragon) ---------- */
  const champs = { version: null, byKey: new Map(), byName: new Map() };
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  async function loadChampions() {
    try {
      const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json', { signal: AbortSignal.timeout(8000) })).json())[0];
      const data = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/en_US/champion.json`, { signal: AbortSignal.timeout(8000) })).json()).data;
      champs.version = v;
      for (const c of Object.values(data)) {
        const entry = { id: c.id, name: c.name };
        champs.byKey.set(norm(c.name), entry); champs.byKey.set(norm(c.id), entry); champs.byName.set(c.name, entry);
      }
      console.log(`[data] ${champs.byName.size} championů z Data Dragonu ${v}`);
    } catch (e) { console.warn('[data] seznam championů se nepodařilo stáhnout:', e.message); }
  }
  const normalizeChampion = (input) => {
    const s = String(input || '').trim().slice(0, 30);
    if (!s) return null;
    const hit = champs.byKey.get(norm(s));
    return hit ? hit.name : s.replace(/(^|[\s'-])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase());
  };
  const championIconUrl = (name) => {
    const c = name && (champs.byName.get(name) || champs.byKey.get(norm(name)));
    return c && champs.version ? `https://ddragon.leagueoflegends.com/cdn/${champs.version}/img/champion/${c.id}.png` : null;
  };
  const championNames = () => [...champs.byName.keys()];

  recomputeRatings();

  return {
    db, ROLES, UserError, playerRow, getPlayer, getPlayerByDiscord, ensurePlayer, setRole, updatePlayer,
    recomputeRatings, rankToRating, createMatch, getMatch, recentMatches, setWinner, seriesScore, deleteMatch, saveStats, recentTeammatePairs,
    computeStats, saveSession, loadSession, sessionForMatch, getSetting, setSetting, linkRiot,
    loadChampions, normalizeChampion, championIconUrl, championNames, riotEnabled: !!riot.key, dataDir,
  };
}

module.exports = { openDb, UserError, ROLES, PROVISIONAL_GAMES };
