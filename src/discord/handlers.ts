import {
  ActionRowBuilder, ActionRowBuilder as Row, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle, type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Interaction,
  type InteractionReplyOptions, type InteractionUpdateOptions, type ModalSubmitInteraction,
} from 'discord.js';
import type { Ctx } from '../context.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import { attemptCatch } from '../domain/catch.js';
import { GuessLimiter } from '../domain/limiter.js';
import { recordFailure } from '../domain/audit.js';
import {
  dexPage, getOwnedCard, getOwnedCardFor, getProfileStats, listOwned, setFavorited, setLocked,
  type DexFilter, type ListFilter, type OwnedCardView,
} from '../domain/collection.js';
import { claimArcPack, claimPeriodic, evaluateMilestones, getArcs, periodInfo, type PackCard } from '../domain/rewards.js';
import { formatDv, worthOf } from '../domain/value.js';
import { leaderboard, type Board } from '../domain/leaderboard.js';
import { acceptTrade, assessTradeById, cancelTrade, confirmTrade, declineTrade, getTradeView, proposeTrade, type TradeError } from '../domain/trade.js';
import { authorizeTestSpawn, getGuildSettings, updateGuildSetting, type Actor } from '../domain/admin.js';
import { audit } from '../domain/audit.js';
import { normalizeAlias } from '../util/normalize.js';
import { discordTs } from '../util/time.js';
import type { Rarity, Variant } from '../types.js';
import { BRAND_COLOR, RARITY_STYLE, cardEmbed, copyRef, dexLine, ownedLine, SORT_LABEL } from './embeds.js';
import type { CardLike } from './embeds.js';
import type { Spawner } from './spawner.js';

export interface App { ctx: Ctx; env: Env; client: Client; spawner: Spawner; limiter: GuessLimiter; log: Logger }
const EPH = MessageFlags.Ephemeral;

// ---------- per-user command throttle (anti-spam only; holds no authoritative state) ----------
const hits = new Map<string, number[]>();
function throttled(userId: string, now: number): boolean {
  const w = (hits.get(userId) ?? []).filter((t) => now - t < 10_000);
  w.push(now); hits.set(userId, w);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t > 10_000)) hits.delete(k);
  return w.length > 8;
}

// ---------- paginated view state (presentation only; every render re-reads the DB) ----------
interface View { kind: 'list' | 'dex'; userId: string; filter: ListFilter & DexFilter; expires: number }
const views = new Map<string, View>();
function saveView(v: Omit<View, 'expires'>, now: number): string {
  if (views.size > 3000) for (const [k, x] of views) if (x.expires < now) views.delete(k);
  const token = Math.random().toString(36).slice(2, 10);
  views.set(token, { ...v, expires: now + 15 * 60_000 });
  return token;
}
const pager = (token: string, page: number, pages: number) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pg:${token}:prev`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`pg:${token}:next`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );

function renderView(app: App, v: View, token: string): InteractionReplyOptions & InteractionUpdateOptions {
  const f = v.filter;
  if (v.kind === 'list') {
    const r = listOwned(app.ctx.db, v.userId, f);
    f.page = r.page;
    const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Your cards')
      .setDescription(r.rows.length ? r.rows.map(ownedLine).join('\n') : 'No cards match. Catch characters when they appear!')
      .setFooter({ text: `Page ${r.page}/${r.pages} · ${r.total} copies · sort: ${SORT_LABEL[f.sort ?? 'recent']} · 🔒 locked ⭐ favorite 🔁 in trade · use /card id:` });
    return { embeds: [e], components: [pager(token, r.page, r.pages)] };
  }
  const r = dexPage(app.ctx.db, v.userId, f);
  f.page = r.page;
  const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Blue Dex catalogue')
    .setDescription(r.rows.length ? r.rows.map(dexLine).join('\n') : 'No catalogue entries match.')
    .setFooter({ text: `Page ${r.page}/${r.pages} · ${r.total} cards · ✅ you own it · ▫️ you don't (global catalogue)` });
  return { embeds: [e], components: [pager(token, r.page, r.pages)] };
}

const nameLookup = (ctx: Ctx, raw: string): string | undefined =>
  (ctx.db.prepare('SELECT character_id c FROM character_aliases WHERE alias=?').get(normalizeAlias(raw)) as { c: string } | undefined)?.c;

