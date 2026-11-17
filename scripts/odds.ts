/**
 * Prints the real odds the current catalogue gives, so rarity is never a guess.
 *   npm run odds
 * Spawn odds use weight = DV ^ DV_WEIGHT_EXPONENT. Pack odds are the published tier weights.
 */
import 'dotenv/config';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { gameplayFromEnv } from '../src/gameplay.js';
import { dvProbabilities } from '../src/domain/pick.js';
import { TIERS, formatDv, worthOf } from '../src/domain/value.js';
import { RARITIES } from '../src/types.js';

const cat = loadCatalogueFiles(process.env.CATALOGUE_DIR ?? './catalogue');
const g = gameplayFromEnv(process.env);
const pool = cat.cards.filter((c) => c.available && (!c.arcId)).map((c) => ({ id: c.id, dv: c.dv, rarity: c.tier }));
const p = dvProbabilities(pool, g.dvWeightExponent);
console.log(`Spawn odds (base pool: ${pool.length} cards, exponent ${g.dvWeightExponent})\n`);
for (const t of [...RARITIES].reverse()) {
  const cards = pool.filter((c) => c.rarity === t);
  if (!cards.length) continue;
  const share = cards.reduce((a, c) => a + p.get(c.id)!, 0);
  console.log(`${TIERS[t].emoji} ${TIERS[t].label.padEnd(10)} ${String(cards.length).padStart(3)} cards  ${(share * 100).toFixed(2).padStart(6)}% of spawns`);
}
const rows = [...pool].sort((a, b) => a.dv - b.dv);
const show = (c: (typeof rows)[number]) => `  ${c.id.padEnd(28)} DV ${formatDv(c.dv).padStart(5)}  worth ${String(worthOf(c.dv)).padStart(5)}  1 in ${Math.round(1 / p.get(c.id)!)}`;
console.log('\nRarest 5:\n' + rows.slice(0, 5).map(show).join('\n'));
console.log('\nMost common 5:\n' + rows.slice(-5).map(show).join('\n'));
const tw = g.packTierWeights, tot = Object.values(tw).reduce((a, b) => a + b, 0);
console.log('\nPack tier odds per card:');
for (const t of [...RARITIES].reverse()) console.log(`  ${TIERS[t].emoji} ${TIERS[t].label.padEnd(10)} ${((tw[t] / tot) * 100).toFixed(2)}%`);
console.log(`\nWeekly pack: last card is ${g.weeklyFloorTier.replace('_', ' ')} or better. Pity: Epic or better guaranteed every ${g.packPityCards} pack cards.`);
