// Discord bot na LoL scrimy: losování z hlasu, výsledky, rating, statistiky s obrázky
'use strict';

const crypto = require('node:crypto');
const {
  Client, GatewayIntentBits, Events, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
  MessageFlags, InteractionContextType, AttachmentBuilder,
} = require('discord.js');
const ScrimRoll = require('./roll.js');
const render = require('./render.js');
const { UserError, PROVISIONAL_GAMES } = require('./db.js');

const ROLE_LABEL = { top: 'Top', jungle: 'Jungle', mid: 'Mid', adc: 'ADC', support: 'Support' };
const PREF_LABEL = { 2: 'Main', 1: 'Jde to', 0: 'Ne' };
const COLOR = { blue: 0x3D8BFF, red: 0xF2554A, neutral: 0x22405A, gold: 0xD9B45A };
const TIER_NAME = { IRON: 'Iron', BRONZE: 'Bronze', SILVER: 'Silver', GOLD: 'Gold', PLATINUM: 'Platinum', EMERALD: 'Emerald',
  DIAMOND: 'Diamond', MASTER: 'Master', GRANDMASTER: 'Grandmaster', CHALLENGER: 'Challenger' };
const SORTS = {
  rating: { label: 'Rating', fn: (a, b) => b.rating - a.rating },
  winrate: { label: 'Winrate', fn: (a, b) => (b.winrate ?? -1) - (a.winrate ?? -1) || b.games - a.games },
  kda: { label: 'KDA', fn: (a, b) => (b.kda ?? -1) - (a.kda ?? -1) || b.games - a.games },
  games: { label: 'Počet zápasů', fn: (a, b) => b.games - a.games || b.rating - a.rating },
  form: { label: 'Forma (posledních 10)', fn: (a, b) => (b.recentWinrate ?? -1) - (a.recentWinrate ?? -1) || b.streak - a.streak },
};
const PAGE = 8;
const EPHEMERAL = MessageFlags.Ephemeral;
// Zobrazit kanál, Posílat zprávy, Vkládat odkazy, Přikládat soubory, Připojit se, Přesouvat členy
const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 32768 + 1048576 + 16777216;

