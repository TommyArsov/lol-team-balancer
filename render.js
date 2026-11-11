// Obrázky pro Discord: SVG -> PNG (resvg). Žádný prohlížeč, žádný canvas.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Resvg } = require('@resvg/resvg-js');

const W = 1200;
const C = {
  night: '#0E1A26', panel: '#14273A', panel2: '#1A3046', line: '#22405A', lineSoft: '#1B3349',
  text: '#E7EEF3', muted: '#8DA3B5', blue: '#3D8BFF', red: '#F2554A', gold: '#D9B45A', good: '#57C78A', bad: '#F2554A',
  silver: '#C9D3DC', bronze: '#C98E5A',
};
const SERIES = ['#3D8BFF', '#F2554A', '#D9B45A', '#57C78A', '#A98BFF', '#4FD1D9'];
const ROLE_LABEL = { top: 'Top', jungle: 'Jungle', mid: 'Mid', adc: 'ADC', support: 'Support' };
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
const D = 'Barlow Condensed';   // display
const B = 'Barlow';             // text

const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_FILES = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf')).map((f) => path.join(FONT_DIR, f));

/* ================= obrázky (avatary, championi) ================= */
const memCache = new Map();
let diskDir = null;
function setCacheDir(dir) { diskDir = dir; fs.mkdirSync(dir, { recursive: true }); }

async function loadImage(url) {
  if (!url) return null;
  if (memCache.has(url)) { const v = memCache.get(url); memCache.delete(url); memCache.set(url, v); return v; }
  const file = diskDir && url.includes('ddragon') ? path.join(diskDir, crypto.createHash('sha1').update(url).digest('hex') + '.png') : null;
  let buf = null;
  if (file && fs.existsSync(file)) buf = fs.readFileSync(file);
  else {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    } catch { /* bez obrázku to taky jde */ }
    if (buf && file) { try { fs.writeFileSync(file, buf); } catch { /* cache je jen bonus */ } }
  }
  const mime = buf && buf[0] === 0xFF ? 'image/jpeg' : 'image/png';
  const uri = buf ? `data:${mime};base64,${buf.toString('base64')}` : null;
  memCache.set(url, uri);
  if (memCache.size > 300) memCache.delete(memCache.keys().next().value);
  return uri;
}
const loadAll = async (urls) => {
  const uniq = [...new Set(urls.filter(Boolean))];
  const res = await Promise.all(uniq.map(loadImage));
  return new Map(uniq.map((u, i) => [u, res[i]]));
};