const TRADE_ERR: Record<TradeError, string> = {
  self_trade: 'You cannot trade with yourself.', recipient_unknown: 'That player has no collection yet (or you have none).', empty_offer: 'Offer at least one card.',
  too_many_items: 'Too many cards in this trade.', duplicate_items: 'A card appears twice.', not_owner: 'One of those copies is not owned by the right player.',
  ineligible: 'One of those copies is locked or already in another trade.', too_many_pending: 'You already have too many open trades.', not_found: 'Trade not found.',
  forbidden: 'This is not your trade to act on.', bad_state: 'This trade is no longer in that state.', expired: 'This trade expired.',
  revalidation_failed: 'Something changed (a card was locked/moved), so the trade was cancelled. Nothing was transferred.',
  needs_ack: 'Please confirm this lopsided trade first.',
};

export async function handleInteraction(app: App, i: Interaction): Promise<void> {
  try {
    if (i.isAutocomplete()) return await autocomplete(app, i);
    if (i.isChatInputCommand()) {
      if (throttled(i.user.id, app.ctx.clock())) return void (await i.reply({ content: 'Slow down a little!', flags: EPH }));
      return await command(app, i);
    }
    if (i.isButton()) return await button(app, i);
    if (i.isModalSubmit()) return await modal(app, i);
  } catch (e) {
    const ref = app.ctx.rng.shortId(6);
    app.log.error({ err: e, ref, kind: i.type }, 'interaction failed');
    recordFailure(app.ctx.db, app.ctx.clock(), 'interaction', ref, e);
    if (i.isRepliable()) {
      const msg = { content: `Something went wrong (ref \`${ref}\`). Nothing was lost; please try again.`, flags: EPH } as const;
      try { await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)); } catch { /* Discord gone/expired: already logged */ }
    }
  }
}

