/**
 * Renders cards to ./preview so you can look at them without Discord.
 *   npm run cards:preview            -> a few sample cards
 *   npm run cards:preview -- all     -> every card
 *   npm run cards:preview -- <card id> [<card id> ...]
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { portraitPathFor } from '../src/discord/art.js';
import { initFonts, renderCard, renderSpawnArt } from '../src/render/card.js';

const assets = process.env.ASSETS_DIR ?? './assets';
initFonts(assets);
const cat = loadCatalogueFiles(process.env.CATALOGUE_DIR ?? './catalogue');
const args = process.argv.slice(2);
const sorted = [...cat.cards].sort((a, b) => a.dv - b.dv);
const picks = args[0] === 'all' ? cat.cards : args.length ? cat.cards.filter((c) => args.includes(c.id)) : [sorted[0]!, sorted[Math.floor(sorted.length / 2)]!, sorted.at(-1)!];
mkdirSync('preview', { recursive: true });
for (const c of picks) {
  const ch = cat.characters.find((x) => x.id === c.characterId)!;
  const portrait = portraitPathFor(assets, ch.id, c.art?.normal);
  writeFileSync(join('preview', `${c.id}.png`), await renderCard({ name: ch.name, edition: c.edition, dv: c.dv, tier: c.tier, strike: c.strike, ego: c.ego, team: c.team, description: c.description, variant: 'normal', portraitPath: portrait, ownerName: 'Preview' }));
  writeFileSync(join('preview', `${c.id}.spawn.png`), await renderSpawnArt(portrait));
}
console.log(`wrote ${picks.length} card(s) + spawn image(s) to ./preview`);
