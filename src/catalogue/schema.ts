import { z } from 'zod';
import { normalizeAlias } from '../util/normalize.js';
import { TIERS, isValidDv, statInRange, tierForDv } from '../domain/value.js';
import type { Rarity } from '../types.js';

const id = z.string().regex(/^[a-z0-9_]{1,48}$/, 'ids are lowercase a-z, 0-9, underscore');
/** Asset ref: absolute https URL, or `file:` path relative to ASSETS_DIR. */
const assetRef = z.string().refine((s) => /^https:\/\/\S+$/.test(s) || /^file:[A-Za-z0-9_./-]+$/.test(s) && !s.includes('..'), 'must be https:// URL or file:relative/path');

/** spawnArt is optional: without it the bot generates ONE identical silhouette for both variants (nothing can leak shininess). */
export const characterSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  aliases: z.array(z.string().min(1).max(64)).max(20).default([]),
  status: z.enum(['active', 'retired']).default('active'),
  spawnArt: z.object({ normal: assetRef, shiny: assetRef }).optional(),
});
export const setSchema = z.object({ id, name: z.string().min(1).max(64) });

/** Card portraits are local files (the card is drawn by the bot, so remote art is never fetched at render time). */
const fileRef = z.string().regex(/^file:[A-Za-z0-9_./-]+$/, 'portrait must be file:relative/path.png').refine((s) => !s.includes('..'), 'no ..');
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date like 2026-12-01T00:00:00Z');
export const arcSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  description: z.string().max(400).default(''),
  startsAt: iso,
  endsAt: iso,
  setId: id,
  /** Spawn-weight multiplier for this arc's cards while the arc is live. */
  rateUp: z.number().min(1).max(10).default(3),
  /** Exclusive card granted once when a player completes the arc set. Must be a card with available:false. */
  rewardCardId: id.optional(),
});

export const RELEASES = ['base', 'arc', 'event', 'reward'] as const;
export const cardSchema = z.object({
  id,
  characterId: id,
  edition: z.string().min(1).max(64),
  /** Dex Value: 0.1 (rarest) to 100.0 (most common), one decimal. The tier is derived from it. */
  dv: z.number().refine(isValidDv, 'dv must be between 0.1 and 100 with at most one decimal'),
  strike: z.number().int(),
  ego: z.number().int(),
  /** Shown on the card (e.g. "Team Z"). Optional. */
  team: z.string().max(40).optional(),
  /** Optional flavour text. Base cards need none; special cards usually have it. */
  description: z.string().max(220).default(''),
  release: z.enum(RELEASES).default('base'),
  /** Special versions point at the character's base card. Their DV must be LOWER (rarer) than the base. */
  versionOf: id.optional(),
  arcId: id.optional(),
  setId: id,
  /** Portrait for the rendered card. Optional: falls back to assets/portraits/<characterId>.png, then a placeholder. */
  art: z.object({ normal: fileRef, shiny: fileRef.optional() }).optional(),
  available: z.boolean().default(true),
});
export const cardsFileSchema = z.object({ sets: z.array(setSchema), cards: z.array(cardSchema) });

export type CatalogueCharacter = z.infer<typeof characterSchema>;
export type CatalogueCard = z.infer<typeof cardSchema> & { tier: Rarity };
export type CatalogueArc = z.infer<typeof arcSchema>;
export interface Catalogue { characters: CatalogueCharacter[]; sets: z.infer<typeof setSchema>[]; arcs: CatalogueArc[]; cards: CatalogueCard[] }

export class CatalogueError extends Error {
  constructor(public problems: string[]) {
    super('Invalid catalogue:\n - ' + problems.join('\n - '));
  }
}

