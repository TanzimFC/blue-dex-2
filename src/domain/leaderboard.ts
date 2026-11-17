import type { Db } from '../db/database.js';

export type Board = 'unique' | 'completion' | 'shiny' | 'score';

/**
 * Collection score (docs/ECONOMY.md): for every DISTINCT card currently owned, score = 10 + 10 per halving of DV
 * (DV 100 = 10, DV 50 = 20, DV 0.1 = 110), precomputed per card at catalogue sync. A card owned as a shiny scores at its shiny DV (DV / 3).
 * Duplicates never add score. Nothing here can be bought.
 */

export interface BoardRow { rank: number; userId: string; username: string | null; value: number }

export function leaderboard(db: Db, board: Board, limit = 10): BoardRow[] {
  const size = (db.prepare("SELECT COUNT(*) n FROM card_definitions WHERE status='available'").get() as { n: number }).n || 1;
  const base = `
    SELECT c.user_id AS user_id, c.username AS username,
      COUNT(DISTINCT d.def) AS uniq,
      COUNT(DISTINCT CASE WHEN d.shiny=1 THEN d.def END) AS uniq_shiny,
      COALESCE(SUM(d.pts),0) AS score
    FROM collectors c
    JOIN (SELECT oc.owner_id AS owner, oc.card_definition_id AS def, MAX(oc.variant='shiny') AS shiny,
            (CASE WHEN MAX(oc.variant='shiny') = 1 THEN cd.score_shiny ELSE cd.score_normal END) AS pts
          FROM owned_cards oc JOIN card_definitions cd ON cd.id=oc.card_definition_id
          WHERE cd.status='available' GROUP BY oc.owner_id, oc.card_definition_id) d ON d.owner = c.user_id
    WHERE c.profile_public = 1
    GROUP BY c.user_id`;
  const col = { unique: 'uniq', completion: 'uniq', shiny: 'uniq_shiny', score: 'score' }[board];
  const rows = db.prepare(`SELECT * FROM (${base}) ORDER BY ${col} DESC, user_id LIMIT ?`).all(Math.min(Math.max(limit, 1), 25)) as
    { user_id: string; username: string | null; uniq: number; uniq_shiny: number; score: number }[];
  return rows.map((r, i) => ({
    rank: i + 1, userId: r.user_id, username: r.username,
    value: board === 'completion' ? Math.round((r.uniq / size) * 1000) / 10 : board === 'unique' ? r.uniq : board === 'shiny' ? r.uniq_shiny : r.score,
  }));
}
void (0 as unknown);
