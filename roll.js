// Losování týmů a rolí — sdílené mezi webem (window.ScrimRoll) a Discord botem (require)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScrimRoll = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
  const PREF_SCORE = { 2: 4, 1: 2, 0: -6 };
  const ROLE_WEIGHT = 12;   // 1 bod preference ~ 12 bodů ratingu
  const TOLERANCE = 25;     // náhodný výběr mezi sestavami do +25 od nejlepší
  const PAIR_PENALTY = 8;   // za každou dvojici, která spolu hrála v posledních zápasech

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function rolePerms(k) {
    const out = [];
    const go = (cur, rest) => {
      if (cur.length === k) { out.push(cur); return; }
      rest.forEach((r, i) => go([...cur, r], rest.filter((_, j) => j !== i)));
    };
    go([], ROLES);
    return out;
  }

  // všechny k-tice indexů obsahující 0 (zrcadlové dvojice jen jednou)
  function combos(n, k) {
    const out = [];
    const go = (start, cur) => {
      if (cur.length === k) { out.push(cur); return; }
      for (let i = start; i < n; i++) go(i + 1, [...cur, i]);
    };
    go(1, [0]);
    return out;
  }

  const pref = (p, r) => {
    const v = p.roles && p.roles[r];
    return PREF_SCORE[v === 0 || v === 1 || v === 2 ? v : 1];
  };
  const avg = (t) => t.reduce((s, p) => s + p.rating, 0) / t.length;
  const keyOf = (team) => team.map((p) => p.id).sort((a, b) => a - b).join(',');

  // prevRoles: {playerId: role} z minulé hry — náhodné role se snaží neopakovat
  function makeAssigner(rolesMode, prevRoles) {
    const prev = prevRoles || {};
    const repeatsOf = (team, perm) => team.reduce((n, p, i) => n + (prev[p.id] === perm[i] ? 1 : 0), 0);
    const permCache = {};
    const jitter = new Map();
    const jit = (p, r) => {
      if (!jitter.has(p.id)) jitter.set(p.id, Object.fromEntries(ROLES.map((x) => [x, Math.random() * 1.5])));
      return jitter.get(p.id)[r];
    };
    return function assign(team) {
      const k = team.length;
      const perms = permCache[k] || (permCache[k] = rolePerms(k));
      if (rolesMode === 'random') {
        let pool = perms;
        if (Object.keys(prev).length) {
          const min = Math.min(...perms.map((p) => repeatsOf(team, p)));
          pool = perms.filter((p) => repeatsOf(team, p) === min);
        }
        const rs = pool[Math.floor(Math.random() * pool.length)];
        return { roles: rs, score: team.reduce((s, p, i) => s + pref(p, rs[i]), 0) };
      }
      let best = null;
      for (const perm of perms) {
        let s = 0, sj = 0;
        for (let i = 0; i < k; i++) { s += pref(team[i], perm[i]); sj += jit(team[i], perm[i]); if (prev[team[i].id] === perm[i]) sj -= 1; }
        if (!best || s + sj > best.total) best = { roles: perm, score: s, total: s + sj };
      }
      return best;
    };
  }

  function toSide(team, assigned) {
    return team.map((p, i) => {
      const v = p.roles && p.roles[assigned.roles[i]];
      return { player: p, role: assigned.roles[i], pref: v === 0 || v === 1 || v === 2 ? v : 1 };
    }).sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  }

  /**
   * Rozlosuje hráče do dvou týmů a rozdá role.
   * players: [{id, name, rating, roles:{top:0-2,...}}]
   * opts: {teams: 'balanced'|'random', roles: 'prefs'|'random', lastKey, avoidPairs: Set<'minId-maxId'>}
   */
  function roll(players, opts) {
    opts = Object.assign({ teams: 'balanced', roles: 'prefs' }, opts || {});
    if (players.length < 2) throw new Error('Na losování jsou potřeba aspoň dva hráči.');
    const pool = shuffle([...players]);
    const bench = pool.length > 10 ? pool.splice(10) : [];
    if (pool.length % 2) bench.push(pool.pop());
    const k = pool.length / 2;
    const assign = makeAssigner(opts.roles);
    const maxRole = 2 * k * PREF_SCORE[2];

    const avoid = opts.avoidPairs instanceof Set ? opts.avoidPairs : new Set(opts.avoidPairs || []);
    const repeats = (t) => {
      let n = 0;
      for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
        const a = Math.min(t[i].id, t[j].id), b = Math.max(t[i].id, t[j].id);
        if (avoid.has(`${a}-${b}`)) n++;
      }
      return n;
    };
    const evaluate = (A, B) => {
      const ra = assign(A), rb = assign(B);
      const cost = (opts.teams === 'balanced' ? Math.abs(avg(A) - avg(B)) + PAIR_PENALTY * (repeats(A) + repeats(B)) : 0) +
        (opts.roles === 'prefs' ? ROLE_WEIGHT * (maxRole - ra.score - rb.score) : 0);
      return { A, B, ra, rb, cost, keys: [keyOf(A), keyOf(B)] };
    };

    let pick;
    if (opts.teams === 'random') {
      pick = evaluate(pool.slice(0, k), pool.slice(k));
    } else {
      const cands = combos(pool.length, k).map((c) => {
        const inA = new Set(c);
        return evaluate(c.map((i) => pool[i]), pool.filter((_, i) => !inA.has(i)));
      });
      const best = Math.min(...cands.map((c) => c.cost));
      let near = cands.filter((c) => c.cost <= best + TOLERANCE);
      const fresh = near.filter((c) => !c.keys.includes(opts.lastKey));
      if (fresh.length) near = fresh;
      pick = near[Math.floor(Math.random() * near.length)];
    }

    const flip = Math.random() < 0.5;
    const blue = toSide(flip ? pick.B : pick.A, flip ? pick.rb : pick.ra);
    const red = toSide(flip ? pick.A : pick.B, flip ? pick.ra : pick.rb);
    return { blue, red, bench, key: keyOf(blue.map((x) => x.player)) };
  }

  /** Týmy jsou dané (např. dva hlasové kanály), rozdají se jen role. */
  function assignRoles(blueTeam, redTeam, opts) {
    opts = Object.assign({ roles: 'prefs' }, opts || {});
    if (!blueTeam.length || !redTeam.length) throw new Error('Oba týmy musí mít aspoň jednoho hráče.');
    if (blueTeam.length > 5 || redTeam.length > 5) throw new Error('Tým může mít nejvýš pět hráčů.');
    const assign = makeAssigner(opts.roles, opts.prevRoles);
    return {
      blue: toSide(blueTeam, assign(blueTeam)),
      red: toSide(redTeam, assign(redTeam)),
      bench: [],
      key: keyOf(blueTeam),
    };
  }

  function odds(blue, red) {
    const a = (t) => t.reduce((s, x) => s + x.player.rating, 0) / t.length;
    const ab = a(blue), ar = a(red);
    return { ab, ar, pBlue: 1 / (1 + Math.pow(10, (ar - ab) / 400)) };
  }

  return { ROLES, roll, assignRoles, odds };
}));