/** Parse + cross-validate. Collects every problem rather than failing on the first. */
export function validateCatalogue(rawCharacters: unknown, rawCards: unknown, rawArcs: unknown = []): Catalogue {
  const problems: string[] = [];
  const chars = z.array(characterSchema).safeParse(rawCharacters);
  const cards = cardsFileSchema.safeParse(rawCards);
  const arcs = z.array(arcSchema).safeParse(rawArcs);
  if (!chars.success) problems.push(...chars.error.issues.map((i) => `characters.json ${i.path.join('.')}: ${i.message}`));
  if (!cards.success) problems.push(...cards.error.issues.map((i) => `cards.json ${i.path.join('.')}: ${i.message}`));
  if (!arcs.success) problems.push(...arcs.error.issues.map((i) => `arcs.json ${i.path.join('.')}: ${i.message}`));
  if (!chars.success || !cards.success || !arcs.success) throw new CatalogueError(problems);

  const seen = (label: string, ids: string[]) => {
    const s = new Set<string>();
    for (const x of ids) { if (s.has(x)) problems.push(`duplicate ${label} id "${x}"`); s.add(x); }
  };
  seen('character', chars.data.map((c) => c.id));
  seen('set', cards.data.sets.map((s) => s.id));
  seen('card', cards.data.cards.map((c) => c.id));
  seen('arc', arcs.data.map((a) => a.id));

  // Ambiguous aliases must never resolve to two characters.
  const owner = new Map<string, string>();
  for (const c of chars.data) {
    for (const a of [c.name, ...c.aliases]) {
      const key = normalizeAlias(a);
      if (!key) { problems.push(`character ${c.id}: alias "${a}" normalises to empty`); continue; }
      const prev = owner.get(key);
      if (prev && prev !== c.id) problems.push(`ambiguous alias "${a}" (key "${key}") used by both ${prev} and ${c.id}`);
      owner.set(key, c.id);
    }
    // Spawn art must not leak the variant through its URL.
    if (c.spawnArt) for (const [kind, ref] of [['normal', c.spawnArt.normal], ['shiny', c.spawnArt.shiny]] as const) {
      if (ref.startsWith('https://') && /shiny|normal/i.test(ref)) {
        problems.push(`character ${c.id}: ${kind} spawn art URL must be opaque (must not contain "shiny" or "normal"): ${ref}`);
      }
    }
  }
  const charIds = new Set(chars.data.map((c) => c.id));
  const setIds = new Set(cards.data.sets.map((s) => s.id));
  const arcById = new Map(arcs.data.map((a) => [a.id, a]));
  const cardById = new Map(cards.data.cards.map((c) => [c.id, c]));

  for (const a of arcs.data) {
    if (!setIds.has(a.setId)) problems.push(`arc ${a.id}: unknown setId ${a.setId}`);
    if (Date.parse(a.endsAt) <= Date.parse(a.startsAt)) problems.push(`arc ${a.id}: endsAt must be after startsAt`);
    if (a.rewardCardId) {
      const rc = cardById.get(a.rewardCardId);
      if (!rc) problems.push(`arc ${a.id}: unknown rewardCardId ${a.rewardCardId}`);
      else if (rc.available) problems.push(`arc ${a.id}: reward card ${rc.id} must have "available": false so it can never spawn or appear in packs`);
    }
  }

  const out: CatalogueCard[] = [];
  const baseOf = new Map<string, string>(); // characterId -> base card id
  for (const card of cards.data.cards) {
    const tier = tierForDv(card.dv);
    const t = TIERS[tier];
    if (!charIds.has(card.characterId)) problems.push(`card ${card.id}: unknown characterId ${card.characterId}`);
    if (!setIds.has(card.setId)) problems.push(`card ${card.id}: unknown setId ${card.setId}`);
    for (const [k, v] of [['strike', card.strike], ['ego', card.ego]] as const) {
      if (!statInRange(tier, v)) problems.push(`card ${card.id}: ${k} ${v} is outside the ${t.label} range ${t.minStat}-${t.maxStat} (dv ${card.dv})`);
    }
    if (card.release === 'base') {
      if (card.versionOf || card.arcId) problems.push(`card ${card.id}: a base card cannot have versionOf or arcId`);
      if (tier === 'legendary' || tier === 'mythic') problems.push(`card ${card.id}: base cards cannot be ${t.label}; Legendary and Mythic exist only as special versions`);
      const prev = baseOf.get(card.characterId);
      if (prev) problems.push(`card ${card.id}: character ${card.characterId} already has base card ${prev}`);
      baseOf.set(card.characterId, card.id);
    }
    out.push({ ...card, tier });
  }
  for (const card of out) {
    if (card.release !== 'base') {
      const base = card.versionOf ? cardById.get(card.versionOf) : undefined;
      if (!card.versionOf) problems.push(`card ${card.id}: release "${card.release}" needs versionOf (the base card id)`);
      else if (!base) problems.push(`card ${card.id}: unknown versionOf ${card.versionOf}`);
      else {
        if (base.release !== 'base') problems.push(`card ${card.id}: versionOf must point at a base card, ${base.id} is "${base.release}"`);
        if (base.characterId !== card.characterId) problems.push(`card ${card.id}: versionOf ${base.id} belongs to a different character`);
        if (card.dv >= base.dv) problems.push(`card ${card.id}: a special version must be rarer than its base (dv ${card.dv} must be lower than ${base.id} dv ${base.dv})`);
      }
    }
    if (card.release === 'arc') {
      const arc = card.arcId ? arcById.get(card.arcId) : undefined;
      if (!card.arcId) problems.push(`card ${card.id}: release "arc" needs arcId`);
      else if (!arc) problems.push(`card ${card.id}: unknown arcId ${card.arcId}`);
      else if (arc.setId !== card.setId) problems.push(`card ${card.id}: arc cards must use the arc's set (${arc.setId})`);
    } else if (card.arcId) problems.push(`card ${card.id}: only release "arc" cards may have an arcId`);
  }
  if (problems.length) throw new CatalogueError(problems);
  return { characters: chars.data, sets: cards.data.sets, arcs: arcs.data, cards: out };
}
