import type { Ctx } from '../context.js';
import { tx } from '../db/database.js';
import type { Rarity, Variant } from '../types.js';
import { LIVE_POOL_SQL, pickByDv, pickPackCard, tierRank, type PoolCard } from './pick.js';
import { nextUtcDayStart, nextUtcWeekStart, utcDayKey, utcWeekKey } from '../util/time.js';
import { ensureCollector, grantCopy } from './collection.js';

export interface PackCard { copyId: string; cardId: string; variant: Variant }
export type ClaimResult =
  | { ok: true; periodKey: string; cards: PackCard[]; nextClaimAt: number; milestones: MilestoneGrant[] }
  | { ok: false; reason: 'already_claimed'; nextClaimAt: number };
export interface MilestoneGrant { questId: string; name: string; cards: PackCard[] }

const livePool = (ctx: Ctx): PoolCard[] => ctx.db.prepare(LIVE_POOL_SQL).all({ now: ctx.clock() }) as PoolCard[];
const laterTier = (a: Rarity | undefined, b: Rarity): Rarity => (a && tierRank(a) > tierRank(b) ? a : b);

/** One pack roll with pity: after `packPityCards` pack cards without an Epic-or-better, the next one is Epic-or-better. Must run inside a transaction. */
function rollPackCard(ctx: Ctx, userId: string, pool: PoolCard[], floor?: Rarity): PoolCard {
  const g = ctx.gameplay;
  const pity = (ctx.db.prepare('SELECT pack_pity AS p FROM collectors WHERE user_id=?').get(userId) as { p: number }).p;
  // Pity target: Epic, or the best tier that exists right now (before any Epic card exists, pity guarantees the best base tier instead).
  const best = pool.reduce((m, c) => (tierRank(c.rarity) > tierRank(m) ? c.rarity : m), pool[0]!.rarity);
  const target: Rarity = tierRank(best) < tierRank('epic') ? best : 'epic';
  const effectiveFloor = pity + 1 >= g.packPityCards ? laterTier(floor, target) : floor;
  const def = pickPackCard(pool, g.packTierWeights, ctx.rng, effectiveFloor);
  ctx.db.prepare('UPDATE collectors SET pack_pity=? WHERE user_id=?').run(tierRank(def.rarity) >= tierRank(target) ? 0 : pity + 1, userId);
  return def;
}

/**
 * Pack odds come ONLY from trusted gameplay config (packTierWeights / packShinyOdds / pity / floor). They are a separate mechanic
 * from spawn odds. `lastFloor` guarantees a minimum tier on the final card. Must be called inside a transaction.
 */
function openPack(ctx: Ctx, userId: string, source: 'daily' | 'weekly' | 'milestone', ref: string, count: number, lastFloor?: Rarity, featured?: PoolCard[]): PackCard[] {
  const pool = livePool(ctx);
  if (!pool.length) throw new Error('no available card definitions for pack');
  const out: PackCard[] = [];
  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const def = featured && isLast
      ? pickByDv(featured, ctx.gameplay.dvWeightExponent, ctx.rng)
      : rollPackCard(ctx, userId, pool, isLast ? lastFloor : undefined);
    const variant: Variant = ctx.rng.float() < ctx.gameplay.packShinyOdds ? 'shiny' : 'normal';
    const copyId = grantCopy(ctx, { ownerId: userId, cardDefinitionId: def.id, variant, source, sourceRef: `${ref}:${i}` });
    out.push({ copyId, cardId: def.id, variant });
  }
  return out;
}

export function periodInfo(type: 'daily' | 'weekly', now: number): { key: string; nextAt: number } {
  return type === 'daily' ? { key: utcDayKey(now), nextAt: nextUtcDayStart(now) } : { key: utcWeekKey(now), nextAt: nextUtcWeekStart(now) };
}

