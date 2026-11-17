import 'dotenv/config';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { portraitPathFor } from '../src/discord/art.js';
import { TIERS } from '../src/domain/value.js';
import { RARITIES } from '../src/types.js';

const dir = process.env.CATALOGUE_DIR ?? './catalogue';
const assets = process.env.ASSETS_DIR ?? './assets';
try {
  const c = loadCatalogueFiles(dir);
  console.log(`catalogue OK: ${c.characters.length} characters, ${c.cards.length} cards, ${c.sets.length} sets, ${c.arcs.length} arcs`);
  for (const t of [...RARITIES].reverse()) {
    const n = c.cards.filter((x) => x.tier === t).length;
    if (n) console.log(`  ${TIERS[t].emoji} ${TIERS[t].label.padEnd(10)} ${n}`);
  }
  const missing = c.characters.filter((ch) => !portraitPathFor(assets, ch.id, c.cards.find((x) => x.characterId === ch.id && x.art)?.art?.normal));
  console.log(missing.length
    ? `portraits: ${c.characters.length - missing.length}/${c.characters.length} present. Missing ones use a placeholder (run \`npm run art:check\` for the list).`
    : 'portraits: all present');
} catch (e) { console.error((e as Error).message); process.exit(1); }