/* ================= SVG pomůcky ================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
let uid = 0;
const id = (p) => `${p}${++uid}`;

// Odhad šířky textu (bez měření fontu); stačí na zkracování jmen.
function textWidth(s, size, family = D) {
  let w = 0;
  for (const ch of String(s)) {
    if ('ijlI.,:;!|\'1'.includes(ch)) w += 0.25;
    else if ('ftr()[] '.includes(ch)) w += 0.3;
    else if ('mwMW'.includes(ch)) w += 0.72;
    else if (/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(ch)) w += 0.54;
    else if (/[0-9]/.test(ch)) w += 0.5;
    else w += 0.46;
  }
  return w * size * (family === B ? 1.18 : 1);
}
function fit(s, maxW, size, family = D) {
  s = String(s ?? '');
  if (textWidth(s, size, family) <= maxW) return s;
  while (s.length > 1 && textWidth(s + '…', size, family) > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

function text(x, y, s, { size = 24, family = B, weight = 400, fill = C.text, anchor = 'start', opacity, maxW } = {}) {
  const str = maxW ? fit(s, maxW, size, family) : s;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}"` +
    `${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${opacity !== undefined ? ` opacity="${opacity}"` : ''}>${esc(str)}</text>`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
function hashColor(s) {
  let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ['#2E5A88', '#6A3E7A', '#2F6B5A', '#7A5A2E', '#7A2E3E', '#2E6A7A'][h % 6];
}

function avatar(x, y, size, uri, name, ring) {
  const cid = id('av');
  const r = size / 2;
  const inner = uri
    ? `<clipPath id="${cid}"><circle cx="${x + r}" cy="${y + r}" r="${r}"/></clipPath><image href="${uri}" x="${x}" y="${y}" width="${size}" height="${size}" clip-path="url(#${cid})" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${x + r}" cy="${y + r}" r="${r}" fill="${hashColor(name)}"/>${text(x + r, y + r + size * 0.17, initials(name), { size: size * 0.46, family: D, weight: 700, anchor: 'middle' })}`;
  return inner + (ring ? `<circle cx="${x + r}" cy="${y + r}" r="${r - 1.5}" fill="none" stroke="${ring}" stroke-width="3"/>` : '');
}

function champIcon(x, y, size, uri, name) {
  if (!uri) {
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="${C.panel2}" stroke="${C.line}"/>` +
      (name ? text(x + size / 2, y + size / 2 + size * 0.16, String(name).slice(0, 2), { size: size * 0.42, family: D, weight: 700, anchor: 'middle', fill: C.muted }) : '');
  }
  const cid = id('ch');
  return `<clipPath id="${cid}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10"/></clipPath>` +
    `<image href="${uri}" x="${x - size * 0.06}" y="${y - size * 0.06}" width="${size * 1.12}" height="${size * 1.12}" clip-path="url(#${cid})"/>` +
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="10" fill="none" stroke="${C.line}" stroke-width="2"/>`;
}

// Glyf role: rámeček minimapy se zvýrazněnou linkou (24×24)
function roleGlyph(role, x, y, size, color = C.text) {
  const s = size / 24;
  const lane = `fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"`;
  const inner = {
    top: `<path d="M6.5 15.5 V6.5 H15.5" ${lane}/>`,
    mid: `<path d="M7 17 L17 7" ${lane}/>`,
    adc: `<path d="M8.5 17.5 H17.5 V8.5" ${lane}/>`,
    jungle: `<circle cx="9" cy="14.5" r="2.2" fill="${color}"/><circle cx="15" cy="9.5" r="2.2" fill="${color}"/>`,
    support: `<path d="M12 6.5 L16.5 8.3 V11.8 C16.5 14.6 14.5 16.6 12 17.5 C9.5 16.6 7.5 14.6 7.5 11.8 V8.3 Z" ${lane}/>`,
  }[role] || '';
  return `<g transform="translate(${x} ${y}) scale(${s})"><rect x="3" y="3" width="18" height="18" rx="2.5" fill="none" stroke="${C.line}" stroke-width="2"/>${inner}</g>`;
}

function bar(x, y, w, h, frac, color = C.text, bg = C.lineSoft) {
  const f = Math.max(0, Math.min(1, frac || 0));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/>` +
    (f > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(h, w * f)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '');
}

function formSquares(x, y, form, size = 14, gap = 4) {
  return form.map((f, i) => `<rect x="${x + i * (size + gap)}" y="${y}" width="${size}" height="${size + 6}" rx="3" fill="${f === 'W' ? C.good : C.bad}" opacity="${f === 'W' ? 1 : 0.8}"/>`).join('');
}

function sparkline(x, y, w, h, values, color = C.text) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(20, max - min);
  const px = (i) => x + (i / (values.length - 1)) * w;
  const py = (v) => y + h - ((v - min) / span) * h;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>` +
    `<circle cx="${px(values.length - 1)}" cy="${py(values[values.length - 1])}" r="4" fill="${up ? C.good : C.bad}"/>`;
}

function frame(h, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">` +
    `<defs>${defs}</defs><rect width="${W}" height="${h}" rx="24" fill="${C.night}"/>${body}</svg>`;
}

function toPng(svg) {
  return new Resvg(svg, { font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: B }, fitTo: { mode: 'width', value: W } })
    .render().asPng();
}

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? '–' : `${Math.round(x * 100)} %`);
const dec = (x) => (x === null || x === undefined ? '–' : x.toFixed(1).replace('.', ','));
const signed = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

/* ================= losovací karta a výsledek ================= */
// sides: { blue: [{name, avatar, role, rating, pref, champion, kills, deaths, assists, delta}], red: [...] }
async function versusCard({ title, blue, red, bench = [], odds, winner = null, footer }) {
  const icons = await loadAll([...blue, ...red].flatMap((x) => [x.avatar, x.championIcon]));
  const lanes = ROLES.filter((r) => blue.some((x) => x.role === r) || red.some((x) => x.role === r));
  const top = 150, rowH = 88, gap = 10;
  const lanesEnd = top + lanes.length * (rowH + gap);
  const h = lanesEnd + (odds ? 110 : 30) + (bench.length ? 46 : 0) + (footer ? 10 : 0);
  const gB = id('gb'), gR = id('gr');
  const defs = `<linearGradient id="${gB}" x1="0" x2="1"><stop offset="0" stop-color="${C.blue}" stop-opacity="0"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0.22"/></linearGradient>` +
    `<linearGradient id="${gR}" x1="1" x2="0"><stop offset="0" stop-color="${C.red}" stop-opacity="0"/><stop offset="1" stop-color="${C.red}" stop-opacity="0.22"/></linearGradient>`;

  const avg = (t) => (t.length ? Math.round(t.reduce((s, x) => s + x.rating, 0) / t.length) : 0);
  let body = '';
  body += text(W / 2, 58, title, { size: 30, family: D, weight: 600, fill: C.muted, anchor: 'middle' });
  const head = (side, x, anchor) => {
    const won = winner === side;
    const color = side === 'blue' ? C.blue : C.red;
    let s = text(x, 118, side === 'blue' ? 'Modří' : 'Červení', { size: 58, family: D, weight: 700, fill: color, anchor });
    const sub = `průměr ${avg(side === 'blue' ? blue : red)}`;
    s += text(x, 64, sub, { size: 24, fill: C.muted, anchor });
    if (won) {
      const pw = 104, px = anchor === 'end' ? x - 190 - pw : x + 200;
      s += `<rect x="${px}" y="80" width="${pw}" height="42" rx="21" fill="${C.gold}"/>` +
        text(px + pw / 2, 110, 'Výhra', { size: 28, family: D, weight: 700, fill: C.night, anchor: 'middle' });
    }
    return s;
  };
  body += head('blue', 48, 'start') + head('red', W - 48, 'end');

  const axisW = 150, slotW = (W - 80 - axisW) / 2;
  const slot = (x, side, side_x, y) => {
    const isBlue = side === 'blue';
    const x0 = isBlue ? 40 : 40 + slotW + axisW;
    const color = isBlue ? C.blue : C.red;
    const dim = winner && winner !== side;
    let s = `<rect x="${x0}" y="${y}" width="${slotW}" height="${rowH}" rx="12" fill="url(#${isBlue ? gB : gR})" opacity="${dim ? 0.55 : 1}"/>` +
      `<rect x="${isBlue ? x0 + slotW - 5 : x0}" y="${y}" width="5" height="${rowH}" fill="${color}"/>`;
    if (!x) return s + text(isBlue ? x0 + slotW - 30 : x0 + 30, y + 56, '—', { size: 36, family: D, fill: C.line, anchor: isBlue ? 'end' : 'start' });
    const imgSize = 60;
    const imgX = isBlue ? x0 + slotW - 24 - imgSize : x0 + 24;
    const imgY = y + (rowH - imgSize) / 2;
    s += x.champion ? champIcon(imgX, imgY, imgSize, icons.get(x.championIcon), x.champion) : avatar(imgX, imgY, imgSize, icons.get(x.avatar), x.name);
    const tx = isBlue ? imgX - 18 : imgX + imgSize + 18;
    const anchor = isBlue ? 'end' : 'start';
    const deltaW = x.delta !== undefined && x.delta !== null ? 70 : 0;
    s += text(tx, y + 44, x.name, { size: 38, family: D, weight: 700, anchor, maxW: slotW - imgSize - 70 - deltaW });
    // druhý řádek
    const parts = [];
    if (x.champion) parts.push({ t: x.champion, c: C.text });
    if (x.kills !== null && x.kills !== undefined) parts.push({ t: `${x.kills}/${x.deaths}/${x.assists}`, c: C.muted });
    if (!x.champion && x.kills == null) {
      parts.push({ t: String(x.rating), c: C.muted });
      if (x.pref === 0) parts.push({ t: 'mimo roli', c: C.gold });
      else if (x.pref === 2) parts.push({ t: 'main', c: C.muted });
      if (x.provisional) parts.push({ t: 'nováček', c: C.muted });
    }
    const line2 = parts.map((p) => `<tspan fill="${p.c}">${esc(p.t)}</tspan>`).join(`<tspan fill="${C.line}">  ·  </tspan>`);
    s += `<text x="${tx}" y="${y + 74}" font-family="${B}" font-size="22" font-weight="500"${anchor === 'end' ? ' text-anchor="end"' : ''}>${line2}</text>`;
    if (deltaW) {
      const dx = isBlue ? x0 + 20 : x0 + slotW - 20;
      s += text(dx, y + 56, signed(x.delta), { size: 32, family: D, weight: 700, fill: x.delta >= 0 ? C.good : C.bad, anchor: isBlue ? 'start' : 'end' });
    }
    return s;
  };

  lanes.forEach((role, i) => {
    const y = top + i * (rowH + gap);
    body += slot(blue.find((x) => x.role === role), 'blue', 0, y);
    body += slot(red.find((x) => x.role === role), 'red', 0, y);
    const cx = 40 + slotW + axisW / 2;
    body += roleGlyph(role, cx - 20, y + 10, 40);
    body += text(cx, y + 78, ROLE_LABEL[role], { size: 24, family: D, weight: 600, fill: C.muted, anchor: 'middle' });
  });

  let y = lanesEnd + 10;
  if (odds) {
    const pB = Math.round(odds * 100);
    body += text(48, y + 34, `${pB} %`, { size: 40, family: D, weight: 700, fill: C.blue });
    body += text(W - 48, y + 34, `${100 - pB} %`, { size: 40, family: D, weight: 700, fill: C.red, anchor: 'end' });
    body += text(W / 2, y + 30, 'odhad šance podle ratingu', { size: 22, fill: C.muted, anchor: 'middle' });
    const bx = 48, bw = W - 96, by = y + 52;
    body += `<rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8" fill="${C.red}"/>` +
      `<rect x="${bx}" y="${by}" width="${Math.max(8, bw * odds)}" height="16" rx="8" fill="${C.blue}"/>` +
      `<rect x="${W / 2 - 1.5}" y="${by - 5}" width="3" height="26" fill="${C.night}"/>`;
    y += 100;
  }
  if (bench.length) {
    body += text(48, y + 30, `Na lavičce: ${bench.join(', ')}`, { size: 24, fill: C.muted, maxW: W - 96 });
  }
  return toPng(frame(h, body, defs));
}

