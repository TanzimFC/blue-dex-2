import type { Rarity, Variant } from '../types.js';

/**
 * THE BLUE DEX ECONOMY (single source of truth; docs/ECONOMY.md explains it for humans).
 *
 *  DV (Dex Value)  : lower = rarer. 0.1 is the rarest possible card, 100.0 the most common.
 *  Tier            : derived from DV (never stored by hand, so they cannot disagree).
 *  Worth           : 100 / DV  ->  "half the DV, double the worth". Trades are judged on Worth.
 *  Drop weight     : DV ^ dvWeightExponent (gameplay config), so the number on the card IS the odds.
 *  Shiny           : the same card with DV / 3 (floor 0.1). Hidden until caught, as always.
 *  Stats           : exactly two, STRIKE and EGO, always inside the range of the card's tier.
 */
export interface TierInfo {
  key: Rarity; label: string; emoji: string; color: number;
  /** inclusive DV bounds (one decimal place) */
  minDv: number; maxDv: number;
  /** inclusive stat bounds for STRIKE and EGO */
  minStat: number; maxStat: number;
  blurb: string;
}

export const TIERS: Record<Rarity, TierInfo> = {
  common:     { key: 'common',     label: 'Common',     emoji: '👟', color: 0x9aa5b1, minDv: 60,  maxDv: 100, minStat: 100, maxStat: 129, blurb: 'Widely available. Fodder, background players, trade filler.' },
  rare:       { key: 'rare',       label: 'Rare',       emoji: '💎', color: 0x3b82f6, minDv: 20,  maxDv: 59.9, minStat: 130, maxStat: 149, blurb: 'The standard card of a named character.' },
  super_rare: { key: 'super_rare', label: 'Super Rare', emoji: '✨', color: 0x14b8a6, minDv: 6,   maxDv: 19.9, minStat: 150, maxStat: 169, blurb: 'The backbone of serious collections.' },
  epic:       { key: 'epic',       label: 'Epic',       emoji: '⚡', color: 0x9b59b6, minDv: 2,   maxDv: 5.9, minStat: 170, maxStat: 189, blurb: 'Hard to pull. Excellent trade bait.' },
  legendary:  { key: 'legendary',  label: 'Legendary',  emoji: '🌟', color: 0xf5a623, minDv: 0.6, maxDv: 1.9, minStat: 190, maxStat: 209, blurb: 'Ultra rare. Heavily hoarded.' },
  mythic:     { key: 'mythic',     label: 'Mythic',     emoji: '👑', color: 0xef4444, minDv: 0.1, maxDv: 0.5, minStat: 210, maxStat: 240, blurb: 'Absolute peak rarity. Miss it and cry.' },
};

export const DV_MIN = 0.1;
export const DV_MAX = 100;
export const SHINY_DV_DIVISOR = 3;

export const roundDv = (n: number): number => Math.round(n * 10) / 10;
export const isValidDv = (dv: number): boolean => Number.isFinite(dv) && dv >= DV_MIN && dv <= DV_MAX && Math.abs(dv * 10 - Math.round(dv * 10)) < 1e-9;
export const formatDv = (dv: number): string => (dv < 10 ? dv.toFixed(1) : Number.isInteger(dv) ? String(dv) : dv.toFixed(1));

export function tierForDv(dv: number): Rarity {
  if (dv < 0.6) return 'mythic';
  if (dv < 2) return 'legendary';
  if (dv < 6) return 'epic';
  if (dv < 20) return 'super_rare';
  if (dv < 60) return 'rare';
  return 'common';
}

/** The DV a given copy is traded and scored at. Shiny = base DV / 3, never below the global floor. */
export const effectiveDv = (dv: number, variant: Variant): number => (variant === 'shiny' ? Math.max(DV_MIN, roundDv(dv / SHINY_DV_DIVISOR)) : dv);

/** Trade worth: 100 / DV, one decimal. DV 10 -> 10, DV 2 -> 50, DV 0.1 -> 1000. */
export const worthOf = (dv: number, variant: Variant = 'normal'): number => Math.round((100 / effectiveDv(dv, variant)) * 10) / 10;

/** Relative spawn/pack weight of a card. exponent 1 = DV is literally the odds; lower exponent compresses the extremes. */
export const dropWeight = (dv: number, exponent: number): number => Math.pow(dv, exponent);

/** Collection score: 10 points per halving of DV, plus a 10 base. DV 100 -> 10, DV 50 -> 20, DV 25 -> 30, DV 0.1 -> 110. */
export const scoreOf = (dv: number): number => Math.round(10 + 10 * Math.log2(100 / dv));

export interface ValuedCopy { dv: number; variant: Variant }
export type TradeVerdict = 'fair' | 'lopsided';
export interface TradeAssessment {
  offerWorth: number; requestWorth: number;
  verdict: TradeVerdict;
  /** who gives clearly more. null when the trade is fair. */
  giver: 'proposer' | 'recipient' | null;
}

export interface FairnessRules { tolerance: number; minGapWorth: number }
export const defaultFairness: FairnessRules = { tolerance: 0.15, minGapWorth: 5 };

/**
 * Fair = the two sides are within `tolerance` of each other, OR the absolute gap is smaller than `minGapWorth`
 * (so swapping two commons never nags). Lopsided trades are NEVER blocked (friends gift cards); the side that gives
 * more is asked to confirm once more.
 */
export function assessTrade(offer: ValuedCopy[], request: ValuedCopy[], rules: FairnessRules = defaultFairness): TradeAssessment {
  const sum = (xs: ValuedCopy[]) => Math.round(xs.reduce((a, c) => a + worthOf(c.dv, c.variant), 0) * 10) / 10;
  const o = sum(offer), r = sum(request);
  const gap = Math.abs(o - r), hi = Math.max(o, r);
  const fair = gap < rules.minGapWorth || gap <= hi * rules.tolerance;
  return { offerWorth: o, requestWorth: r, verdict: fair ? 'fair' : 'lopsided', giver: fair ? null : o > r ? 'proposer' : 'recipient' };
}

export const statInRange = (tier: Rarity, stat: number): boolean => Number.isInteger(stat) && stat >= TIERS[tier].minStat && stat <= TIERS[tier].maxStat;

/** "1 in N" chance of one specific card, given every card's weight. Used by the odds script and /dex detail. */
export function oneInN(weight: number, totalWeight: number): number { return totalWeight / weight; }