async function autocomplete(app: App, i: AutocompleteInteraction): Promise<void> {
  const q = i.options.getFocused().slice(0, 64);
  const own = listOwned(app.ctx.db, i.user.id, { search: q.replace(/^#/, ''), pageSize: 25, sort: 'recent' }).rows;
  const choices = own.map((c) => ({ name: `#${c.copy_id} ${c.variant === 'shiny' ? '✨ ' : ''}${c.character_name} · ${c.edition_name}`.slice(0, 100), value: c.copy_id }));
  if (i.commandName === 'card' && choices.length < 25) {
    for (const d of dexPage(app.ctx.db, i.user.id, { search: q, pageSize: 25 - choices.length }).rows) choices.push({ name: `${d.card_id} (catalogue) ${d.character_name} · ${d.edition_name}`.slice(0, 100), value: d.card_id });
  }
  await i.respond(choices.slice(0, 25));
}

// ---------------------------------------------------------------- commands
async function command(app: App, i: ChatInputCommandInteraction): Promise<void> {
  const { ctx } = app;
  const settings = i.guildId ? getGuildSettings(ctx, i.guildId) : undefined;
  const compact = !!settings?.compact_embeds;
  switch (i.commandName) {
    case 'help': {
      const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Blue Dex — how it works').setDescription([
        '**Catching** — Characters appear in the server\'s spawn channel. Press **Catch**, type the name, and the first correct guess wins that spawn. You have **3 minutes** (180 s); after that it\'s gone for everyone.',
        '**DV (Dex Value)** — the number on every card. **Lower = rarer.** 100.0 is the most common, 0.1 the rarest. Tiers: 👟 Common 60-100 · 💎 Rare 20-59.9 · ✨ Super Rare 6-19.9 · ⚡ Epic 2-5.9 · 🌟 Legendary 0.6-1.9 · 👑 Mythic 0.1-0.5.',
        '**Stats** — ⚽ STRIKE and 🔥 EGO. They show how a player is a striker. They never change a card\'s DV.',
        '**Worth** — Worth = 100 ÷ DV. **Half the DV is double the worth.** A 10.0 is worth two 20.0s. Trades are judged by total Worth.',
        '**Collection** — `/dex` (whole catalogue), `/list` (your copies), `/card` (inspect, lock, favorite), `/profile`, `/inventory`, `/leaderboard`.',
        '**Rewards** — `/daily` and `/weekly` open packs (weekly always has a Super Rare or better). Resets 00:00 UTC (weekly: Monday). `/arc` shows the live event.',
        '**Trading** — `/trade` offers specific copies for specific copies. You see both sides\' Worth. Lopsided trades are allowed, but the side giving more must confirm twice.',
        '*Unofficial fan project. Not affiliated with Blue Lock, its creators or publishers.*',
      ].join('\n\n'));
      return void (await i.reply({ embeds: [e], flags: EPH }));
    }
    case 'profile': {
      const target = i.options.getUser('user') ?? i.user;
      const pub = i.options.getBoolean('public');
      if (pub !== null && target.id === i.user.id) {
        const r = ctx.db.prepare('UPDATE collectors SET profile_public=? WHERE user_id=?').run(pub ? 1 : 0, i.user.id);
        if (!r.changes) return void (await i.reply({ content: 'Catch your first character to create a profile.', flags: EPH }));
      }
      const s = getProfileStats(ctx.db, target.id);
      if (!s) return void (await i.reply({ content: target.id === i.user.id ? 'You have no collection yet — catch a character first!' : 'That player has no collection yet.', flags: EPH }));
      if (!s.profilePublic && target.id !== i.user.id) return void (await i.reply({ content: 'That profile is private.', flags: EPH }));
      const e = new EmbedBuilder().setColor(BRAND_COLOR).setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() }).setTitle('Collector profile')
        .addFields(
          { name: 'Unique cards', value: `${s.uniqueOwned}/${s.catalogueSize}`, inline: true },
          { name: 'Completion', value: `${s.completionPct}%`, inline: true },
          { name: 'Total copies', value: String(s.totalCopies), inline: true },
          { name: 'Lifetime catches', value: String(s.totalCatches), inline: true },
          { name: 'Collector since', value: discordTs(s.createdAt, 'F'), inline: true },
        ).setFooter({ text: s.profilePublic ? 'Public profile' : 'Private profile' });
      return void (await i.reply({ embeds: [e], flags: target.id === i.user.id ? EPH : undefined }));
    }
    case 'dex': case 'list': {
      const f: ListFilter & DexFilter = { page: 1 };
      const s = i.options.getString('search'); if (s) f.search = s;
      const r = i.options.getString('rarity') as Rarity | null; if (r) f.rarity = r;
      if (i.commandName === 'dex') {
        const set = i.options.getString('set'); if (set) f.setId = set;
        f.show = (i.options.getString('show') as DexFilter['show']) ?? 'all';
      } else {
        const v = i.options.getString('variant') as Variant | null; if (v) f.variant = v;
        f.sort = (i.options.getString('sort') as ListFilter['sort']) ?? 'recent';
        if (i.options.getBoolean('locked')) f.lockedOnly = true;
        if (i.options.getBoolean('favorites')) f.favoritedOnly = true;
      }
      const view = { kind: i.commandName as 'dex' | 'list', userId: i.user.id, filter: f };
      const token = saveView(view, ctx.clock());
      return void (await i.reply({ ...renderView(app, { ...view, expires: 0 }, token), flags: EPH } as InteractionReplyOptions));
    }
    case 'card': {
      const raw = i.options.getString('id', true);
      let c = getOwnedCardFor(ctx.db, i.user.id, raw);
      if (c) {
        const lock = i.options.getBoolean('lock'), fav = i.options.getBoolean('favorite');
        if (lock !== null) setLocked(ctx.db, i.user.id, c.copy_id, lock);
        if (fav !== null) setFavorited(ctx.db, i.user.id, c.copy_id, fav);
        c = getOwnedCardFor(ctx.db, i.user.id, c.copy_id)!;
        const copies = (ctx.db.prepare('SELECT COUNT(*) n FROM owned_cards WHERE owner_id=? AND card_definition_id=?').get(i.user.id, c.card_id) as { n: number }).n;
        const { embed, files } = await cardEmbed(c, c.variant, app.env.ASSETS_DIR, {
          compact, owner: i.user.displayName ?? i.user.username, extra: [`Copy ${copyRef(c.copy_id)} · acquired ${discordTs(c.acquired_at, 'R')}`, `${c.locked ? '🔒 Locked' : '🔓 Unlocked'} · ${c.favorited ? '⭐ Favorite' : 'Not favorite'}${c.state === 'reserved' ? ' · 🔁 In an open trade' : ''}`, `You own ${copies} cop${copies === 1 ? 'y' : 'ies'} of this card.`],
        });
        return void (await i.reply({ embeds: [embed], files, flags: EPH }));
      }
      const d = ctx.db.prepare(`SELECT cd.id card_id, cd.character_id, cd.edition_name, cd.rarity, cd.dv, cd.strike, cd.ego, cd.team, cd.description, s.name set_name, ch.display_name character_name, cd.normal_card_art, cd.shiny_card_art
        FROM card_definitions cd JOIN sets s ON s.id=cd.set_id JOIN characters ch ON ch.id=cd.character_id WHERE cd.id=? AND cd.status='available'`).get(raw.trim().toLowerCase()) as
        CardLike | undefined;
      if (!d) return void (await i.reply({ content: 'No owned copy or catalogue card matches that id.', flags: EPH }));
      const o = (ctx.db.prepare('SELECT COUNT(*) n FROM owned_cards WHERE owner_id=? AND card_definition_id=?').get(i.user.id, d.card_id) as { n: number }).n;
      const { embed, files } = await cardEmbed(d, 'normal', app.env.ASSETS_DIR, { compact, extra: [`Catalogue entry \`${d.card_id}\``, `You own ${o} cop${o === 1 ? 'y' : 'ies'}.`] });
      return void (await i.reply({ embeds: [embed], files, flags: EPH }));
    }
    case 'inventory': {
      const s = getProfileStats(ctx.db, i.user.id);
      const by = ctx.db.prepare("SELECT cd.rarity r, COUNT(*) n FROM owned_cards oc JOIN card_definitions cd ON cd.id=oc.card_definition_id WHERE oc.owner_id=? GROUP BY cd.rarity").all(i.user.id) as { r: Rarity; n: number }[];
      const flags = ctx.db.prepare("SELECT COALESCE(SUM(locked),0) l, COALESCE(SUM(favorited),0) f, COALESCE(SUM(state='reserved'),0) t FROM owned_cards WHERE owner_id=?").get(i.user.id) as { l: number; f: number; t: number };
      const now = ctx.clock();
      const claimed = (t: 'daily' | 'weekly') => !!ctx.db.prepare('SELECT 1 FROM reward_claims WHERE user_id=? AND reward_type=? AND period_key=?').get(i.user.id, t, periodInfo(t, now).key);
      const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle('Inventory').addFields(
        { name: 'Cards', value: s ? `${s.totalCopies} copies · ${s.uniqueOwned} unique\n${by.map((x) => `${RARITY_STYLE[x.r].emoji} ${x.n}`).join('  ') || '—'}\n🔒 ${flags.l}  ⭐ ${flags.f}  🔁 ${flags.t}` : 'No cards yet.' },
        { name: 'Resources', value: 'No currencies in this version. Your rewards are the cards themselves.' },
        { name: 'Rewards', value: `Daily: ${claimed('daily') ? `claimed · next ${discordTs(periodInfo('daily', now).nextAt)}` : '**ready** — `/daily`'}\nWeekly: ${claimed('weekly') ? `claimed · next ${discordTs(periodInfo('weekly', now).nextAt)}` : '**ready** — `/weekly`'}` });
      return void (await i.reply({ embeds: [e], flags: EPH }));
    }
    case 'daily': case 'weekly': {
      const t = i.commandName;
      const r = claimPeriodic(ctx, i.user.id, i.user.displayName ?? i.user.username, t);
      if (!r.ok) return void (await i.reply({ content: `You already claimed your ${t} reward. Next one ${discordTs(r.nextClaimAt)} (${discordTs(r.nextClaimAt, 'F')}, resets 00:00 UTC${t === 'weekly' ? ' on Mondays' : ''}).`, flags: EPH }));
      const embeds = [packEmbed(ctx, `Your ${t} pack`, r.cards)];
      for (const m of r.milestones) embeds.push(packEmbed(ctx, `🏆 Milestone: ${m.name}`, m.cards));
      return void (await i.reply({ embeds: embeds.slice(0, 10), flags: EPH }));
    }
    case 'leaderboard': {
      const b = (i.options.getString('board') ?? 'unique') as Board;
      const rows = leaderboard(ctx.db, b, 10);
      const unit = { unique: 'unique', completion: '%', shiny: 'unique', score: 'pts' }[b];
      const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(`Leaderboard — ${{ unique: 'Unique cards', completion: 'Completion', shiny: 'Unique shinies', score: 'Collection score' }[b]}`)
        .setDescription(rows.length ? rows.map((r) => `**${r.rank}.** <@${r.userId}> — ${r.value} ${unit}`).join('\n') : 'Nobody ranked yet.')
        .setFooter({ text: 'Ranks use cards you currently own, one per unique card. Duplicates never count. Score: 10 points per halving of DV (DV 100 = 10, DV 50 = 20, DV 25 = 30).' });
      return void (await i.reply({ embeds: [e], allowedMentions: { parse: [] } }));
    }
    case 'arc': return arcCommand(app, i);
    case 'trade': return tradeCommand(app, i);
    case 'setup': case 'settings': case 'testspawn': return adminCommand(app, i);
  }
}