/** Idempotent: the UNIQUE(user, type, period) row is inserted first; only the call that inserts it may grant cards. */
export function claimPeriodic(ctx: Ctx, userId: string, username: string | null, type: 'daily' | 'weekly'): ClaimResult {
  const now = ctx.clock();
  const { key, nextAt } = periodInfo(type, now);
  const res = tx(ctx.db, (): ClaimResult => {
    ensureCollector(ctx.db, userId, username, now);
    const claimId = ctx.rng.uuid();
    const ins = ctx.db.prepare("INSERT INTO reward_claims (id, user_id, reward_type, period_key, claimed_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, reward_type, period_key) DO NOTHING")
      .run(claimId, userId, type, key, now);
    if (ins.changes === 0) return { ok: false, reason: 'already_claimed', nextClaimAt: nextAt };
    const size = type === 'daily' ? ctx.gameplay.dailyPackSize : ctx.gameplay.weeklyPackSize;
    const cards = openPack(ctx, userId, type, claimId, size, type === 'weekly' ? ctx.gameplay.weeklyFloorTier : undefined);
    ctx.db.prepare('UPDATE reward_claims SET detail = ? WHERE id = ?').run(JSON.stringify({ cards }), claimId);
    return { ok: true, periodKey: key, cards, nextClaimAt: nextAt, milestones: [] };
  });
  if (res.ok) res.milestones = evaluateMilestones(ctx, userId);
  return res;
}

/** Create quest rows: first catch, unique-card counts, and one "complete set" quest per set. Idempotent. */
export function seedQuests(ctx: Ctx): void {
  tx(ctx.db, () => {
    const up = ctx.db.prepare(`INSERT INTO quests (id,name,description,kind,target,set_id,reward_cards,reward_card_id) VALUES (@id,@name,@description,@kind,@target,@set_id,@reward,@rewardCard)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, kind=excluded.kind, target=excluded.target, set_id=excluded.set_id, reward_cards=excluded.reward_cards, reward_card_id=excluded.reward_card_id`);
    up.run({ id: 'first_catch', name: 'First Catch', description: 'Catch your first character.', kind: 'first_catch', target: 1, set_id: null, reward: 1, rewardCard: null });
    up.run({ id: 'unique_5', name: 'Rookie Collector', description: 'Own 5 different cards at once.', kind: 'unique_cards', target: 5, set_id: null, reward: 1, rewardCard: null });
    up.run({ id: 'unique_15', name: 'Squad Builder', description: 'Own 15 different cards at once.', kind: 'unique_cards', target: 15, set_id: null, reward: 2, rewardCard: null });
    for (const s of ctx.db.prepare('SELECT s.id, s.name, a.name AS arc_name, a.reward_card_id AS reward_card FROM sets s LEFT JOIN arcs a ON a.set_id = s.id').all() as { id: string; name: string; arc_name: string | null; reward_card: string | null }[]) {
      up.run({ id: `set_${s.id}`, name: s.arc_name ? `${s.arc_name} Complete` : `${s.name} Complete`, description: s.arc_name ? `Own every card of the ${s.arc_name} arc.` : `Own every card in the ${s.name} set.`,
        kind: 'set_complete', target: 1, set_id: s.id, reward: s.reward_card ? 1 : 2, rewardCard: s.reward_card });
    }
  });
}

/**
 * Grant each newly completed milestone exactly once per player, ever. Progress is evaluated from CURRENT ownership,
 * but the grant is recorded permanently, so drop-and-regain cannot farm it. Milestones are also deduplicated by reward_claims UNIQUE.
 */
export function evaluateMilestones(ctx: Ctx, userId: string): MilestoneGrant[] {
  const now = ctx.clock();
  return tx(ctx.db, () => {
    const user = ctx.db.prepare('SELECT total_catches FROM collectors WHERE user_id=?').get(userId) as { total_catches: number } | undefined;
    if (!user) return [];
    const uniq = (ctx.db.prepare("SELECT COUNT(DISTINCT card_definition_id) n FROM owned_cards WHERE owner_id=?").get(userId) as { n: number }).n;
    const quests = ctx.db.prepare(`SELECT * FROM quests WHERE active=1 AND id NOT IN (SELECT quest_id FROM quest_progress WHERE user_id=?)`).all(userId) as
      { id: string; name: string; kind: string; target: number; set_id: string | null; reward_cards: number; reward_card_id: string | null }[];
    const grants: MilestoneGrant[] = [];
    for (const q of quests) {
      let done = false;
      if (q.kind === 'first_catch') done = user.total_catches >= 1;
      else if (q.kind === 'unique_cards') done = uniq >= q.target;
      else if (q.kind === 'set_complete' && q.set_id) {
        const r = ctx.db.prepare(`SELECT COUNT(DISTINCT cd.id) AS total, COUNT(DISTINCT oc.card_definition_id) AS owned FROM card_definitions cd
          LEFT JOIN owned_cards oc ON oc.card_definition_id=cd.id AND oc.owner_id=? WHERE cd.set_id=? AND cd.status='available'`).get(userId, q.set_id) as { total: number; owned: number };
        done = r.total > 0 && r.owned === r.total;
      }
      if (!done) continue;
      const claimId = ctx.rng.uuid();
      const ins = ctx.db.prepare("INSERT INTO reward_claims (id,user_id,reward_type,period_key,claimed_at) VALUES (?,?,'milestone',?,?) ON CONFLICT(user_id,reward_type,period_key) DO NOTHING").run(claimId, userId, q.id, now);
      if (ins.changes === 0) continue;
      const cards = q.reward_card_id
        ? [grantExclusive(ctx, userId, q.reward_card_id, claimId)]
        : openPack(ctx, userId, 'milestone', claimId, q.reward_cards);
      ctx.db.prepare('UPDATE reward_claims SET detail=? WHERE id=?').run(JSON.stringify({ quest: q.id, cards }), claimId);
      ctx.db.prepare('INSERT INTO quest_progress (user_id, quest_id, completed_at, reward_claim_id) VALUES (?,?,?,?)').run(userId, q.id, now, claimId);
      grants.push({ questId: q.id, name: q.name, cards });
    }
    return grants;
  });
}

