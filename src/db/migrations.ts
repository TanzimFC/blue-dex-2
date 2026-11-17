/** `rebuildsTables`: the migration recreates tables that other tables reference, so it runs with foreign keys OFF (SQLite's documented procedure) and is verified with foreign_key_check before commit. */
export interface Migration { version: number; name: string; sql: string; rebuildsTables?: boolean }

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE collectors (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 25),
  created_at INTEGER NOT NULL,
  username TEXT,                                   -- display cache only; NEVER an identifier
  profile_public INTEGER NOT NULL DEFAULT 1 CHECK (profile_public IN (0,1)),
  preferences TEXT NOT NULL DEFAULT '{}',
  total_catches INTEGER NOT NULL DEFAULT 0 CHECK (total_catches >= 0),
  total_shiny_catches INTEGER NOT NULL DEFAULT 0 CHECK (total_shiny_catches >= 0)
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_]*'),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired'))
);

-- alias is the NORMALISED key; PRIMARY KEY makes an ambiguous alias impossible at the DB level.
CREATE TABLE character_aliases (
  alias TEXT PRIMARY KEY CHECK (length(alias) > 0),
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE
);
CREATE INDEX idx_aliases_character ON character_aliases(character_id);

-- Spawn art: independent from card art. Normal and shiny are separate references.
CREATE TABLE spawn_assets (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  normal_spawn_art TEXT NOT NULL,
  shiny_spawn_art TEXT NOT NULL
);

CREATE TABLE sets (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_]*'),
  name TEXT NOT NULL
);

CREATE TABLE card_definitions (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_]*'),
  character_id TEXT NOT NULL REFERENCES characters(id),
  edition_name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common','uncommon','rare','epic','legendary')),
  set_id TEXT NOT NULL REFERENCES sets(id),
  display_stats TEXT NOT NULL DEFAULT '{}',        -- gameplay-independent flavour stats
  normal_card_art TEXT NOT NULL,
  shiny_card_art TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','unavailable'))
);
CREATE INDEX idx_carddefs_character ON card_definitions(character_id);
CREATE INDEX idx_carddefs_set ON card_definitions(set_id);

-- The database is the single source of truth for current ownership.
-- Discarded copies are DELETED here and recorded in card_events.
CREATE TABLE owned_cards (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 16),     -- unique copy reference
  owner_id TEXT NOT NULL REFERENCES collectors(user_id),
  card_definition_id TEXT NOT NULL REFERENCES card_definitions(id),
  variant TEXT NOT NULL CHECK (variant IN ('normal','shiny')),
  locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  favorited INTEGER NOT NULL DEFAULT 0 CHECK (favorited IN (0,1)),
  acquired_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catch','daily','weekly','milestone','admin_test')),
  source_ref TEXT,
  state TEXT NOT NULL DEFAULT 'owned' CHECK (state IN ('owned','reserved')),
  reserved_trade_id TEXT,
  CHECK ((state = 'reserved') = (reserved_trade_id IS NOT NULL))
);
CREATE INDEX idx_owned_owner ON owned_cards(owner_id);
CREATE INDEX idx_owned_owner_def ON owned_cards(owner_id, card_definition_id);
CREATE INDEX idx_owned_trade ON owned_cards(reserved_trade_id) WHERE reserved_trade_id IS NOT NULL;
-- A given catch / reward slot can create at most one copy, ever.
CREATE UNIQUE INDEX uq_owned_source_ref ON owned_cards(source, source_ref) WHERE source_ref IS NOT NULL;

-- Append-only provenance: survives discards and trades. Intentionally no FK to owned_cards.
CREATE TABLE card_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  copy_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('acquired','dropped','transferred','admin_removed')),
  from_user TEXT,
  to_user TEXT,
  card_definition_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX idx_card_events_copy ON card_events(copy_id);

CREATE TABLE spawns (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  character_id TEXT NOT NULL REFERENCES characters(id),
  card_definition_id TEXT NOT NULL REFERENCES card_definitions(id),
  variant TEXT NOT NULL CHECK (variant IN ('normal','shiny')),   -- decided server-side, stored before display
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','caught','expired','void')),
  catcher_id TEXT,
  caught_at INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),
  CHECK (expires_at - started_at = 180000),                     -- fixed 3-minute window
  CHECK ((status = 'caught') = (catcher_id IS NOT NULL)),
  CHECK ((status = 'caught') = (caught_at IS NOT NULL)),
  CHECK (caught_at IS NULL OR (caught_at >= started_at AND caught_at < expires_at))  -- no catch at/after deadline
);
CREATE INDEX idx_spawns_active ON spawns(status, expires_at) WHERE status = 'active';
CREATE INDEX idx_spawns_guild_time ON spawns(guild_id, started_at);

CREATE TABLE catch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spawn_id TEXT NOT NULL REFERENCES spawns(id),
  user_id TEXT NOT NULL,                                          -- no FK: wrong guessers have no profile
  result TEXT NOT NULL CHECK (result IN ('success','test_success','wrong','closed','expired','invalid')),
  at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX idx_catch_history_user ON catch_history(user_id, at);
CREATE UNIQUE INDEX uq_catch_one_winner ON catch_history(spawn_id) WHERE result IN ('success','test_success');