/* ================= žebříček ================= */
const SORT_LABEL = { rating: 'ratingu', winrate: 'winrate', kda: 'KDA', games: 'počtu zápasů', form: 'formy' };

async function leaderboardCard({ rows, page, pages, sort, totals, minRanked = 0 }) {
  const icons = await loadAll(rows.map((p) => p.avatar));
  const top = 150, rowH = 62;
  const h = top + Math.max(1, rows.length) * rowH + 70;
  let body = '';
  body += text(48, 86, 'Žebříček', { size: 64, family: D, weight: 700 });
  body += text(W - 48, 72, `seřazeno podle ${SORT_LABEL[sort] || 'ratingu'}`, { size: 24, fill: C.muted, anchor: 'end' });
  body += text(W - 48, 104, `strana ${page + 1} z ${pages}`, { size: 24, fill: C.muted, anchor: 'end' });
  const col = { rank: 70, name: 160, rating: 520, spark: 600, games: 790, wr: 840, kda: 1010, form: 1060 };
  const hy = top - 14;
  body += text(col.name - 64, hy, 'Hráč', { size: 20, fill: C.muted });
  body += text(col.rating, hy, 'Rating', { size: 20, fill: C.muted, anchor: 'end' });
  body += text(col.games, hy, 'V–P', { size: 20, fill: C.muted, anchor: 'end' });
  body += text(col.wr, hy, 'Winrate', { size: 20, fill: C.muted });
  body += text(col.kda, hy, 'KDA', { size: 20, fill: C.muted, anchor: 'end' });
  body += text(col.form + 10, hy, 'Posledních 5', { size: 20, fill: C.muted });
  rows.forEach((p, i) => {
    const y = top + i * rowH;
    const rank = p.rankNo;
    if (i % 2 === 0) body += `<rect x="28" y="${y}" width="${W - 56}" height="${rowH}" rx="10" fill="${C.panel}"/>`;
    const rc = rank === 1 ? C.gold : rank === 2 ? C.silver : rank === 3 ? C.bronze : C.muted;
    body += text(col.rank, y + 42, rank ? String(rank) : '–', { size: 32, family: D, weight: 700, fill: rc, anchor: 'end' });
    if (!rank) body += '<g opacity="0.55">';
    body += avatar(col.name - 66, y + 9, 44, icons.get(p.avatar), p.name);
    body += text(col.name - 8, y + 41, p.name, { size: 32, family: D, weight: 600, maxW: 260 });
    body += text(col.rating, y + 43, String(p.rating), { size: 34, family: D, weight: 700, anchor: 'end' });
    body += sparkline(col.spark - 66, y + 16, 120, 30, p.ratingHistory.slice(-15));
    body += text(col.games, y + 41, `${p.wins}–${p.losses}`, { size: 26, family: D, weight: 600, anchor: 'end' });
    body += text(col.wr, y + 41, pct(p.winrate), { size: 26, family: D, weight: 600 });
    body += bar(col.wr + 64, y + 26, 90, 10, p.winrate ?? 0, p.winrate >= 0.5 ? C.good : C.text);
    body += text(col.kda, y + 41, dec(p.kda), { size: 26, family: D, weight: 600, anchor: 'end' });
    body += formSquares(col.form + 10, y + 21, p.form.slice(-5), 16, 6);
    if (!rank) body += '</g>';
  });
  if (!rows.length) body += text(W / 2, top + 40, 'Zatím nikdo nemá dohraný zápas.', { size: 28, fill: C.muted, anchor: 'middle' });
  const fy = top + Math.max(1, rows.length) * rowH + 46;
  body += text(48, fy, `${totals.matches} ${totals.matches === 1 ? 'zápas' : totals.matches < 5 ? 'zápasy' : 'zápasů'} · modrá strana vyhrála ${pct(totals.matches ? totals.blueWins / totals.matches : null)}`, { size: 22, fill: C.muted });
  if (minRanked) body += text(W - 48, fy, `– = méně než ${minRanked} her, rating je zatím orientační`, { size: 22, fill: C.muted, anchor: 'end' });
  return toPng(frame(h, body));
}