/** One specific exclusive card (arc reward). Never rolls, never shiny. Must run inside a transaction. */
function grantExclusive(ctx: Ctx, userId: string, cardId: string, ref: string): PackCard {
  const copyId = grantCopy(ctx, { ownerId: userId, cardDefinitionId: cardId, variant: 'normal', source: 'milestone', sourceRef: `${ref}:0` });
  return { copyId, cardId, variant: 'normal' };
}

export interface ArcInfo { id: string; name: string; description: string; startsAt: number; endsAt: number; setId: string; rateUp: number; rewardCardId: string | null; live: boolean; upcoming: boolean }
export const getArcs = (ctx: Ctx): ArcInfo[] => {
  const now = ctx.clock();
  return (ctx.db.prepare('SELECT * FROM arcs ORDER BY starts_at').all() as { id: string; name: string; description: string; starts_at: number; ends_at: number; set_id: string; rate_up: number; reward_card_id: string | null }[])
    .map((a) => ({ id: a.id, name: a.name, description: a.description, startsAt: a.starts_at, endsAt: a.ends_at, setId: a.set_id, rateUp: a.rate_up, rewardCardId: a.reward_card_id, live: a.starts_at <= now && now < a.ends_at, upcoming: now < a.starts_at }));
};
export const liveArc = (ctx: Ctx): ArcInfo | undefined => getArcs(ctx).find((a) => a.live);

export type ArcPackResult =
  | { ok: true; arcId: string; cards: PackCard[]; milestones: MilestoneGrant[] }
  | { ok: false; reason: 'no_live_arc' | 'already_claimed' };

/**
 * One free arc pack per player per arc: `arcPackSize` cards, the last one always a featured card of that arc.
 * Idempotent through the same UNIQUE(user, type, period) guard as daily/weekly (period key `arcpack:<arc>`).
 */
export function claimArcPack(ctx: Ctx, userId: string, username: string | null): ArcPackResult {
  const arc = liveArc(ctx);
  if (!arc) return { ok: false, reason: 'no_live_arc' };
  const res = tx(ctx.db, (): ArcPackResult => {
    const now = ctx.clock();
    ensureCollector(ctx.db, userId, username, now);
    const claimId = ctx.rng.uuid();
    const ins = ctx.db.prepare("INSERT INTO reward_claims (id, user_id, reward_type, period_key, claimed_at) VALUES (?,?,'milestone',?,?) ON CONFLICT(user_id, reward_type, period_key) DO NOTHING")
      .run(claimId, userId, `arcpack:${arc.id}`, now);
    if (ins.changes === 0) return { ok: false, reason: 'already_claimed' };
    const featured = livePool(ctx).filter((c) => c.arc_id === arc.id);
    if (!featured.length) throw new Error(`arc ${arc.id} has no available cards`);
    const cards = openPack(ctx, userId, 'milestone', claimId, ctx.gameplay.arcPackSize, undefined, featured);
    ctx.db.prepare('UPDATE reward_claims SET detail = ? WHERE id = ?').run(JSON.stringify({ arc: arc.id, cards }), claimId);
    return { ok: true, arcId: arc.id, cards, milestones: [] };
  });
  if (res.ok) res.milestones = evaluateMilestones(ctx, userId);
  return res;
}
