import { EmbedBuilder } from 'discord.js';
import type { OwnedCardView, DexEntry, ListSort } from '../domain/collection.js';
import type { Rarity, Variant } from '../types.js';
import { RARITIES } from '../types.js';
import { TIERS, effectiveDv, formatDv, worthOf } from '../domain/value.js';
import { cardAttachment, cardImage, type RenderableCard } from './cardImage.js';

export const RARITY_STYLE = Object.fromEntries(RARITIES.map((r) => [r, { color: TIERS[r].color, label: TIERS[r].label, emoji: TIERS[r].emoji }])) as Record<Rarity, { color: number; label: string; emoji: string }>;
export const SHINY_COLOR = 0xffd700;
export const BRAND_COLOR = 0x2b6cb0;
export const variantTag = (v: Variant) => (v === 'shiny' ? '✨ Shiny' : 'Normal');
export const copyRef = (id: string) => `\`#${id}\``;
const dvTag = (dv: number, v: Variant = 'normal') => `DV ${formatDv(effectiveDv(dv, v))}`;

export interface CardLike extends RenderableCard { set_name: string }

/**
 * Standard card embed. The card itself is DRAWN from catalogue data (see render/card.ts); the embed only frames it.
 * Shiny treatment is applied ONLY here (post-catch / owned views), never to spawn messages.
 */
export async function cardEmbed(c: CardLike, variant: Variant, assetsDir: string, opts: { compact?: boolean; extra?: string[]; title?: string; owner?: string | null } = {}) {
  const style = RARITY_STYLE[c.rarity];
  const buf = await cardImage(c, variant, assetsDir, opts.owner);
  const worth = worthOf(c.dv, variant);
  const e = new EmbedBuilder()
    .setColor(variant === 'shiny' ? SHINY_COLOR : style.color)
    .setTitle(opts.title ?? `${variant === 'shiny' ? '✨ ' : ''}${c.character_name}`)
    .setDescription([`**${c.edition_name}**`, `${style.emoji} ${style.label} · ${dvTag(c.dv, variant)} · Worth ${worth} · ${c.set_name} · ${variantTag(variant)}`, ...(opts.extra ?? [])].join('\n'));
  if (opts.compact) e.setThumbnail('attachment://card.png'); else e.setImage('attachment://card.png');
  return { embed: e, files: [cardAttachment(buf)] };
}

export function ownedLine(c: OwnedCardView): string {
  const flags = `${c.locked ? ' 🔒' : ''}${c.favorited ? ' ⭐' : ''}${c.state === 'reserved' ? ' 🔁' : ''}`;
  return `${copyRef(c.copy_id)} ${c.variant === 'shiny' ? '✨' : '▫️'} **${c.character_name}** · ${c.edition_name} · ${RARITY_STYLE[c.rarity].emoji} ${dvTag(c.dv, c.variant)}${flags}`;
}
export function dexLine(r: DexEntry): string {
  const own = r.owned_normal + r.owned_shiny;
  const mark = own ? '✅' : '▫️';
  const have = own ? ` — owned ×${own}${r.owned_shiny ? ` (✨${r.owned_shiny})` : ''}` : ' — *not owned*';
  return `${mark} \`${r.card_id}\` **${r.character_name}** · ${r.edition_name} · ${RARITY_STYLE[r.rarity].emoji} ${dvTag(r.dv)}${have}`;
}
export const SORT_LABEL: Record<ListSort, string> = { recent: 'Newest', rarity: 'Rarest first', name: 'Name', variant: 'Variant' };
