/** Lists which characters still need a portrait file. Put each image at assets/portraits/<character id>.png (jpg/webp also work). */
import 'dotenv/config';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { portraitPathFor } from '../src/discord/art.js';

const cat = loadCatalogueFiles(process.env.CATALOGUE_DIR ?? './catalogue');
const assets = process.env.ASSETS_DIR ?? './assets';
const have: string[] = [], need: string[] = [];
for (const ch of cat.characters) (portraitPathFor(assets, ch.id, cat.cards.find((x) => x.characterId === ch.id && x.art)?.art?.normal) ? have : need).push(ch.id);
console.log(`portraits present: ${have.length}/${cat.characters.length}`);
if (need.length) console.log('\nstill needed (file name = id + .png):\n' + need.map((id) => `  assets/portraits/${id}.png`).join('\n'));
