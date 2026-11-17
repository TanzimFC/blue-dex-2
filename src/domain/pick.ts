import type { Rng } from '../util/rng.js';
import type { Rarity } from '../types.js';
import { RARITIES } from '../types.js';
import { dropWeight } from './value.js';

export function weightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('no positive weights');
  let r = rng.float() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]!; if (r < 0) return i; }
  return weights.length - 1;
}

export const tierRank = (t: Rarity): number => RARITIES.indexOf(t);

/** A drawable card. `mult` is an optional arc rate-up multiplier (1 when absent). */
export interface Drawable { id: string; dv: number; rarity: Rarity; mult?: number }

/** Spawn pick: weight = DV ^ exponent (x arc multiplier). The number printed on a card is therefore its real odds. */
export function pickByDv<T extends Drawable>(defs: T[], exponent: number, rng: Rng): T {
  if (!defs.length) throw new Error('empty pool');
  return defs[weightedIndex(defs.map((d) => dropWeight(d.dv, exponent) * (d.mult ?? 1)), rng)]!;
}

/** Relative chance of each card in `defs` (sums to 1). Used by the odds script and tests. */
export function dvProbabilities<T extends Drawable>(defs: T[], exponent: number): Map<string, number> {
  const w = defs.map((d) => dropWeight(d.dv, exponent) * (d.mult ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  return new Map(defs.map((d, i) => [d.id, w[i]! / total]));
}

/**
 * Pack pick: choose a TIER by the published tier odds (only tiers that have cards, and only tiers >= `floor`),
 * then a card uniformly inside that tier. If nothing at or above the floor exists, the best available tier is used.
 */
export function pickPackCard<T extends { rarity: Rarity }>(defs: T[], tierWeights: Record<Rarity, number>, rng: Rng, floor?: Rarity): T {
  if (!defs.length) throw new Error('empty pool');
  let tiers = [...new Set(defs.map((d) => d.rarity))];
  if (floor) {
    const eligible = tiers.filter((t) => tierRank(t) >= tierRank(floor));
    tiers = eligible.length ? eligible : [tiers.sort((a, b) => tierRank(b) - tierRank(a))[0]!];
  }
  const usable = tiers.filter((t) => tierWeights[t] > 0);
  const pool = usable.length ? usable : tiers;
  const tier = pool[weightedIndex(pool.map((t) => tierWeights[t] || 1), rng)]!;
  const cards = defs.filter((d) => d.rarity === tier);
  return cards[rng.int(cards.length)]!;
}

/** The Dex pool: available cards of active characters, arc cards only while their arc is live (with the arc's rate-up). */
export const LIVE_POOL_SQL = `
  SELECT cd.id, cd.character_id, cd.dv, cd.rarity, cd.arc_id, CASE WHEN cd.arc_id IS NOT NULL THEN a.rate_up ELSE 1 END AS mult
  FROM card_definitions cd
  JOIN characters ch ON ch.id = cd.character_id AND ch.status = 'active'
  LEFT JOIN arcs a ON a.id = cd.arc_id
  WHERE cd.status = 'available' AND (cd.arc_id IS NULL OR (a.starts_at <= @now AND @now < a.ends_at))`;

export interface PoolCard extends Drawable { character_id: string; arc_id: string | null; mult: number }
