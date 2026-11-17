/** Tier keys, ordered from most common to rarest. The tier is DERIVED from a card's Dex Value (DV); see domain/value.ts. */
export const RARITIES = ['common', 'rare', 'super_rare', 'epic', 'legendary', 'mythic'] as const;
export type Rarity = (typeof RARITIES)[number];
export const VARIANTS = ['normal', 'shiny'] as const;
export type Variant = (typeof VARIANTS)[number];
export type Clock = () => number; // epoch ms, server-side
