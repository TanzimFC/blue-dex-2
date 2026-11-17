import type { Rarity } from './types.js';

/** FIXED RULE (spec §2). Not configurable by env or by anyone. */
export const CATCH_WINDOW_MS = 180_000 as const;

/** Trusted, operator-only gameplay configuration. Never exposed via /settings, /setup or any public command. */
export interface GameplayConfig {
  shinySpawnOdds: number;
  /** Spawn weight of a card = DV ^ this. 1 = DV is literally the odds; 0.6 compresses the extremes so Mythic is rare but reachable. */
  dvWeightExponent: number;
  packShinyOdds: number; // separate mechanic from spawn shiny odds
  /** Published pack odds per tier (relative weights). Within a tier the card is chosen uniformly. */
  packTierWeights: Record<Rarity, number>;
  dailyPackSize: number;
  weeklyPackSize: number;
  /** The LAST card of a weekly pack is at least this tier. */
  weeklyFloorTier: Rarity;
  /** Hard pity: after this many pack cards without an Epic-or-better, the next pack card is Epic-or-better. */
  packPityCards: number;
  /** Arc pack (one claim per arc): total cards, of which exactly one is a featured arc card. */
  arcPackSize: number;
  spawn: {
    minIntervalMs: number; // hard floor between non-test spawns in one guild
    maxIntervalMs: number;
    minActivityMessages: number; // messages in channel since last spawn before the next may appear
    maxPerGuildPerHour: number; // hard cap enforced in the DB-backed spawn service
    tickMs: number;
  };
  guess: {
    minGapMs: number;
    windowMs: number;
    maxWrongPerWindow: number;
    lockoutMs: number;
    guildMaxPerWindow: number;
    guildWindowMs: number;
  };
  trade: { expiryMs: number; maxItemsPerSide: number; fairTolerance: number; minGapWorth: number };
}

export const defaultGameplay: GameplayConfig = {
  shinySpawnOdds: 0, // shiny is PAUSED: 0 means no shiny spawns. The engine stays ready (set SHINY_SPAWN_ODDS to bring it back).
  dvWeightExponent: 0.6,
  packShinyOdds: 0,
  packTierWeights: { common: 62, rare: 27, super_rare: 8, epic: 2.5, legendary: 0.45, mythic: 0.05 },
  dailyPackSize: 1,
  weeklyPackSize: 3,
  weeklyFloorTier: 'super_rare',
  packPityCards: 50,
  arcPackSize: 3,
  spawn: { minIntervalMs: 15 * 60_000, maxIntervalMs: 40 * 60_000, minActivityMessages: 5, maxPerGuildPerHour: 3, tickMs: 30_000 },
  guess: { minGapMs: 1_500, windowMs: 60_000, maxWrongPerWindow: 8, lockoutMs: 60_000, guildMaxPerWindow: 40, guildWindowMs: 10_000 },
  trade: { expiryMs: 15 * 60_000, maxItemsPerSide: 5, fairTolerance: 0.15, minGapWorth: 5 },
};

function num(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number in [${min}, ${max}]`);
  return n;
}

export function gameplayFromEnv(env: NodeJS.ProcessEnv): GameplayConfig {
  const g: GameplayConfig = structuredClone(defaultGameplay);
  g.shinySpawnOdds = num(env, 'SHINY_SPAWN_ODDS', 0, 1) ?? g.shinySpawnOdds;
  g.packShinyOdds = num(env, 'PACK_SHINY_ODDS', 0, 1) ?? g.packShinyOdds;
  g.dvWeightExponent = num(env, 'DV_WEIGHT_EXPONENT', 0.3, 1) ?? g.dvWeightExponent;
  const mn = num(env, 'SPAWN_MIN_INTERVAL_MIN', 1, 1440);
  const mx = num(env, 'SPAWN_MAX_INTERVAL_MIN', 1, 2880);
  if (mn !== undefined) g.spawn.minIntervalMs = mn * 60_000;
  if (mx !== undefined) g.spawn.maxIntervalMs = mx * 60_000;
  if (g.spawn.maxIntervalMs < g.spawn.minIntervalMs) throw new Error('SPAWN_MAX_INTERVAL_MIN must be >= SPAWN_MIN_INTERVAL_MIN');
  g.spawn.maxPerGuildPerHour = num(env, 'SPAWN_MAX_PER_GUILD_PER_HOUR', 1, 20) ?? g.spawn.maxPerGuildPerHour;
  return g;
}