function packEmbed(ctx: Ctx, title: string, cards: PackCard[]): EmbedBuilder {
  const lines = cards.map((c) => {
    const d = ctx.db.prepare('SELECT cd.edition_name e, cd.rarity r, cd.dv dv, ch.display_name n FROM card_definitions cd JOIN characters ch ON ch.id=cd.character_id WHERE cd.id=?').get(c.cardId) as { e: string; r: Rarity; dv: number; n: string };
    return `${copyRef(c.copyId)} **${d.n}** · ${d.e} · ${RARITY_STYLE[d.r].emoji} ${RARITY_STYLE[d.r].label} · DV ${formatDv(d.dv)}`;
  });
  return new EmbedBuilder().setColor(BRAND_COLOR).setTitle(title).setDescription(lines.join('\n'));
}

// ---------------------------------------------------------------- admin
function actorOf(app: App, i: ChatInputCommandInteraction): Actor {
  const p = i.memberPermissions;
  return { userId: i.user.id, isGuildAdmin: !!p && (p.has(PermissionFlagsBits.ManageGuild) || p.has(PermissionFlagsBits.Administrator)), isOperator: app.env.operatorIds.has(i.user.id) };
}
async function adminCommand(app: App, i: ChatInputCommandInteraction): Promise<void> {
  const { ctx } = app;
  const actor = actorOf(app, i);
  if (!i.guildId || !i.guild) return void (await i.reply({ content: 'Use this in a server.', flags: EPH }));
  if (i.commandName === 'testspawn') {
    const auth = authorizeTestSpawn(actor);
    if (!auth.ok) return void (await i.reply({ content: 'You are not allowed to use this command.', flags: EPH }));
    const charOpt = i.options.getString('character'), varOpt = null as Variant | null;
    if ((charOpt || varOpt) && !auth.mayOverride) return void (await i.reply({ content: 'Forcing a character or variant is operator-only.', flags: EPH }));
    let overrides: { characterId?: string; variant?: Variant } | undefined;
    if (charOpt || varOpt) {
      const cid = charOpt ? nameLookup(ctx, charOpt) : undefined;
      if (charOpt && !cid) return void (await i.reply({ content: 'Unknown character.', flags: EPH }));
      overrides = { ...(cid ? { characterId: cid } : {}), ...(varOpt ? { variant: varOpt } : {}) };
    }
    await i.deferReply({ flags: EPH });
    audit(ctx.db, ctx.clock(), i.user.id, i.guildId, 'test_spawn', { channelId: i.channelId, overrides: !!overrides });
    const r = await app.spawner.postSpawn(i.guildId, i.channelId, { isTest: true, testOverrides: overrides });
    return void (await i.editReply(r.ok ? 'Test spawn posted. It is clearly marked TEST and awards nothing.' : `Could not post a test spawn (${r.reason}).`));
  }
  if (!actor.isGuildAdmin && !actor.isOperator) return void (await i.reply({ content: 'You need the **Manage Server** permission.', flags: EPH }));
  if (i.commandName === 'setup') {
    const ch = i.options.getChannel('channel', true);
    const full = await i.guild.channels.fetch(ch.id);
    const me = i.guild.members.me;
    if (!full || !me || (full.type !== ChannelType.GuildText && full.type !== ChannelType.GuildAnnouncement)) return void (await i.reply({ content: 'Pick a text channel.', flags: EPH }));
    const perms = full.permissionsFor(me);
    const need: [bigint, string][] = [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.SendMessages, 'Send Messages'], [PermissionFlagsBits.EmbedLinks, 'Embed Links'], [PermissionFlagsBits.AttachFiles, 'Attach Files']];
    const missing = need.filter(([p]) => !perms?.has(p)).map(([, n]) => n);
    if (missing.length) return void (await i.reply({ content: `I can't use <#${full.id}> yet. Missing: **${missing.join(', ')}**. Fix the channel permissions and run \`/setup\` again.`, flags: EPH }));
    updateGuildSetting(ctx, actor, i.guildId, 'spawn_channel_id', full.id);
    updateGuildSetting(ctx, actor, i.guildId, 'spawns_enabled', true);
    return void (await i.reply({ content: `✅ Characters will appear in <#${full.id}> as the channel gets active. Spawn timing is set by the bot and can't be changed per server.`, flags: EPH }));
  }
  // /settings
  const sub = i.options.getSubcommand();
  if (sub === 'view') {
    const s = getGuildSettings(ctx, i.guildId);
    return void (await i.reply({ flags: EPH, content: `**Server settings**\nSpawn channel: ${s?.spawn_channel_id ? `<#${s.spawn_channel_id}>` : 'not set (`/setup`)'}\nSpawns: ${s?.spawns_enabled === 0 ? 'off' : 'on'}\nCompact images: ${s?.compact_embeds ? 'on' : 'off'}\n\nSpawn rates, shiny odds and rewards are bot-wide and not configurable here.` }));
  }
  const res = updateGuildSetting(ctx, actor, i.guildId, sub === 'spawns' ? 'spawns_enabled' : 'compact_embeds', i.options.getBoolean('enabled', true));
  return void (await i.reply({ content: res.ok ? 'Saved.' : `Could not save (${res.reason}).`, flags: EPH }));
}

// ---------------------------------------------------------------- trading UI
const tradeRow = (id: string, stage: 'pending' | 'accepted', ack = false) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  ...(stage === 'pending'
    ? [ack
      ? new ButtonBuilder().setCustomId(`trade:acceptok:${id}`).setLabel('Accept anyway').setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`trade:accept:${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`trade:decline:${id}`).setLabel('Decline').setStyle(ButtonStyle.Danger)]
    : [ack
      ? new ButtonBuilder().setCustomId(`trade:confirmok:${id}`).setLabel('Confirm anyway').setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`trade:confirm:${id}`).setLabel('Confirm final exchange').setStyle(ButtonStyle.Success)]),
  new ButtonBuilder().setCustomId(`trade:cancel:${id}`).setLabel('Cancel trade').setStyle(ButtonStyle.Secondary));

function tradeEmbed(app: App, id: string, note?: string): EmbedBuilder {
  const v = getTradeView(app.ctx.db, id)!;
  const a = assessTradeById(app.ctx, id);
  const side = (s: 'offer' | 'request') => v.items.filter((x) => x.side === s).map((x) => `${copyRef(x.copy_id)} **${x.character_name}** · ${x.edition_name} · ${RARITY_STYLE[x.rarity as Rarity].emoji} DV ${formatDv(x.dv)} (worth ${worthOf(x.dv, x.variant as 'normal' | 'shiny')})`).join('\n') || '*nothing*';
  const meter = !a ? '' : a.verdict === 'fair' ? '⚖️ **Fair trade**' : `⚠️ **Lopsided**: <@${a.giver === 'proposer' ? v.trade.proposer_id : v.trade.recipient_id}> gives clearly more`;
  return new EmbedBuilder().setColor(BRAND_COLOR).setTitle(`Trade — ${v.trade.status}`)
    .setDescription(`<@${v.trade.proposer_id}> → <@${v.trade.recipient_id}>${meter ? `\n${meter}` : ''}${note ? `\n${note}` : ''}`)
    .addFields({ name: `Proposer gives${a ? ` · worth ${a.offerWorth}` : ''}`, value: side('offer') }, { name: `Recipient gives${a ? ` · worth ${a.requestWorth}` : ''}`, value: side('request') }, { name: 'Expires', value: discordTs(v.trade.expires_at) });
}

async function arcCommand(app: App, i: ChatInputCommandInteraction): Promise<void> {
  const { ctx } = app;
  const sub = i.options.getSubcommand();
  const arcs = getArcs(ctx);
  const live = arcs.find((a) => a.live);
  const next = arcs.find((a) => a.upcoming);
  if (sub === 'pack') {
    const r = claimArcPack(ctx, i.user.id, i.user.displayName ?? i.user.username);
    if (!r.ok) return void (await i.reply({ content: r.reason === 'no_live_arc' ? 'There is no live arc right now. Check `/arc info`.' : 'You already opened your free pack for this arc.', flags: EPH }));
    const embeds = [packEmbed(ctx, `Your ${live?.name ?? 'arc'} pack`, r.cards), ...r.milestones.map((m) => packEmbed(ctx, `🏆 Milestone: ${m.name}`, m.cards))];
    return void (await i.reply({ embeds: embeds.slice(0, 10), flags: EPH }));
  }
  if (!live) {
    return void (await i.reply({ flags: EPH, content: next ? `No arc is live. **${next.name}** starts ${discordTs(next.startsAt, 'F')} (${discordTs(next.startsAt, 'R')}).` : 'No arc is live right now. Base cards keep spawning as usual.' }));
  }
  const cards = ctx.db.prepare(`SELECT cd.id, cd.edition_name e, cd.dv, cd.rarity r, ch.display_name n, (SELECT COUNT(*) FROM owned_cards oc WHERE oc.owner_id=? AND oc.card_definition_id=cd.id) own
    FROM card_definitions cd JOIN characters ch ON ch.id=cd.character_id WHERE cd.arc_id=? AND cd.status='available' ORDER BY cd.dv`).all(i.user.id, live.id) as { id: string; e: string; dv: number; r: Rarity; n: string; own: number }[];
  const have = cards.filter((c) => c.own > 0).length;
  const e = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(`${live.name}`)
    .setDescription([live.description, `Ends ${discordTs(live.endsAt, 'R')}. Arc cards spawn **x${live.rateUp}** as often while it lasts.`, `Progress: **${have}/${cards.length}**${live.rewardCardId ? ' · complete it for an exclusive reward card' : ''}`, `Free pack (one per player): \`/arc pack\``].filter(Boolean).join('\n'))
    .addFields({ name: 'Arc cards', value: cards.map((c) => `${c.own ? '✅' : '▫️'} **${c.n}** · ${c.e} · ${RARITY_STYLE[c.r].emoji} DV ${formatDv(c.dv)}`).join('\n').slice(0, 1000) || '—' });
  return void (await i.reply({ embeds: [e], flags: EPH }));
}

async function tradeCommand(app: App, i: ChatInputCommandInteraction): Promise<void> {
  const other = i.options.getUser('user', true);
  const ids = (s: string | null) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const r = proposeTrade(app.ctx, { proposerId: i.user.id, recipientId: other.id, offerCopyIds: ids(i.options.getString('offer', true)), requestCopyIds: ids(i.options.getString('request')) });
  if (!r.ok) return void (await i.reply({ content: TRADE_ERR[r.reason], flags: EPH }));
  await i.reply({ content: `<@${other.id}>, you have a trade proposal. Review both sides below.`, embeds: [tradeEmbed(app, r.tradeId)], components: [tradeRow(r.tradeId, 'pending')], allowedMentions: { users: [other.id] } });
}

// ---------------------------------------------------------------- buttons & modals
async function button(app: App, i: ButtonInteraction): Promise<void> {
  const { ctx } = app;
  const [kind, a, b, c] = i.customId.split(':');
  if (kind === 'catch') {
    const s = ctx.db.prepare('SELECT status, expires_at FROM spawns WHERE id=?').get(a) as { status: string; expires_at: number } | undefined;
    if (!s || s.status !== 'active' || ctx.clock() >= s.expires_at) return void (await i.reply({ content: 'Too late — this one is gone.', flags: EPH })); // UX only; authority is re-checked on submit
    const m = new ModalBuilder().setCustomId(`catchmodal:${a}`).setTitle('Who is this?').addComponents(
      new Row<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('guess').setLabel('Character name').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(64).setRequired(true)));
    return void (await i.showModal(m));
  }
  if (kind === 'pg') {
    const v = views.get(a!);
    if (!v || v.expires < ctx.clock()) return void (await i.update({ content: 'This view expired — run the command again.', embeds: [], components: [] }));
    if (v.userId !== i.user.id) return void (await i.reply({ content: 'This is not your view.', flags: EPH }));
    v.filter.page = (v.filter.page ?? 1) + (b === 'next' ? 1 : -1);
    return void (await i.update(renderView(app, v, a!) as InteractionUpdateOptions));
  }
  if (kind === 'trade') {
    const id = b!;
    const ack = a === 'acceptok' || a === 'confirmok';
    const action = ack ? a!.replace('ok', '') : a;
    const fn = { accept: acceptTrade, decline: declineTrade, cancel: cancelTrade, confirm: confirmTrade }[action as 'accept'];
    if (!fn) return;
    const r = fn(ctx, id, i.user.id, ack);
    if (!r.ok) {
      if (r.reason === 'needs_ack') {
        // Lopsided and the clicker is the one giving more: ask once more, on the same message.
        const stage = action === 'accept' ? 'pending' : 'accepted';
        const w = assessTradeById(ctx, id);
        const note = `⚠️ **You are giving clearly more** (worth ${action === 'accept' ? w?.requestWorth : w?.offerWorth} for ${action === 'accept' ? w?.offerWorth : w?.requestWorth}). Press the red button only if you really want this.`;
        return void (await i.update({ embeds: [tradeEmbed(app, id, note)], components: [tradeRow(id, stage, true)] }));
      }
      if (r.reason === 'revalidation_failed' || r.reason === 'expired' || r.reason === 'bad_state') {
        try { return void (await i.update({ content: TRADE_ERR[r.reason], embeds: getTradeView(ctx.db, id) ? [tradeEmbed(app, id)] : [], components: [] })); } catch { /* fall through */ }
      }
      return void (await i.reply({ content: TRADE_ERR[r.reason], flags: EPH }));
    }
    if (action === 'accept') return void (await i.update({ embeds: [tradeEmbed(app, id, 'Accepted — waiting for the proposer to confirm the final exchange.')], components: [tradeRow(id, 'accepted')] }));
    if (action === 'confirm') {
      const v = getTradeView(ctx.db, id)!;
      evaluateMilestones(ctx, v.trade.proposer_id); evaluateMilestones(ctx, v.trade.recipient_id);
      return void (await i.update({ embeds: [tradeEmbed(app, id, '✅ Completed.')], components: [] }));
    }
    return void (await i.update({ embeds: [tradeEmbed(app, id)], components: [] }));
  }
}