function createBot(store) {
  const { ROLES } = store;

  /* ================= pomocné ================= */
  const humans = (channel) => [...channel.members.values()].filter((m) => !m.user.bot);
  const memberName = (m) => m.displayName || m.user?.globalName || m.user?.username || 'Hráč';
  const memberAvatar = (m) => {
    const o = { extension: 'png', size: 128 };
    try {
      if (typeof m.displayAvatarURL === 'function') return m.displayAvatarURL(o);
      if (typeof m.user?.displayAvatarURL === 'function') return m.user.displayAvatarURL(o);
    } catch { /* bez avataru */ }
    return null;
  };
  const ensure = (m) => store.ensurePlayer(m.id, memberName(m), memberAvatar(m));
  const isFake = (id) => String(id || '').startsWith('fake-');
  const who = (p) => (p.discordId && !isFake(p.discordId) ? `<@${p.discordId}>` : `**${p.name}**`);
  // Testovací režim: DEV_FAKE_PLAYERS=9 doplní do losování falešné hráče, ať jde bot zkoušet o samotě
  const FAKE = Math.max(0, Math.min(9, Number(process.env.DEV_FAKE_PLAYERS || 0)));
  const fakePlayers = (n) => Array.from({ length: n }, (_, k) => {
    const r = store.ensurePlayer(`fake-${k + 1}`, `Testovací ${k + 1}`, null);
    if (r.created) return store.updatePlayer(r.player.id, { baseRating: 850 + ((k * 73) % 300) });
    return r.player;
  });
  const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? '–' : `${Math.round(x * 100)} %`);
  const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
  const isManager = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const rankText = (rank) => {
    if (!rank) return null;
    if (rank.tier === 'UNRANKED') return 'bez ranku';
    const t = TIER_NAME[rank.tier] || rank.tier;
    return ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rank.tier) ? `${t} ${rank.lp} LP` : `${t} ${rank.division} ${rank.lp} LP`;
  };
  const stamp = () => `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const image = (buf, base) => { const name = `${base}-${stamp()}.png`; return { file: new AttachmentBuilder(buf, { name }), url: `attachment://${name}` }; };
  const withImage = (embed, img, components) => ({ embeds: [embed.setImage(img.url)], files: [img.file], attachments: [], components, content: '' });
  const btn = (customId, label, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);

  // Odpověď, která chvíli trvá (obrázek, avatary): nejdřív potvrdit Discordu, pak doplnit.
  async function deferReply(i, ephemeral = false) { i.__mode = 'reply'; await i.deferReply(ephemeral ? { flags: EPHEMERAL } : {}); }
  async function deferUpdate(i) { i.__mode = 'update'; await i.deferUpdate(); }

  /* ================= losování ================= */
  function newSession(data) {
    const s = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), created: [], matchId: null, roll: null, seriesId: null, ...data };
    return s;
  }
  const getSession = (id) => {
    const s = store.loadSession(id);
    if (!s) throw new UserError('Tohle losování už vypršelo. Dej `/scrim` znovu.');
    return s;
  };

  function doRoll(s) {
    s.roll = s.mode === 'fixed'
      ? ScrimRoll.assignRoles(s.blueTeam, s.redTeam, { ...s.opts, prevRoles: s.prevRoles })
      : ScrimRoll.roll(s.players, { ...s.opts, lastKey: s.roll?.key, avoidPairs: store.recentTeammatePairs(s.guildId, 2) });
  }

  function provisionalSet(guildId) {
    return new Set(store.computeStats(guildId).players.filter((p) => p.games < PROVISIONAL_GAMES).map((p) => p.id));
  }

  async function rollMessage(s) {
    let prov = provisionalSet(s.guildId);
    const lineup = [...s.roll.blue, ...s.roll.red];
    // štítek nováček má smysl, jen když nováčci nejsou většina (jinak by ho měl první večer každý)
    if (lineup.filter((x) => prov.has(x.player.id)).length * 2 > lineup.length) prov = new Set();
    const side = (t) => t.map((x) => ({ name: x.player.name, avatar: x.player.avatar, role: x.role, rating: x.player.rating,
      pref: x.pref, provisional: prov.has(x.player.id) }));
    const sc = store.seriesScore(s.seriesId);
    const series = sc && sc.games ? ` · série ${sc.blue} : ${sc.red}` : '';
    const title = s.matchId ? `Zápas #${s.matchId} běží${series}`
      : sc && sc.games ? `Hra ${sc.games + 1}, stejné týmy${series}`
      : s.mode === 'fixed' ? (s.fromChannels ? 'Týmy podle kanálů' : 'Vaše rozdělení')
      : s.opts.teams === 'balanced' ? 'Vyrovnané týmy podle ratingu' : 'Náhodné týmy';
    const buf = await render.versusCard({ title, blue: side(s.roll.blue), red: side(s.roll.red),
      bench: s.roll.bench.map((p) => p.name), odds: ScrimRoll.odds(s.roll.blue, s.roll.red).pBlue });
    const img = image(buf, 'losovani');
    const lines = [`🔵 ${s.roll.blue.map((x) => who(x.player)).join(' ')}`, `🔴 ${s.roll.red.map((x) => who(x.player)).join(' ')}`];
    if (s.created.length) lines.push(`\nNoví hráči ${s.created.map(who).join(', ')}: nastavte si role přes \`/role\`.`);
    const embed = new EmbedBuilder().setColor(s.matchId ? COLOR.gold : COLOR.neutral).setDescription(lines.join('\n'))
      .setFooter({ text: s.matchId ? 'Po hře klikněte, kdo vyhrál.'
        : s.mode === 'fixed' ? `Týmy zůstávají, Přelosovat mění jen role. Role: ${s.opts.roles === 'random' ? 'náhodně, bez opakování z minulé hry' : 'podle preferencí'}.`
        : 'Přelosujte, dokud vám sestava nesedí, nebo se rozdělte sami v menu. Pak Hrajeme.' });
    let components;
    if (s.matchId) {
      components = [new ActionRowBuilder().addComponents(
        btn(`scrim:win:${s.matchId}:blue`, 'Vyhráli modří', ButtonStyle.Primary),
        btn(`scrim:win:${s.matchId}:red`, 'Vyhráli červení', ButtonStyle.Danger),
        btn(`scrim:void:${s.matchId}`, 'Zrušit zápas'),
      )];
    } else {
      const fixed = s.mode === 'fixed';
      const row = new ActionRowBuilder().addComponents(btn(`scrim:reroll:${s.id}`, fixed ? 'Přelosovat role' : 'Přelosovat týmy'));
      row.addComponents(btn(`scrim:rolemode:${s.id}`, s.opts.roles === 'random' ? 'Role podle preferencí' : 'Náhodné role'));
      if (!s.fromChannels) row.addComponents(btn(`scrim:move:${s.id}`, 'Rozházet do kanálů'));
      row.addComponents(btn(`scrim:save:${s.id}`, 'Hrajeme', ButtonStyle.Success));
      components = [row];
      // ruční rozdělení: vybere se modrý tým, zbytek jsou červení
      const pool = s.players.slice(0, 25);
      if (!(sc && sc.games) && pool.length >= 2) {
        const blueIds = new Set(s.roll.blue.map((x) => x.player.id));
        components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`split:${s.id}`)
          .setPlaceholder('Rozdělíme se sami: vyber modrý tým').setMinValues(1).setMaxValues(Math.min(5, pool.length - 1))
          .addOptions(pool.map((p) => ({ label: p.name.slice(0, 100), value: String(p.id), description: `rating ${p.rating}`,
            default: fixed && !s.fromChannels && blueIds.has(p.id) })))));
      }
    }
    return withImage(embed, img, components);
  }

  /* ================= výsledek ================= */
  async function resultMessage(m) {
    const side = (t) => t.map((x) => ({ name: x.name, avatar: x.avatar, role: x.role, rating: x.rating, champion: x.champion,
      championIcon: store.championIconUrl(x.champion), kills: x.kills, deaths: x.deaths, assists: x.assists, delta: x.ratingChange }));
    const sc = store.seriesScore(m.seriesId);
    const title = sc && sc.games > 1 ? `Zápas #${m.id} · série ${sc.blue} : ${sc.red}` : `Zápas #${m.id}`;
    const buf = await render.versusCard({ title, blue: side(m.blue), red: side(m.red), winner: m.winner });
    const img = image(buf, `zapas-${m.id}`);
    const all = [...m.blue, ...m.red];
    const missing = all.filter((x) => !x.champion && x.kills === null);
    const embed = new EmbedBuilder().setColor(m.winner === 'blue' ? COLOR.blue : COLOR.red)
      .setDescription(missing.length
        ? `Championa a K/D/A si každý zapíše tlačítkem **Moje statistiky**. Chybí: ${missing.map(who).join(' ')}`
        : 'Všechno zapsané. Celkové statistiky ukáže `/stats`.');
    const other = m.winner === 'blue' ? 'red' : 'blue';
    const lobby = store.getSetting(m.guildId, 'lobby_channel') || store.sessionForMatch(m.id)?.lobbyId;
    const row1 = new ActionRowBuilder().addComponents(
      btn(`scrim:kda:${m.id}`, 'Moje statistiky', ButtonStyle.Primary),
      btn(`scrim:rematch:${m.id}`, 'Stejné týmy, nové role', ButtonStyle.Success),
      btn(`scrim:next:${m.id}`, 'Nové týmy'),
    );
    const row2 = new ActionRowBuilder();
    if (lobby) row2.addComponents(btn(`scrim:back:${m.id}:${lobby}`, 'Všichni zpátky do lobby'));
    row2.addComponents(btn(`scrim:win:${m.id}:${other}`, `Oprava: vyhráli ${other === 'blue' ? 'modří' : 'červení'}`));
    return withImage(embed, img, [row1, row2]);
  }

  function kdaModal(m, me) {
    const champ = new TextInputBuilder().setCustomId('champion').setLabel('Champion').setStyle(TextInputStyle.Short)
      .setMaxLength(30).setRequired(false).setPlaceholder('Yone');
    const kda = new TextInputBuilder().setCustomId('kda').setLabel('K/D/A').setStyle(TextInputStyle.Short)
      .setMaxLength(12).setRequired(false).setPlaceholder('7/2/4');
    if (me.champion) champ.setValue(me.champion);
    if (me.kills !== null) kda.setValue(`${me.kills}/${me.deaths}/${me.assists}`);
    return new ModalBuilder().setCustomId(`kda:${m.id}`).setTitle(`Zápas #${m.id}, ${ROLE_LABEL[me.role] || 'tvoje hra'}`)
      .addComponents(new ActionRowBuilder().addComponents(champ), new ActionRowBuilder().addComponents(kda));
  }

  function parseKda(s) {
    const t = String(s || '').trim();
    if (!t) return { kills: null, deaths: null, assists: null };
    const m = t.match(/^(\d{1,2})\s*[/\-, ]\s*(\d{1,2})\s*[/\-, ]\s*(\d{1,2})$/);
    if (!m) throw new UserError(`„${t}“ nevypadá jako K/D/A. Napiš to jako 7/2/4.`);
    return { kills: +m[1], deaths: +m[2], assists: +m[3] };
  }

  /* ================= žebříček ================= */
  // Kdo má málo her, nemá zatím pořadí: je vidět, ale řadí se až pod ostatní.
  // Když hranici nesplňuje nikdo (první večery), řadí se normálně všichni.
  const MIN_RANKED = Math.max(0, Number(process.env.MIN_GAMES_RANKED ?? 10));
  function rankedPlayers(stats, sort) {
    const fn = SORTS[sort]?.fn || SORTS.rating.fn;
    const all = stats.players.filter((p) => p.games && p.active);
    const ranked = all.filter((p) => p.games >= MIN_RANKED).sort(fn);
    if (!ranked.length) return all.sort(fn).map((p, i) => ({ ...p, rankNo: i + 1 }));
    const rest = all.filter((p) => p.games < MIN_RANKED).sort(fn);
    return [...ranked.map((p, i) => ({ ...p, rankNo: i + 1 })), ...rest.map((p) => ({ ...p, rankNo: null }))];
  }

  function playerPicker(players, selectedId, placeholder = 'Profil hráče') {
    const list = players.slice(0, 25);
    if (!list.length) return null;
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('pfpick').setPlaceholder(placeholder)
      .addOptions(list.map((p) => ({ label: p.name.slice(0, 100), value: String(p.id),
        description: `rating ${p.rating}${p.games ? `, ${plural(p.games, 'zápas', 'zápasy', 'zápasů')}` : ''}`, default: p.id === selectedId }))));
  }

  async function leaderboardMessage(guildId, sort = 'rating', page = 0) {
    const stats = store.computeStats(guildId);
    const list = rankedPlayers(stats, sort);
    if (!list.length) {
      return { content: '', files: [], attachments: [], components: [], embeds: [new EmbedBuilder().setColor(COLOR.neutral).setTitle('Žebříček')
        .setDescription('Zatím žádný dohraný zápas. Dejte `/scrim`, zahrajte a klikněte, kdo vyhrál.')] };
    }
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.max(0, Math.min(pages - 1, page));
    const rows = list.slice(page * PAGE, page * PAGE + PAGE);
    const buf = await render.leaderboardCard({ rows, page, pages, sort, totals: stats.totals,
      minRanked: list.some((p) => p.rankNo === null) ? MIN_RANKED : 0 });
    const img = image(buf, 'zebricek');
    const embed = new EmbedBuilder().setColor(COLOR.neutral)
      .setFooter({ text: 'Vyber hráče pro detail, nebo přepni řazení.' });
    const sortRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`lbsort`).setPlaceholder('Řadit podle')
      .addOptions(Object.entries(SORTS).map(([k, v]) => ({ label: `Řadit: ${v.label}`, value: k, default: k === sort }))));
    const nav = new ActionRowBuilder().addComponents(
      btn(`lb:${sort}:${page - 1}:prev`, '◀ Předchozí', ButtonStyle.Secondary, page === 0),
      btn(`lb:${sort}:${page + 1}:next`, 'Další ▶', ButtonStyle.Secondary, page >= pages - 1),
      btn('graf:open', 'Graf ratingu', ButtonStyle.Primary),
    );
    return withImage(embed, img, [sortRow, playerPicker(rows), nav].filter(Boolean));
  }

  /* ================= profil ================= */
  const TABS = { prehled: 'Přehled', zapasy: 'Zápasy', lide: 'Spoluhráči' };
  async function profileMessage(guildId, playerId, tab = 'prehled') {
    const stats = store.computeStats(guildId);
    const p = stats.players.find((x) => x.id === playerId);
    if (!p) throw new UserError('Tenhle hráč neexistuje.');
    const buf = tab === 'zapasy' ? await render.profileMatches(p, store.championIconUrl)
      : tab === 'lide' ? await render.profilePeople(p)
      : await render.profileOverview(p, store.championIconUrl);
    const img = image(buf, `profil-${p.id}`);
    const embed = new EmbedBuilder().setColor(COLOR.neutral)
      .setDescription(`${who(p)}${p.rank && rankText(p.rank) ? ` · ${rankText(p.rank)}` : ''}${p.riotId ? ` · \`${p.riotId}\`` : ''}`);
    if (!p.games) embed.setFooter({ text: 'Zatím bez dohraného zápasu. Statistiky naskočí po první hře.' });
    const tabs = new ActionRowBuilder().addComponents(
      ...Object.entries(TABS).map(([k, v]) => btn(`pf:${p.id}:${k}`, v, k === tab ? ButtonStyle.Primary : ButtonStyle.Secondary, k === tab)),
      btn('lb:rating:0:back', 'Žebříček'),
    );
    const others = stats.players.filter((x) => x.games && x.active);
    if (!others.some((x) => x.id === p.id)) others.unshift(p);
    return withImage(embed, img, [tabs, playerPicker(others, p.id, 'Jiný hráč')].filter(Boolean));
  }

  /* ================= graf a srovnání ================= */
  async function graphMessage(guildId, ids) {
    const stats = store.computeStats(guildId);
    const played = stats.players.filter((p) => p.games && p.active).sort((a, b) => b.games - a.games || b.rating - a.rating);
    if (!played.length) throw new UserError('Graf se ukáže po prvním dohraném zápase.');
    let chosen = ids?.length ? ids.map((id) => played.find((p) => p.id === id)).filter(Boolean) : played.slice(0, 6);
    if (!chosen.length) chosen = played.slice(0, 6);
    chosen.sort((a, b) => b.rating - a.rating);
    const buf = await render.ratingRace(chosen, stats.matchCount);
    const img = image(buf, 'graf');
    const embed = new EmbedBuilder().setColor(COLOR.neutral).setFooter({ text: 'V menu vyber až šest hráčů, které chceš porovnat.' });
    const pick = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('grafpick')
      .setPlaceholder('Vybrat hráče do grafu').setMinValues(1).setMaxValues(Math.min(6, played.slice(0, 25).length))
      .addOptions(played.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: String(p.id), default: chosen.some((c) => c.id === p.id) }))));
    const nav = new ActionRowBuilder().addComponents(btn('lb:rating:0:back', 'Žebříček'));
    return withImage(embed, img, [pick, nav]);
  }

  async function vsMessage(guildId, aId, bId) {
    const stats = store.computeStats(guildId);
    const a = stats.players.find((x) => x.id === aId), b = stats.players.find((x) => x.id === bId);
    const together = a.teammates.find((x) => x.id === b.id) || { games: 0, wins: 0 };
    const against = a.opponents.find((x) => x.id === b.id) || { games: 0, wins: 0 };
    const buf = await render.vsCard(a, b, { together, against });
    const img = image(buf, 'vs');
    const embed = new EmbedBuilder().setColor(COLOR.neutral).setDescription(`${who(a)} vs ${who(b)}`);
    const row = new ActionRowBuilder().addComponents(btn(`pf:${a.id}:prehled`, `Profil: ${a.name}`.slice(0, 80)), btn(`pf:${b.id}:prehled`, `Profil: ${b.name}`.slice(0, 80)));
    return withImage(embed, img, [row]);
  }

  /* ================= role ================= */
  function roleMenus(player) {
    return ROLES.map((r) => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`role:${r}`).setPlaceholder(ROLE_LABEL[r]).addOptions(
        [2, 1, 0].map((v) => ({ label: `${ROLE_LABEL[r]}: ${PREF_LABEL[v]}`, value: String(v), default: (player.roles[r] ?? 1) === v })),
      ),
    ));
  }

  /* ================= příkazy ================= */
  const guildOnly = [InteractionContextType.Guild];
  const commands = [
    new SlashCommandBuilder().setName('scrim').setDescription('Rozlosuje týmy a role z lidí v hlasovém kanálu').setContexts(guildOnly)
      .addStringOption((o) => o.setName('tymy').setDescription('Jak rozdělit týmy')
        .addChoices({ name: 'Vyrovnané podle ratingu', value: 'balanced' }, { name: 'Úplně náhodně', value: 'random' }))
      .addStringOption((o) => o.setName('role').setDescription('Jak rozdat role')
        .addChoices({ name: 'Podle preferencí hráčů', value: 'prefs' }, { name: 'Náhodně', value: 'random' }))
      .addChannelOption((o) => o.setName('modri').setDescription('Už jste rozdělení? Kanál modrého týmu').addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName('cerveni').setDescription('Kanál červeného týmu').addChannelTypes(ChannelType.GuildVoice)),
    new SlashCommandBuilder().setName('role').setDescription('Nastav si, které role hraješ').setContexts(guildOnly),
    new SlashCommandBuilder().setName('stats').setDescription('Žebříček s grafy, nebo profil jednoho hráče').setContexts(guildOnly)
      .addUserOption((o) => o.setName('hrac').setDescription('Čí profil ukázat'))
      .addStringOption((o) => o.setName('razeni').setDescription('Jak seřadit žebříček')
        .addChoices(...Object.entries(SORTS).map(([k, v]) => ({ name: v.label, value: k })))),
    new SlashCommandBuilder().setName('profil').setDescription('Tvůj profil: rating, role, championi, spoluhráči').setContexts(guildOnly)
      .addUserOption((o) => o.setName('hrac').setDescription('Čí profil (výchozí tvůj)')),
    new SlashCommandBuilder().setName('graf').setDescription('Graf vývoje ratingu').setContexts(guildOnly),
    new SlashCommandBuilder().setName('vs').setDescription('Porovná dva hráče: statistiky, spolu, proti sobě').setContexts(guildOnly)
      .addUserOption((o) => o.setName('hrac').setDescription('S kým se porovnat').setRequired(true))
      .addUserOption((o) => o.setName('druhy').setDescription('Druhý hráč (výchozí ty)')),
    new SlashCommandBuilder().setName('riot').setDescription('Propojí tvůj Riot účet a načte rank').setContexts(guildOnly)
      .addStringOption((o) => o.setName('riot_id').setDescription('Jméno#TAG, třeba Hráč#EUNE').setRequired(true).setMaxLength(40)),
    new SlashCommandBuilder().setName('zapas').setDescription('Přehled a správa zápasů').setContexts(guildOnly)
      .addSubcommand((c) => c.setName('posledni').setDescription('Posledních 10 zápasů'))
      .addSubcommand((c) => c.setName('ukaz').setDescription('Výsledková karta zápasu')
        .addIntegerOption((o) => o.setName('id').setDescription('Číslo zápasu').setRequired(true).setMinValue(1)))
      .addSubcommand((c) => c.setName('smazat').setDescription('Smaže zápas (jen správce)')
        .addIntegerOption((o) => o.setName('id').setDescription('Číslo zápasu').setRequired(true).setMinValue(1))),
    new SlashCommandBuilder().setName('hrac').setDescription('Upraví hráče (jen správce)').setContexts(guildOnly)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('uzivatel').setDescription('Koho upravit').setRequired(true))
      .addIntegerOption((o) => o.setName('rating').setDescription('Výchozí rating (1000 ≈ Silver IV)').setMinValue(0).setMaxValue(3500))
      .addBooleanOption((o) => o.setName('aktivni').setDescription('Ne = skryje ho ze žebříčku, statistiky zůstanou')),
    new SlashCommandBuilder().setName('kanaly').setDescription('Nastaví hlasové kanály pro týmy a lobby').setContexts(guildOnly)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) => o.setName('modri').setDescription('Kanál modrého týmu').addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName('cerveni').setDescription('Kanál červeného týmu').addChannelTypes(ChannelType.GuildVoice))
      .addChannelOption((o) => o.setName('lobby').setDescription('Kam se po hře všichni vrací').addChannelTypes(ChannelType.GuildVoice)),
    new SlashCommandBuilder().setName('pomoc').setDescription('Jak bota používat').setContexts(guildOnly),
  ].map((c) => c.toJSON());

  async function cmdScrim(i) {
    const guild = i.guild;
    // režim rolí si bot pamatuje z posledního přepnutí na serveru
    const opts = { teams: i.options.getString('tymy') || 'balanced',
      roles: i.options.getString('role') || store.getSetting(guild.id, 'role_mode') || 'prefs' };
    const optBlue = i.options.getChannel('modri');
    const optRed = i.options.getChannel('cerveni');
    if (!!optBlue !== !!optRed) throw new UserError('Zadej oba kanály, modrý i červený, nebo žádný.');
    const blueCh = optBlue || guild.channels.cache.get(store.getSetting(guild.id, 'blue_channel') || '');
    const redCh = optRed || guild.channels.cache.get(store.getSetting(guild.id, 'red_channel') || '');
    const myChannel = guild.voiceStates.cache.get(i.user.id)?.channel || null;

    const created = [];
    const resolve = (members) => members.map((m) => { const r = ensure(m); if (r.created) created.push(r.player); return r.player; });

    let s;
    const splitReady = blueCh && redCh && blueCh.id !== redCh.id && humans(blueCh).length && humans(redCh).length &&
      (optBlue || (myChannel && [blueCh.id, redCh.id].includes(myChannel.id)));
    if (splitReady) {
      const b = humans(blueCh), r = humans(redCh);
      if (b.length > 5 || r.length > 5) throw new UserError(`V kanálu ${b.length > 5 ? blueCh : redCh} je víc než pět lidí.`);
      s = newSession({ mode: 'fixed', fromChannels: true, guildId: guild.id, opts, blueTeam: resolve(b), redTeam: resolve(r), ownerId: i.user.id,
        lobbyId: store.getSetting(guild.id, 'lobby_channel') });
      s.players = [...s.blueTeam, ...s.redTeam];
    } else {
      if (!myChannel) {
        throw new UserError('Připoj se do hlasového kanálu s ostatními a dej `/scrim` znovu. ' +
          'Jestli už jste rozdělení do dvou kanálů, zadej je v možnostech `modri` a `cerveni`.');
      }
      const members = humans(myChannel);
      if (members.length < 2 && !FAKE) throw new UserError(`V ${myChannel} je jen ${members.length} člověk. Na losování jsou potřeba aspoň dva.`);
      const players = resolve(members);
      if (FAKE) players.push(...fakePlayers(Math.max(0, Math.min(FAKE, 10 - players.length))));
      s = newSession({ mode: 'roll', guildId: guild.id, opts, players, ownerId: i.user.id,
        lobbyId: store.getSetting(guild.id, 'lobby_channel') || myChannel.id });
    }
    s.created = created;
    doRoll(s);
    store.saveSession(s);
    await deferReply(i);
    return i.editReply(await rollMessage(s));
  }

  async function cmdRole(i) {
    const { player } = ensure(i.member);
    return i.reply({ content: 'Main hraješ nejradši, Jde to v pohodě, Ne radši vůbec. Ukládá se hned po výběru.',
      components: roleMenus(player), flags: EPHEMERAL });
  }

  async function cmdStats(i) {
    const user = i.options.getUser('hrac');
    if (user) return showProfile(i, user);
    await deferReply(i);
    return i.editReply(await leaderboardMessage(i.guildId, i.options.getString('razeni') || 'rating'));
  }

  async function showProfile(i, user) {
    const p = user.id === i.user.id ? ensure(i.member).player : store.getPlayerByDiscord(user.id);
    if (!p) throw new UserError(`${user} zatím nehrál žádný scrim.`);
    await deferReply(i);
    return i.editReply(await profileMessage(i.guildId, p.id));
  }
  const cmdProfil = (i) => showProfile(i, i.options.getUser('hrac') || i.user);

  async function cmdGraf(i) {
    await deferReply(i);
    return i.editReply(await graphMessage(i.guildId));
  }

  async function cmdVs(i) {
    const u1 = i.options.getUser('druhy') || i.user;
    const u2 = i.options.getUser('hrac');
    if (u1.id === u2.id) throw new UserError('Porovnat se sám se sebou nejde. Vyber někoho jiného.');
    const a = u1.id === i.user.id ? ensure(i.member).player : store.getPlayerByDiscord(u1.id);
    const b = store.getPlayerByDiscord(u2.id);
    if (!a || !b) throw new UserError(`${!a ? u1 : u2} zatím nehrál žádný scrim.`);
    await deferReply(i);
    return i.editReply(await vsMessage(i.guildId, a.id, b.id));
  }

  async function cmdRiot(i) {
    const { player } = ensure(i.member);
    await deferReply(i, true);
    const r = await store.linkRiot(player.id, i.options.getString('riot_id'));
    const parts = [`Riot účet **${r.player.riotId}** je propojený.`];
    if (!r.lookedUp) parts.push('Rank teď načíst nejde, na botovi není nastavený Riot API klíč.');
    else if (!r.solo) parts.push('Na tomhle účtu není rank v solo ani flex frontě.');
    else {
      parts.push(`Rank: **${rankText(r.player.rank)}**.`);
      if (r.ratingSet) parts.push(`Výchozí rating je podle ranku nastavený na **${r.ratingSet}**.`);
      else if (r.suggested) parts.push(`Podle ranku by výchozí rating byl ${r.suggested}. Už máš odehrané zápasy, takže ho změní jen správce přes \`/hrac\`.`);
    }
    return i.editReply(parts.join(' '));
  }

  async function cmdZapas(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'posledni') {
      const list = store.recentMatches(i.guildId, 10);
      const e = new EmbedBuilder().setColor(COLOR.neutral).setTitle('Poslední zápasy');
      if (!list.length) e.setDescription('Zatím žádné.');
      else {
        e.setDescription(list.map((m) => {
          const when = `<t:${Math.floor(new Date(m.playedAt).getTime() / 1000)}:R>`;
          const res = m.winner === 'blue' ? '🔵 vyhráli modří' : m.winner === 'red' ? '🔴 vyhráli červení' : 'bez výsledku';
          return `**#${m.id}** ${when}, ${res}\n🔵 ${m.blue.map((x) => x.name).join(', ')}\n🔴 ${m.red.map((x) => x.name).join(', ')}`;
        }).join('\n\n')).setFooter({ text: 'Karta zápasu: /zapas ukaz id:<číslo>' });
      }
      return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
    }
    const id = i.options.getInteger('id');
    const m = store.getMatch(id);
    if (!m || m.guildId !== i.guildId) throw new UserError(`Zápas #${id} neexistuje.`);
    if (sub === 'ukaz') {
      if (!m.winner) throw new UserError(`Zápas #${id} ještě nemá výsledek.`);
      await deferReply(i);
      return i.editReply(await resultMessage(m));
    }
    if (!isManager(i)) throw new UserError('Mazat zápasy může jen správce serveru.');
    store.deleteMatch(id);
    return i.reply({ content: `Zápas #${id} smazaný, ratingy jsou přepočítané.`, flags: EPHEMERAL });
  }

  async function cmdHrac(i) {
    if (!isManager(i)) throw new UserError('Upravovat hráče může jen správce serveru.');
    const user = i.options.getUser('uzivatel');
    const p = store.getPlayerByDiscord(user.id);
    if (!p) throw new UserError(`${user} zatím nehrál žádný scrim, není co upravovat.`);
    const rating = i.options.getInteger('rating');
    const active = i.options.getBoolean('aktivni');
    const u = rating === null && active === null ? p : store.updatePlayer(p.id, { baseRating: rating, active });
    return i.reply({ content: `${user}: výchozí rating ${u.baseRating}, aktuální ${u.rating}, ${u.active ? 'aktivní' : 'skrytý'}.`, flags: EPHEMERAL });
  }

  async function cmdKanaly(i) {
    const g = i.guildId;
    for (const [opt, key] of [['modri', 'blue_channel'], ['cerveni', 'red_channel'], ['lobby', 'lobby_channel']]) {
      const ch = i.options.getChannel(opt);
      if (ch) store.setSetting(g, key, ch.id);
    }
    const show = (k) => (store.getSetting(g, k) ? `<#${store.getSetting(g, k)}>` : 'nenastavený');
    return i.reply({
      content: `Modří: ${show('blue_channel')}\nČervení: ${show('red_channel')}\nLobby: ${show('lobby_channel')}\n\n` +
        'Když jsou modří i červení v těchto kanálech, `/scrim` nechá týmy, jak jsou, a rozdá jen role. ' +
        'Tlačítko Rozházet do kanálů do nich přesouvá lidi, Všichni zpátky je vrací do lobby.',
      flags: EPHEMERAL,
    });
  }

  async function cmdPomoc(i) {
    const e = new EmbedBuilder().setColor(COLOR.neutral).setTitle('Scrim bot')
      .setDescription('Sejděte se v hlasovém kanálu a dejte `/scrim`. Pod losováním jsou tlačítka: přelosovat, rozházet do kanálů, Hrajeme. ' +
        'Po hře se klikne, kdo vyhrál, a každý si zapíše championa a K/D/A. Další hra rovnou vylosuje novou sestavu ze stejných lidí.')
      .addFields(
        { name: 'Hra', value: '`/scrim` losování\n`/role` tvoje role\n`/riot` propojit Riot účet a rank' , inline: true },
        { name: 'Statistiky', value: '`/stats` žebříček\n`/profil` tvůj profil\n`/vs @hráč` srovnání\n`/graf` vývoj ratingu', inline: true },
        { name: 'Správce', value: '`/kanaly` kanály týmů\n`/zapas` přehled, karta, mazání\n`/hrac` rating a skrytí', inline: true },
        { name: 'Rating', value: `Interní rating jen z našich customek, není to odhad Riot MMR ani náhrada ranked žebříčku. Každý začíná na 1000 nebo na hodnotě odvozené z ranku. Po zápase se mění podle síly soupeře, prvních ${PROVISIONAL_GAMES} her rychleji.` },
      )
      .setFooter({ text: "Scrim bot isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc." });
    return i.reply({ embeds: [e], flags: EPHEMERAL });
  }

  /* ================= hlas ================= */
  async function moveMembers(guild, moves) {
    const failed = [];
    for (const { discordId, channelId } of moves) {
      const vs = guild.voiceStates.cache.get(discordId);
      if (!vs?.channelId || vs.channelId === channelId) continue;
      try { await vs.setChannel(channelId, 'Scrim'); } catch { failed.push(discordId); }
    }
    return failed;
  }
  const moveFailText = (ids) => `Nepodařilo se přesunout ${ids.map((x) => `<@${x}>`).join(', ')}. ` +
    'Bot potřebuje oprávnění Přesouvat členy a Připojit se v obou kanálech.';

  function assertPlayed(i, m) {
    if (![...m.blue, ...m.red].some((x) => x.discordId === i.user.id) && !isManager(i)) {
      throw new UserError('Tohle může udělat jen někdo, kdo v zápase hrál.');
    }
  }

  // Nová zpráva s losováním ze stejných lidí (Další hra) nebo stejných týmů (Odveta)
  async function followupRoll(i, m, rematch) {
    const fresh = (x) => store.getPlayer(x.playerId);
    const prev = store.sessionForMatch(m.id);
    let s;
    if (rematch) {
      // stejné týmy, nové náhodné role (nikdo nedostane tu samou jako minule, když to jde)
      const blueTeam = m.blue.map(fresh), redTeam = m.red.map(fresh);
      s = newSession({ mode: 'fixed', fromChannels: !!prev?.fromChannels, guildId: m.guildId, opts: { roles: 'random' },
        blueTeam, redTeam, ownerId: i.user.id, lobbyId: prev?.lobbyId || null, seriesId: m.seriesId || String(m.id),
        prevRoles: Object.fromEntries([...m.blue, ...m.red].map((x) => [x.playerId, x.role])) });
      s.players = [...blueTeam, ...redTeam];
      doRoll(s);
    } else {
      const ids = [...m.blue, ...m.red].map((x) => x.playerId).concat((prev?.roll?.bench || []).map((p) => p.id));
      const players = [...new Set(ids)].map((id) => store.getPlayer(id)).filter(Boolean);
      s = newSession({ mode: 'roll', guildId: m.guildId, opts: prev?.opts || { teams: 'balanced', roles: 'prefs' }, players,
        ownerId: i.user.id, lobbyId: prev?.lobbyId || null });
      s.roll = { key: [...m.blue].map((x) => x.playerId).sort((a, b) => a - b).join(',') };
      doRoll(s);
    }
    store.saveSession(s);
    await deferReply(i);
    return i.editReply(await rollMessage(s));
  }

  /* ================= tlačítka ================= */
  async function onButton(i) {
    const [kind, action, a, b] = i.customId.split(':');

    if (kind === 'lb') { await deferUpdate(i); return i.editReply(await leaderboardMessage(i.guildId, action, Number(a))); }
    if (kind === 'pf') { await deferUpdate(i); return i.editReply(await profileMessage(i.guildId, Number(action), a)); }
    if (kind === 'graf') { await deferUpdate(i); return i.editReply(await graphMessage(i.guildId)); }

    if (['win', 'void', 'back', 'kda', 'next', 'rematch'].includes(action)) {
      const m = store.getMatch(Number(a));
      if (!m) {
        if (action === 'void') return i.update({ content: 'Zápas je zrušený.', embeds: [], components: [], attachments: [] });
        throw new UserError('Tenhle zápas už neexistuje.');
      }
      if (action === 'kda') {
        const me = [...m.blue, ...m.red].find((x) => x.discordId === i.user.id);
        if (!me) throw new UserError('Statistiky si zapisuje každý sám a ty jsi v tomhle zápase nehrál.');
        return i.showModal(kdaModal(m, me));
      }
      assertPlayed(i, m);
      if (action === 'win') {
        await deferUpdate(i);
        return i.editReply(await resultMessage(store.setWinner(m.id, b)));
      }
      if (action === 'void') {
        if (m.winner) throw new UserError('Zápas už má výsledek. Smazat ho může správce přes `/zapas smazat`.');
        store.deleteMatch(m.id);
        return i.update({ content: `Zápas #${m.id} zrušený. Nové losování přes \`/scrim\`.`, embeds: [], components: [], attachments: [] });
      }
      if (action === 'back') {
        await deferUpdate(i);
        const failed = await moveMembers(i.guild, [...m.blue, ...m.red].filter((x) => x.discordId).map((x) => ({ discordId: x.discordId, channelId: b })));
        return i.followUp({ content: failed.length ? moveFailText(failed) : `Všichni zpátky v <#${b}>.`, flags: EPHEMERAL });
      }
      if (action === 'next') return followupRoll(i, m, false);
      if (action === 'rematch') return followupRoll(i, m, true);
    }

    const s = getSession(a);
    if (!s.players.some((p) => p.discordId === i.user.id) && s.ownerId !== i.user.id && !isManager(i)) {
      throw new UserError('Ovládat losování může jen někdo, kdo v něm hraje.');
    }
    if (action === 'reroll') {
      if (s.matchId) throw new UserError('Zápas už běží. Kdo chce losovat znovu, ať ho nejdřív zruší.');
      doRoll(s);
      store.saveSession(s);
      await deferUpdate(i);
      return i.editReply(await rollMessage(s));
    }
    if (action === 'rolemode') {
      if (s.matchId) throw new UserError('Zápas už běží.');
      s.opts.roles = s.opts.roles === 'random' ? 'prefs' : 'random';
      store.setSetting(i.guildId, 'role_mode', s.opts.roles);
      doRoll(s);
      store.saveSession(s);
      await deferUpdate(i);
      return i.editReply(await rollMessage(s));
    }
    if (action === 'move') {
      const blue = store.getSetting(i.guildId, 'blue_channel');
      const red = store.getSetting(i.guildId, 'red_channel');
      if (!blue || !red) throw new UserError('Nejdřív je potřeba nastavit kanály týmů přes `/kanaly` (umí správce serveru).');
      await deferUpdate(i);
      const failed = await moveMembers(i.guild, [
        ...s.roll.blue.map((x) => ({ discordId: x.player.discordId, channelId: blue })),
        ...s.roll.red.map((x) => ({ discordId: x.player.discordId, channelId: red })),
      ].filter((x) => x.discordId));
      return i.followUp({ content: failed.length ? moveFailText(failed) : `Rozházeno: modří v <#${blue}>, červení v <#${red}>.`, flags: EPHEMERAL });
    }
    if (action === 'save') {
      if (!s.matchId) {
        s.seriesId = s.seriesId || s.id;
        s.matchId = store.createMatch(i.guildId,
          s.roll.blue.map((x) => ({ playerId: x.player.id, role: x.role })),
          s.roll.red.map((x) => ({ playerId: x.player.id, role: x.role })), s.seriesId);
        store.saveSession(s);
      }
      await deferUpdate(i);
      return i.editReply(await rollMessage(s));
    }
    throw new UserError('Neznámé tlačítko.');
  }

  async function onModal(i) {
    const id = Number(i.customId.split(':')[1]);
    const m = store.getMatch(id);
    if (!m) throw new UserError('Tenhle zápas už neexistuje.');
    const me = [...m.blue, ...m.red].find((x) => x.discordId === i.user.id);
    if (!me) throw new UserError('V tomhle zápase jsi nehrál.');
    const kda = parseKda(i.fields.getTextInputValue('kda'));
    const champion = store.normalizeChampion(i.fields.getTextInputValue('champion'));
    store.saveStats(id, me.playerId, { champion, ...kda });
    const fresh = store.getMatch(id);
    if (fresh.winner && i.isFromMessage?.()) {
      await deferUpdate(i);
      return i.editReply(await resultMessage(fresh));
    }
    return i.reply({ content: 'Uloženo.', flags: EPHEMERAL });
  }

  async function onSplit(i, sid) {
    const s = getSession(sid);
    if (!s.players.some((p) => p.discordId === i.user.id) && s.ownerId !== i.user.id && !isManager(i)) {
      throw new UserError('Rozdělit týmy může jen někdo, kdo hraje.');
    }
    if (s.matchId) throw new UserError('Zápas už běží.');
    const chosen = new Set(i.values.map(Number));
    const blueTeam = s.players.filter((p) => chosen.has(p.id));
    let rest = s.players.filter((p) => !chosen.has(p.id));
    const bench = rest.length > 5 ? rest.slice(5) : [];
    rest = rest.slice(0, 5);
    if (!blueTeam.length || !rest.length) throw new UserError('Oba týmy musí mít aspoň jednoho hráče.');
    Object.assign(s, { mode: 'fixed', fromChannels: false, blueTeam, redTeam: rest });
    doRoll(s);
    s.roll.bench = bench;
    store.saveSession(s);
    await deferUpdate(i);
    return i.editReply(await rollMessage(s));
  }

  async function onSelect(i) {
    const [kind, arg] = i.customId.split(':');
    if (kind === 'role') {
      if (!ROLES.includes(arg)) return;
      const { player } = ensure(i.member);
      return i.update({ components: roleMenus(store.setRole(player.id, arg, Number(i.values[0]))) });
    }
    if (kind === 'split') return onSplit(i, arg);
    await deferUpdate(i);
    if (kind === 'lbsort') return i.editReply(await leaderboardMessage(i.guildId, i.values[0], 0));
    if (kind === 'pfpick') return i.editReply(await profileMessage(i.guildId, Number(i.values[0])));
    if (kind === 'grafpick') return i.editReply(await graphMessage(i.guildId, i.values.map(Number)));
  }

  /* ================= směrování ================= */
  const handlers = { scrim: cmdScrim, role: cmdRole, stats: cmdStats, profil: cmdProfil, graf: cmdGraf, vs: cmdVs,
    riot: cmdRiot, zapas: cmdZapas, hrac: cmdHrac, kanaly: cmdKanaly, pomoc: cmdPomoc };
  async function handle(i) {
    try {
      if (i.isChatInputCommand() && handlers[i.commandName]) return await handlers[i.commandName](i);
      if (i.isButton() && /^(scrim|lb|pf|graf):/.test(i.customId)) return await onButton(i);
      if (i.isModalSubmit() && i.customId.startsWith('kda:')) return await onModal(i);
      if (i.isStringSelectMenu()) return await onSelect(i);
    } catch (e) {
      const known = e instanceof UserError;
      if (!known) console.error('[bot]', e);
      const content = known ? e.message : 'Něco se pokazilo. Zkus to znovu, případně se podívej do logu bota.';
      try {
        if (i.__mode === 'reply') await i.editReply({ content, embeds: [], files: [], attachments: [], components: [] });
        else if (i.__mode === 'update' || i.replied || i.deferred) await i.followUp({ content, flags: EPHEMERAL });
        else await i.reply({ content, flags: EPHEMERAL });
      } catch { /* interakce mezitím vypršela */ }
    }
  }

  return { commands, handle, parseKda, leaderboardMessage, profileMessage };
}

function start(store, { token, guildIds = [] }) {
  const bot = createBot(store);
  const isAllowed = (id) => !guildIds.length || guildIds.includes(id);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  const register = async (guild) => {
    if (!isAllowed(guild.id)) { console.log(`[bot] server ${guild.name} není v DISCORD_GUILD_ID, ignoruju ho`); return; }
    try { await guild.commands.set(bot.commands); console.log(`[bot] příkazy zaregistrované na serveru ${guild.name}`); }
    catch (e) { console.error(`[bot] registrace příkazů na ${guild.name} selhala:`, e.message); }
  };

  client.once(Events.ClientReady, async (c) => {
    console.log(`[bot] přihlášený jako ${c.user.tag}`);
    console.log(`[bot] pozvánka: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`);
    for (const g of c.guilds.cache.values()) await register(g);
  });
  client.on(Events.GuildCreate, register);
  client.on(Events.InteractionCreate, (i) => { if (i.guildId && isAllowed(i.guildId)) bot.handle(i); });
  client.on(Events.Error, (e) => console.error('[bot]', e.message));
  return client.login(token).then(() => client);
}

module.exports = { createBot, start, INVITE_PERMISSIONS };