/* ================= profil ================= */
function ratingChart(x, y, w, h, history, wins) {
  if (history.length < 2) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.panel}"/>` +
      text(x + w / 2, y + h / 2 + 10, 'Graf ratingu se ukáže po prvním zápase.', { size: 24, fill: C.muted, anchor: 'middle' });
  }
  const padL = 64, padR = 20, padT = 24, padB = 28;
  const min = Math.min(...history), max = Math.max(...history);
  const stp = [25, 50, 100, 200].find((st) => (max - min + 20) / st <= 5) || 250;
  const lo = Math.floor((min - 10) / stp) * stp, hi = Math.ceil((max + 10) / stp) * stp;
  const px = (i) => x + padL + (i / (history.length - 1)) * (w - padL - padR);
  const py = (v) => y + padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.panel}"/>`;
  for (let v = lo; v <= hi; v += stp) {
    const yy = py(v);
    s += `<line x1="${x + padL}" x2="${x + w - padR}" y1="${yy}" y2="${yy}" stroke="${C.lineSoft}" stroke-width="1.5"/>`;
    s += text(x + padL - 12, yy + 7, String(v), { size: 20, fill: C.muted, anchor: 'end' });
  }
  const gid = id('area');
  const d = history.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(' ');
  s += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></linearGradient>`;
  s += `<path d="${d} L${px(history.length - 1)} ${y + h - padB} L${px(0)} ${y + h - padB} Z" fill="url(#${gid})"/>`;
  s += `<path d="${d}" fill="none" stroke="${C.text}" stroke-width="3" stroke-linejoin="round"/>`;
  if (history.length <= 40) {
    history.slice(1).forEach((v, i) => { s += `<circle cx="${px(i + 1)}" cy="${py(v)}" r="5" fill="${wins[i] ? C.good : C.bad}" stroke="${C.panel}" stroke-width="2"/>`; });
  }
  const peak = history.indexOf(max);
  s += text(px(peak), py(max) - 12, `max ${max}`, { size: 20, family: D, weight: 600, fill: C.gold, anchor: peak > history.length * 0.8 ? 'end' : 'middle' });
  return s;
}

function rankLine(p) {
  const TIER = { IRON: 'Iron', BRONZE: 'Bronze', SILVER: 'Silver', GOLD: 'Gold', PLATINUM: 'Platinum', EMERALD: 'Emerald', DIAMOND: 'Diamond', MASTER: 'Master', GRANDMASTER: 'Grandmaster', CHALLENGER: 'Challenger' };
  if (!p.rank || p.rank.tier === 'UNRANKED') return p.riotId || '';
  const t = TIER[p.rank.tier] || p.rank.tier;
  const r = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(p.rank.tier) ? `${t} ${p.rank.lp} LP` : `${t} ${p.rank.division}`;
  return p.riotId ? `${r} · ${p.riotId}` : r;
}

function profileHeader(p, icons) {
  let s = `<rect x="28" y="28" width="350" height="${0}" fill="none"/>`;
  s += avatar(48, 48, 112, icons.get(p.avatar), p.name, C.line);
  s += text(184, 100, p.name, { size: 54, family: D, weight: 700, maxW: 560 });
  const rl = rankLine(p);
  if (rl) s += text(186, 138, rl, { size: 24, fill: C.muted, maxW: 560 });
  s += text(W - 48, 108, String(p.rating), { size: 86, family: D, weight: 700, anchor: 'end' });
  s += text(W - 48, 140, p.provisional ? 'rating (nováček)' : `rating · max ${p.peak}`, { size: 22, fill: C.muted, anchor: 'end' });
  return s;
}

function statTiles(x, y, p) {
  const tiles = [
    { v: p.games ? `${p.wins}–${p.losses}` : '–', l: 'výhry a prohry' },
    { v: pct(p.winrate), l: 'winrate' },
    { v: p.avg ? `${dec(p.avg.k)}/${dec(p.avg.d)}/${dec(p.avg.a)}` : '–', l: p.kda ? `KDA ${dec(p.kda)}` : 'průměrné K/D/A' },
    { v: p.streak ? `${Math.abs(p.streak)}${p.streak > 0 ? 'W' : 'L'}` : '–', l: 'série', c: p.streak > 1 ? C.good : p.streak < -1 ? C.bad : C.text },
  ];
  const tw = (W - 96 - 3 * 16) / 4;
  return tiles.map((t, i) => {
    const tx = x + i * (tw + 16);
    return `<rect x="${tx}" y="${y}" width="${tw}" height="96" rx="14" fill="${C.panel}"/>` +
      text(tx + 22, y + 52, t.v, { size: 44, family: D, weight: 700, fill: t.c || C.text, maxW: tw - 40 }) +
      text(tx + 22, y + 82, t.l, { size: 21, fill: C.muted });
  }).join('');
}

async function profileOverview(p, champIconUrl) {
  const champs = p.champs.slice(0, 4);
  const icons = await loadAll([p.avatar, p.bestDuo?.avatar, p.nemesis?.avatar, ...champs.map((c) => champIconUrl(c.name))]);
  const h = 960;
  let body = profileHeader(p, icons);
  body += statTiles(48, 184, p);
  body += ratingChart(48, 300, W - 96, 250, p.ratingHistory, p.history.map((x) => x.won));

  // role
  const ry = 590;
  body += text(48, ry + 26, 'Role', { size: 30, family: D, weight: 700 });
  ROLES.forEach((r, i) => {
    const st = p.roleStats[r];
    const yy = ry + 50 + i * 46;
    const wr = st.games ? st.wins / st.games : null;
    body += roleGlyph(r, 48, yy, 30);
    body += text(92, yy + 23, ROLE_LABEL[r], { size: 24, family: D, weight: 600 });
    body += bar(186, yy + 10, 170, 12, wr ?? 0, wr === null ? C.lineSoft : wr >= 0.5 ? C.good : C.text);
    body += text(372, yy + 23, st.games ? `${pct(wr)} z ${st.games}` : '–', { size: 21, fill: C.muted });
    const pref = { 2: 'main', 1: '', 0: 'nehraje' }[p.roles[r] ?? 1];
    if (pref) body += text(530, yy + 23, pref, { size: 21, fill: pref === 'main' ? C.gold : C.muted, anchor: 'end' });
  });

  // championi
  const cx = 580;
  body += text(cx, ry + 26, 'Championi', { size: 30, family: D, weight: 700 });
  if (!champs.length) body += text(cx, ry + 74, 'Zatím nezapsaní.', { size: 22, fill: C.muted });
  champs.forEach((c, i) => {
    const yy = ry + 46 + i * 58;
    body += champIcon(cx, yy, 48, icons.get(champIconUrl(c.name)), c.name);
    body += text(cx + 62, yy + 22, c.name, { size: 26, family: D, weight: 600, maxW: 150 });
    body += text(cx + 62, yy + 45, `${c.games} ${c.games === 1 ? 'hra' : c.games < 5 ? 'hry' : 'her'}${c.kda !== null ? ` · KDA ${dec(c.kda)}` : ''}`, { size: 19, fill: C.muted });
    body += text(cx + 300, yy + 34, pct(c.wins / c.games), { size: 28, family: D, weight: 700, fill: c.wins / c.games >= 0.5 ? C.good : C.text, anchor: 'end' });
  });

  // duo a nemesis
  const dx = 920;
  const person = (label, o, yy, good) => {
    body += text(dx, yy, label, { size: 22, fill: C.muted });
    if (!o) { body += text(dx, yy + 40, 'zatím málo her', { size: 22, fill: C.muted }); return; }
    body += avatar(dx, yy + 14, 52, icons.get(o.avatar), o.name);
    body += text(dx + 66, yy + 42, o.name, { size: 28, family: D, weight: 700, maxW: 170 });
    body += text(dx + 66, yy + 66, `${o.wins}–${o.games - o.wins} · ${pct(o.winrate)}`, { size: 20, fill: good ? C.good : C.bad });
  };
  body += text(dx, ry + 26, 'Spoluhráči', { size: 30, family: D, weight: 700 });
  person('Nejlepší parťák', p.bestDuo, ry + 74, true);
  person('Nemesis', p.nemesis, ry + 182, false);

  if (p.form.length) {
    body += text(48, h - 40, 'Forma', { size: 22, fill: C.muted });
    body += formSquares(120, h - 60, p.form, 16, 6);
    body += text(120 + p.form.length * 22 + 12, h - 40, 'od nejstaršího po poslední', { size: 20, fill: C.muted });
  }
  return toPng(frame(h, body));
}

async function profileMatches(p, champIconUrl) {
  const list = p.history.slice(-8).reverse();
  const icons = await loadAll([p.avatar, ...list.map((m) => champIconUrl(m.champion))]);
  const top = 236, rowH = 72;
  const h = top + Math.max(1, list.length) * rowH + 50;
  let body = profileHeader(p, icons);
  body += text(48, top - 22, 'Poslední zápasy', { size: 30, family: D, weight: 700 });
  if (!list.length) body += text(48, top + 40, 'Zatím žádný dohraný zápas.', { size: 24, fill: C.muted });
  const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${d.getDate()}. ${d.getMonth() + 1}.`; };
  list.forEach((m, i) => {
    const y = top + i * rowH;
    if (i % 2 === 0) body += `<rect x="28" y="${y}" width="${W - 56}" height="${rowH}" rx="10" fill="${C.panel}"/>`;
    body += `<rect x="48" y="${y + 18}" width="110" height="36" rx="18" fill="${m.won ? C.good : C.bad}" opacity="0.18"/>`;
    body += text(103, y + 44, m.won ? 'Výhra' : 'Prohra', { size: 26, family: D, weight: 700, fill: m.won ? C.good : C.bad, anchor: 'middle' });
    if (m.role) { body += roleGlyph(m.role, 186, y + 18, 36); body += text(234, y + 46, ROLE_LABEL[m.role], { size: 26, family: D, weight: 600 }); }
    body += champIcon(380, y + 10, 52, icons.get(champIconUrl(m.champion)), m.champion);
    body += text(448, y + 46, m.champion || 'champion nezapsaný', { size: 28, family: D, weight: 600, fill: m.champion ? C.text : C.muted, maxW: 260 });
    body += text(820, y + 46, m.kills !== null ? `${m.kills} / ${m.deaths} / ${m.assists}` : '–', { size: 28, family: D, weight: 600, anchor: 'end' });
    const dl = Math.round(m.delta);
    body += text(960, y + 46, signed(dl), { size: 30, family: D, weight: 700, fill: dl >= 0 ? C.good : C.bad, anchor: 'end' });
    body += text(W - 48, y + 46, `#${m.matchId} · ${fmtDate(m.playedAt)}`, { size: 22, fill: C.muted, anchor: 'end' });
  });
  return toPng(frame(h, body));
}