async function modal(app: App, i: ModalSubmitInteraction): Promise<void> {
  const { ctx } = app;
  const [kind, spawnId] = i.customId.split(':');
  if (kind !== 'catchmodal' || !spawnId) return;
  const guess = i.fields.getTextInputValue('guess');
  const r = attemptCatch(ctx, app.limiter, { spawnId, userId: i.user.id, username: i.user.displayName ?? i.user.username, guess });
  if (!r.ok) {
    const text = { rate_limited: `Easy there — try again ${r.reason === 'rate_limited' ? discordTs(ctx.clock() + r.retryAfterMs) : ''}.`, wrong: "❌ That's not it. Try again!", invalid: 'Type a name first.', closed: 'Too late — someone else got it, or it ended.', expired: '⏰ Time\'s up — it got away.', not_found: 'That spawn no longer exists.' }[r.reason];
    return void (await i.reply({ content: text, flags: EPH }));
  }
  const sp = ctx.db.prepare('SELECT channel_id, message_id, character_id FROM spawns WHERE id=?').get(spawnId) as { channel_id: string; message_id: string | null; character_id: string };
  if (r.test) return void (await i.reply({ content: `✅ Correct! (TEST spawn — no card awarded.)`, flags: EPH }));
  const card = getOwnedCard(ctx.db, r.copyId) as OwnedCardView; // reveal comes from the DB row, never from client data
  const settings = i.guildId ? getGuildSettings(ctx, i.guildId) : undefined;
  const { embed, files } = await cardEmbed(card, card.variant, app.env.ASSETS_DIR, { compact: !!settings?.compact_embeds, owner: i.user.displayName ?? i.user.username, title: `🎉 ${i.user.displayName ?? i.user.username} caught ${card.character_name}!`, extra: [`Copy ${copyRef(card.copy_id)}`] });
  const grants = evaluateMilestones(ctx, i.user.id);
  const embeds = [embed, ...grants.map((g) => packEmbed(ctx, `🏆 Milestone: ${g.name}`, g.cards))];
  await i.reply({ embeds, files });
  // Best-effort cosmetic edit of the original spawn message; failure must never affect ownership.
  if (sp.message_id) {
    try {
      const ch = await app.client.channels.fetch(sp.channel_id);
      if (ch?.isTextBased()) await (await ch.messages.fetch(sp.message_id)).edit({ embeds: [new EmbedBuilder().setColor(0x16a34a).setTitle(`${card.character_name} was caught!`).setDescription(`Caught by <@${i.user.id}>`)], components: [], attachments: [] });
    } catch (e) { app.log.warn({ err: e, spawnId }, 'could not edit caught spawn message'); }
  }
}
