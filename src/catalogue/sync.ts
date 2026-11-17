import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import { normalizeAlias } from '../util/normalize.js';
import { existsSync } from 'node:fs';
import { scoreOf, effectiveDv } from '../domain/value.js';
import { validateCatalogue, type Catalogue } from './schema.js';

/** Marker stored in spawn_assets when a character has no hand-made spawn art: the bot renders one neutral silhouette for both variants. */
export const GENERATED_SPAWN_ART = 'gen:silhouette';

export function loadCatalogueFiles(dir: string): Catalogue {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const arcsPath = join(dir, 'arcs.json');
  return validateCatalogue(read('characters.json'), read('cards.json'), existsSync(arcsPath) ? read('arcs.json') : []);
}

/**
 * Idempotently mirror the catalogue files into the DB.
 * Nothing is ever hard-deleted: owned copies reference card definitions, so removed entries become
 * 'unavailable' / 'retired' instead.
 */
export function syncCatalogue(db: Db, cat: Catalogue): void {
  tx(db, () => {
    const upChar = db.prepare(`INSERT INTO characters (id, display_name, status) VALUES (@id,@name,@status)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, status=excluded.status`);
    const upAsset = db.prepare(`INSERT INTO spawn_assets (character_id, normal_spawn_art, shiny_spawn_art) VALUES (?,?,?)
      ON CONFLICT(character_id) DO UPDATE SET normal_spawn_art=excluded.normal_spawn_art, shiny_spawn_art=excluded.shiny_spawn_art`);
    const delAliases = db.prepare('DELETE FROM character_aliases WHERE character_id = ?');
    const insAlias = db.prepare('INSERT OR IGNORE INTO character_aliases (alias, character_id) VALUES (?,?)');
    for (const c of cat.characters) {
      upChar.run({ id: c.id, name: c.name, status: c.status });
      upAsset.run(c.id, c.spawnArt?.normal ?? GENERATED_SPAWN_ART, c.spawnArt?.shiny ?? GENERATED_SPAWN_ART);
      delAliases.run(c.id);
    }
    // Insert after all deletes so an alias moved between characters in one edit works.
    for (const c of cat.characters) for (const a of [c.name, ...c.aliases]) insAlias.run(normalizeAlias(a), c.id);
    const ids = cat.characters.map((c) => c.id);
    db.prepare(`UPDATE characters SET status='retired' WHERE id NOT IN (${ids.map(() => '?').join(',') || "''"})`).run(...ids);

    const upSet = db.prepare('INSERT INTO sets (id, name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
    for (const s of cat.sets) upSet.run(s.id, s.name);
    const upArc = db.prepare(`INSERT INTO arcs (id, name, description, starts_at, ends_at, set_id, rate_up, reward_card_id) VALUES (@id,@name,@description,@startsAt,@endsAt,@setId,@rateUp,@rewardCardId)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        set_id=excluded.set_id, rate_up=excluded.rate_up, reward_card_id=excluded.reward_card_id`);
    for (const a of cat.arcs) upArc.run({ id: a.id, name: a.name, description: a.description, startsAt: Date.parse(a.startsAt), endsAt: Date.parse(a.endsAt), setId: a.setId, rateUp: a.rateUp, rewardCardId: a.rewardCardId ?? null });
    const upCard = db.prepare(`INSERT INTO card_definitions (id, character_id, edition_name, rarity, dv, strike, ego, team, description, release, version_of, arc_id, score_normal, score_shiny, set_id, display_stats, normal_card_art, shiny_card_art, status)
      VALUES (@id,@characterId,@edition,@rarity,@dv,@strike,@ego,@team,@description,@release,@versionOf,@arcId,@scoreNormal,@scoreShiny,@setId,'{}',@normal,@shiny,@status)
      ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id, edition_name=excluded.edition_name, rarity=excluded.rarity, dv=excluded.dv,
        strike=excluded.strike, ego=excluded.ego, team=excluded.team, description=excluded.description, release=excluded.release,
        version_of=excluded.version_of, arc_id=excluded.arc_id, score_normal=excluded.score_normal, score_shiny=excluded.score_shiny,
        set_id=excluded.set_id, normal_card_art=excluded.normal_card_art, shiny_card_art=excluded.shiny_card_art, status=excluded.status`);
    for (const c of cat.cards) {
      upCard.run({ id: c.id, characterId: c.characterId, edition: c.edition, rarity: c.tier, dv: c.dv, strike: c.strike, ego: c.ego, team: c.team ?? null,
        description: c.description, release: c.release, versionOf: c.versionOf ?? null, arcId: c.arcId ?? null,
        scoreNormal: scoreOf(c.dv), scoreShiny: scoreOf(effectiveDv(c.dv, 'shiny')), setId: c.setId,
        normal: c.art?.normal ?? '', shiny: c.art?.shiny ?? c.art?.normal ?? '', status: c.available ? 'available' : 'unavailable' });
    }
    const cids = cat.cards.map((c) => c.id);
    db.prepare(`UPDATE card_definitions SET status='unavailable' WHERE id NOT IN (${cids.map(() => '?').join(',') || "''"})`).run(...cids);
  });
}