async function profilePeople(p) {
  const mates = p.teammates.slice(0, 7), opps = p.opponents.slice(0, 7);
  const icons = await loadAll([p.avatar, ...mates.map((x) => x.avatar), ...opps.map((x) => x.avatar)]);
  const top = 246, rowH = 64;
  const h = top + Math.max(1, mates.length, opps.length) * rowH + 50;
  let body = profileHeader(p, icons);
  const col = (x, title, list, sub) => {
    body += text(x, top - 26, title, { size: 30, family: D, weight: 700 });
    body += text(x + 520, top - 26, sub, { size: 20, fill: C.muted, anchor: 'end' });
    if (!list.length) body += text(x, top + 34, 'Zatím nikdo.', { size: 24, fill: C.muted });
    list.forEach((o, i) => {
      const y = top + i * rowH;
      if (i % 2 === 0) body += `<rect x="${x - 12}" y="${y}" width="544" height="${rowH}" rx="10" fill="${C.panel}"/>`;
      body += avatar(x, y + 10, 44, icons.get(o.avatar), o.name);
      body += text(x + 58, y + 42, o.name, { size: 30, family: D, weight: 600, maxW: 190 });
      body += text(x + 300, y + 42, `${o.wins}–${o.games - o.wins}`, { size: 26, family: D, weight: 600, anchor: 'end' });
      body += bar(x + 320, y + 26, 110, 12, o.winrate, o.winrate >= 0.5 ? C.good : C.bad);
      body += text(x + 520, y + 42, pct(o.winrate), { size: 26, family: D, weight: 700, anchor: 'end' });
    });
  };
  col(60, 'Se spoluhráči', mates, 'tvoje výhry a prohry');
  col(640, 'Proti soupeřům', opps, 'tvoje výhry a prohry');
  return toPng(frame(h, body));
}