-- Only allow-listed, non-sensitive server options live here.
CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  spawn_channel_id TEXT,
  spawns_enabled INTEGER NOT NULL DEFAULT 1 CHECK (spawns_enabled IN (0,1)),
  compact_embeds INTEGER NOT NULL DEFAULT 0 CHECK (compact_embeds IN (0,1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  proposer_id TEXT NOT NULL REFERENCES collectors(user_id),
  recipient_id TEXT NOT NULL REFERENCES collectors(user_id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','completed','declined','cancelled','expired','failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  completed_at INTEGER,
  failure_reason TEXT,
  CHECK (proposer_id <> recipient_id)
);
CREATE INDEX idx_trades_status ON trades(status, expires_at);
CREATE INDEX idx_trades_users ON trades(proposer_id, recipient_id);

CREATE TABLE trade_items (
  trade_id TEXT NOT NULL REFERENCES trades(id),
  copy_id TEXT NOT NULL,                                          -- no FK: history must outlive discards
  original_owner_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('offer','request')),         -- offer: from proposer; request: from recipient
  card_definition_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  PRIMARY KEY (trade_id, copy_id)
);
CREATE INDEX idx_trade_items_copy ON trade_items(copy_id);

CREATE TABLE reward_claims (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES collectors(user_id),
  reward_type TEXT NOT NULL CHECK (reward_type IN ('daily','weekly','milestone')),
  period_key TEXT NOT NULL,                                       -- UTC day, UTC week, or milestone id
  claimed_at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id, reward_type, period_key)                       -- idempotency enforced by the DB
);

CREATE TABLE quests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_catch','unique_cards','set_complete')),
  target INTEGER NOT NULL CHECK (target >= 1),
  set_id TEXT REFERENCES sets(id),
  reward_cards INTEGER NOT NULL CHECK (reward_cards BETWEEN 1 AND 5),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE quest_progress (
  user_id TEXT NOT NULL REFERENCES collectors(user_id),
  quest_id TEXT NOT NULL REFERENCES quests(id),
  completed_at INTEGER NOT NULL,
  reward_claim_id TEXT REFERENCES reward_claims(id),
  PRIMARY KEY (user_id, quest_id)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  guild_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_time ON audit_log(at);

CREATE TABLE failed_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  error TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1))
);
`,
  },

  {
    version: 2,
    name: 'dex_value_economy_arcs',
    rebuildsTables: true,
    sql: `
-- Arcs: time-limited windows that feature a set of special cards (rate-up + arc quest + arc pack).
CREATE TABLE arcs (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_]*'),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  set_id TEXT NOT NULL REFERENCES sets(id),
  rate_up REAL NOT NULL DEFAULT 1 CHECK (rate_up >= 1 AND rate_up <= 10),
  reward_card_id TEXT,
  CHECK (ends_at > starts_at)
);

-- card_definitions gains DV, STRIKE/EGO, version links and arc membership; rarity becomes the six DV tiers.
CREATE TABLE card_definitions_new (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9_]*'),
  character_id TEXT NOT NULL REFERENCES characters(id),
  edition_name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common','rare','super_rare','epic','legendary','mythic')),
  dv REAL NOT NULL DEFAULT 50 CHECK (dv >= 0.1 AND dv <= 100),
  strike INTEGER NOT NULL DEFAULT 100,
  ego INTEGER NOT NULL DEFAULT 100,
  team TEXT,
  description TEXT NOT NULL DEFAULT '',
  release TEXT NOT NULL DEFAULT 'base' CHECK (release IN ('base','arc','event','reward')),
  version_of TEXT,
  arc_id TEXT REFERENCES arcs(id),
  score_normal INTEGER NOT NULL DEFAULT 10,
  score_shiny INTEGER NOT NULL DEFAULT 10,
  set_id TEXT NOT NULL REFERENCES sets(id),
  display_stats TEXT NOT NULL DEFAULT '{}',
  normal_card_art TEXT NOT NULL DEFAULT '',
  shiny_card_art TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','unavailable'))
);
INSERT INTO card_definitions_new (id, character_id, edition_name, rarity, dv, strike, ego, set_id, display_stats, normal_card_art, shiny_card_art, status)
SELECT id, character_id, edition_name,
  CASE rarity WHEN 'uncommon' THEN 'rare' WHEN 'rare' THEN 'super_rare' ELSE rarity END,
  CASE rarity WHEN 'common' THEN 80 WHEN 'uncommon' THEN 40 WHEN 'rare' THEN 12 WHEN 'epic' THEN 4 ELSE 1.2 END,
  CASE rarity WHEN 'common' THEN 110 WHEN 'uncommon' THEN 140 WHEN 'rare' THEN 160 WHEN 'epic' THEN 180 ELSE 200 END,
  CASE rarity WHEN 'common' THEN 110 WHEN 'uncommon' THEN 140 WHEN 'rare' THEN 160 WHEN 'epic' THEN 180 ELSE 200 END,
  set_id, display_stats, normal_card_art, shiny_card_art, status
FROM card_definitions;
DROP TABLE card_definitions;
ALTER TABLE card_definitions_new RENAME TO card_definitions;
CREATE INDEX idx_carddefs_character ON card_definitions(character_id);
CREATE INDEX idx_carddefs_set ON card_definitions(set_id);
CREATE INDEX idx_carddefs_arc ON card_definitions(arc_id) WHERE arc_id IS NOT NULL;

-- Pack pity counter (cards opened from packs since the last Epic-or-better).
ALTER TABLE collectors ADD COLUMN pack_pity INTEGER NOT NULL DEFAULT 0;
-- A quest may reward one specific card instead of a random pack (used by arc quests).
ALTER TABLE quests ADD COLUMN reward_card_id TEXT;
`,
  },
];
