import { AttachmentBuilder } from 'discord.js';
import type { Variant, Rarity } from '../types.js';
import { renderCard, renderSpawnArt } from '../render/card.js';
import { portraitPathFor } from './art.js';

/** What the renderer needs from a card row (owned copy view, dex entry or catalogue lookup). */
export interface RenderableCard {
  card_id: string; character_id: string; character_name: string; edition_name: string; rarity: Rarity; dv: number;
  strike: number; ego: number; team: string | null; description: string; normal_card_art: string; shiny_card_art: string;
}

let credit = 'TanzimFC';
export const setCardCredit = (name: string) => { credit = name; };

/** Tiny LRU so a busy server re-sending the same card does not re-render it. 457x640 PNGs are ~100-250 KB each. */
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V): void { this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
}
const cards = new Lru<Buffer>(60);
const spawns = new Lru<Buffer>(40);

export async function cardImage(c: RenderableCard, variant: Variant, assetsDir: string, ownerName?: string | null): Promise<Buffer> {
  const key = `${c.card_id}|${variant}|${ownerName ?? ''}`;
  const hit = cards.get(key); if (hit) return hit;
  const buf = await renderCard({
    name: c.character_name, edition: c.edition_name, dv: c.dv, tier: c.rarity, strike: c.strike, ego: c.ego, team: c.team, description: c.description,
    variant, ownerName, designedBy: credit,
    portraitPath: portraitPathFor(assetsDir, c.character_id, variant === 'shiny' && c.shiny_card_art ? c.shiny_card_art : c.normal_card_art),
  });
  cards.set(key, buf); return buf;
}

export const cardAttachment = (buf: Buffer) => new AttachmentBuilder(buf, { name: 'card.png' });

/** One neutral "who's that?" image per character, identical for normal and shiny spawns. */
export async function generatedSpawnArt(characterId: string, assetsDir: string): Promise<Buffer> {
  const hit = spawns.get(characterId); if (hit) return hit;
  const buf = await renderSpawnArt(portraitPathFor(assetsDir, characterId));
  spawns.set(characterId, buf); return buf;
}