/* ================= vývoj ratingu všech ================= */
async function ratingRace(players, totalMatches) {
  const h = 660;
  const x0 = 100, x1 = W - 200, y0 = 120, y1 = h - 70;
  let body = text(48, 80, 'Vývoj ratingu', { size: 56, family: D, weight: 700 });
  body += text(W - 48, 76, `${totalMatches} ${totalMatches === 1 ? 'zápas' : totalMatches < 5 ? 'zápasy' : 'zápasů'}`, { size: 24, fill: C.muted, anchor: 'end' });
  const series = players.map((p, i) => {
    const pts = [{ idx: -1, r: p.ratingHistory[0] }, ...p.history.map((hh, k) => ({ idx: hh.idx, r: p.ratingHistory[k + 1] }))];
    return { p, pts, color: SERIES[i % SERIES.length] };
  });
  const all = series.flatMap((s) => s.pts.map((q) => q.r));
  if (!all.length || totalMatches < 1) {
    body += text(W / 2, h / 2, 'Graf se ukáže po prvním dohraném zápase.', { size: 28, fill: C.muted, anchor: 'middle' });
    return toPng(frame(h, body));
  }
  const span = Math.max(...all) - Math.min(...all) + 20;
  const step = [25, 50, 100, 200].find((st) => span / st <= 6) || 250;
  const lo = Math.floor((Math.min(...all) - 10) / step) * step, hi = Math.ceil((Math.max(...all) + 10) / step) * step;
  const px = (idx) => x0 + ((idx + 1) / Math.max(1, totalMatches)) * (x1 - x0);
  const py = (v) => y0 + (1 - (v - lo) / (hi - lo)) * (y1 - y0);
  for (let v = lo; v <= hi; v += step) {
    const yy = py(v);
    body += `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" stroke="${C.lineSoft}" stroke-width="1.5"/>`;
    body += text(x0 - 14, yy + 7, String(v), { size: 20, fill: C.muted, anchor: 'end' });
  }
  body += text(x0, h - 30, 'start', { size: 20, fill: C.muted });
  body += text(x1, h - 30, 'poslední zápas', { size: 20, fill: C.muted, anchor: 'end' });
  const labels = [];
  for (const s of series) {
    const d = s.pts.map((q, i) => `${i ? 'L' : 'M'}${px(q.idx).toFixed(1)} ${py(q.r).toFixed(1)}`).join(' ');
    body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = s.pts[s.pts.length - 1];
    body += `<circle cx="${px(last.idx)}" cy="${py(last.r)}" r="6" fill="${s.color}"/>`;
    labels.push({ y: py(last.r), x: px(last.idx), s, r: last.r });
  }
  // popisky na konci čar bez překryvu
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 34) labels[i].y = labels[i - 1].y + 34;
  const overflow = labels.length ? labels[labels.length - 1].y - y1 : 0;
  if (overflow > 0) labels.forEach((l) => { l.y -= overflow; });
  for (const l of labels) {
    const lx = x1 + 20;
    body += `<line x1="${l.x + 8}" x2="${lx - 4}" y1="${py(l.r)}" y2="${l.y}" stroke="${l.s.color}" stroke-width="1.5" opacity="0.6"/>`;
    body += text(lx, l.y + 8, `${l.s.p.name}`, { size: 26, family: D, weight: 700, fill: l.s.color, maxW: 120 });
    body += text(W - 30, l.y + 8, String(l.r), { size: 22, family: D, weight: 600, fill: C.muted, anchor: 'end' });
  }
  return toPng(frame(h, body));
}

/* ================= hráč proti hráči ================= */
async function vsCard(a, b, h2h) {
  const icons = await loadAll([a.avatar, b.avatar]);
  const h = 640;
  let body = '';
  body += avatar(60, 48, 120, icons.get(a.avatar), a.name, C.blue);
  body += avatar(W - 180, 48, 120, icons.get(b.avatar), b.name, C.red);
  body += text(200, 118, a.name, { size: 56, family: D, weight: 700, maxW: 360 });
  body += text(W - 200, 118, b.name, { size: 56, family: D, weight: 700, anchor: 'end', maxW: 360 });
  body += text(W / 2, 122, 'vs', { size: 44, family: D, weight: 600, fill: C.muted, anchor: 'middle' });
  const rows = [
    ['Rating', a.rating, b.rating, (v) => String(v)],
    ['Winrate', a.winrate, b.winrate, pct],
    ['KDA', a.kda, b.kda, dec],
    ['Zápasy', a.games, b.games, (v) => String(v)],
    ['Forma (10)', a.recentWinrate, b.recentWinrate, pct],
  ];
  rows.forEach(([label, va, vb, f], i) => {
    const y = 220 + i * 62;
    body += `<rect x="40" y="${y - 40}" width="${W - 80}" height="54" rx="10" fill="${i % 2 ? 'none' : C.panel}"/>`;
    body += text(W / 2, y - 4, label, { size: 24, fill: C.muted, anchor: 'middle' });
    const aw = va !== null && vb !== null && va > vb, bw = va !== null && vb !== null && vb > va;
    body += text(W / 2 - 150, y - 2, f(va), { size: 36, family: D, weight: 700, fill: aw ? C.blue : C.text, anchor: 'end' });
    body += text(W / 2 + 150, y - 2, f(vb), { size: 36, family: D, weight: 700, fill: bw ? C.red : C.text });
    const max = Math.max(va || 0, vb || 0) || 1, maxBar = W / 2 - 280 - 64;
    const wa = maxBar * ((va || 0) / max), wb = maxBar * ((vb || 0) / max);
    body += `<rect x="${W / 2 - 280 - wa}" y="${y - 22}" width="${wa}" height="12" rx="6" fill="${C.blue}" opacity="${aw ? 1 : 0.35}"/>`;
    body += `<rect x="${W / 2 + 280}" y="${y - 22}" width="${wb}" height="12" rx="6" fill="${C.red}" opacity="${bw ? 1 : 0.35}"/>`;
  });
  const y = 540;
  const tw = (W - 96 - 16) / 2;
  const tile = (x, title, main, sub, color) => `<rect x="${x}" y="${y - 30}" width="${tw}" height="110" rx="14" fill="${C.panel}"/>` +
    text(x + 24, y + 4, title, { size: 22, fill: C.muted }) + text(x + 24, y + 54, main, { size: 42, family: D, weight: 700, fill: color || C.text }) +
    text(x + tw - 24, y + 54, sub, { size: 22, fill: C.muted, anchor: 'end' });
  body += tile(48, 'Spolu v týmu', h2h.together.games ? `${h2h.together.wins}–${h2h.together.games - h2h.together.wins}` : '–',
    h2h.together.games ? `${pct(h2h.together.wins / h2h.together.games)} výher` : 'ještě spolu nehráli');
  body += tile(64 + tw, 'Proti sobě', h2h.against.games ? `${h2h.against.wins} : ${h2h.against.games - h2h.against.wins}` : '–',
    h2h.against.games ? `${a.name.split(' ')[0]} : ${b.name.split(' ')[0]}` : 'ještě proti sobě nehráli');
  return toPng(frame(h, body));
}

module.exports = { versusCard, leaderboardCard, profileOverview, profileMatches, profilePeople, ratingRace, vsCard, setCacheDir, loadImage };
