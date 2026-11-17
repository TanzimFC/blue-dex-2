import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeEnv } from './helpers.js';
import { openDb } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { loadCatalogueFiles } from '../src/catalogue/sync.js';
import { validateCatalogue, CatalogueError } from '../src/catalogue/schema.js';
import { TIERS, assessTrade, effectiveDv, scoreOf, statInRange, tierForDv, worthOf, isValidDv, formatDv } from '../src/domain/value.js';
import { LIVE_POOL_SQL, dvProbabilities, pickByDv, type PoolCard } from '../src/domain/pick.js';
import { claimArcPack, claimPeriodic, evaluateMilestones, seedQuests } from '../src/domain/rewards.js';
import { ensureCollector, grantCopy } from '../src/domain/collection.js';
import { leaderboard } from '../src/domain/leaderboard.js';
import { acceptTrade, assessTradeById, confirmTrade, proposeTrade } from '../src/domain/trade.js';
import { createSpawn } from '../src/domain/spawn.js';
import { defaultGameplay } from '../src/gameplay.js';
import { initFonts, renderCard, renderSpawnArt } from '../src/render/card.js';
import { normalizeAlias } from '../src/util/normalize.js';
import { seededRng } from '../src/util/rng.js';
import { RARITIES, type Rarity } from '../src/types.js';

const ARC_LIVE = Date.UTC(2026, 10, 25, 12);   // inside First Selection (20 Nov to 4 Dec 2026)
const give = (env: ReturnType<typeof makeEnv>, user: string, card: string) => {
  ensureCollector(env.db, user, 'u' + user, env.now);
  return grantCopy(env, { ownerId: user, cardDefinitionId: card, variant: 'normal', source: 'admin_test', sourceRef: null });
};
const tierOf = (env: ReturnType<typeof makeEnv>, cardId: string) => (env.db.prepare('SELECT rarity r FROM card_definitions WHERE id=?').get(cardId) as { r: Rarity }).r;
const rank = (t: Rarity) => RARITIES.indexOf(t);

describe('DV tiers, worth, score', () => {
  it('tier boundaries match the chosen table', () => {
    const cases: [number, Rarity][] = [[0.1, 'mythic'], [0.5, 'mythic'], [0.6, 'legendary'], [1.9, 'legendary'], [2, 'epic'], [5.9, 'epic'], [6, 'super_rare'], [19.9, 'super_rare'], [20, 'rare'], [59.9, 'rare'], [60, 'common'], [100, 'common']];
    for (const [dv, t] of cases) expect(tierForDv(dv), `dv ${dv}`).toBe(t);
    for (const t of RARITIES) { expect(tierForDv(TIERS[t].minDv)).toBe(t); expect(tierForDv(TIERS[t].maxDv)).toBe(t); }
  });
  it('tiers tile 0.1-100 with no gaps at one-decimal precision', () => {
    for (let n = 1; n <= 1000; n++) { const dv = n / 10; const t = TIERS[tierForDv(dv)]; expect(dv >= t.minDv && dv <= t.maxDv, `dv ${dv}`).toBe(true); }
  });
  it('half the DV is double the worth', () => {
    expect(worthOf(10)).toBe(10); expect(worthOf(5)).toBe(20); expect(worthOf(2)).toBe(50); expect(worthOf(0.1)).toBe(1000); expect(worthOf(100)).toBe(1);
  });
  it('shiny is DV / 3 with the global floor (kept dormant while shiny is paused)', () => {
    expect(effectiveDv(2, 'shiny')).toBe(0.7); expect(effectiveDv(0.2, 'shiny')).toBe(0.1); expect(effectiveDv(2, 'normal')).toBe(2);
  });
  it('score is 10 per halving of DV', () => {
    expect(scoreOf(100)).toBe(10); expect(scoreOf(50)).toBe(20); expect(scoreOf(25)).toBe(30); expect(scoreOf(0.1)).toBeGreaterThan(100);
  });
  it('DV validation and formatting', () => {
    expect(isValidDv(0.1)).toBe(true); expect(isValidDv(100)).toBe(true); expect(isValidDv(0.05)).toBe(false); expect(isValidDv(100.1)).toBe(false); expect(isValidDv(12.34)).toBe(false);
    expect(formatDv(2)).toBe('2.0'); expect(formatDv(14.5)).toBe('14.5'); expect(formatDv(93)).toBe('93');
  });
  it('stat ranges follow the tier', () => {
    expect(statInRange('common', 100)).toBe(true); expect(statInRange('common', 130)).toBe(false); expect(statInRange('mythic', 240)).toBe(true); expect(statInRange('epic', 169)).toBe(false);
  });
});

describe('trade fairness', () => {
  const c = (dv: number) => ({ dv, variant: 'normal' as const });
  it('equal DV for equal DV is fair', () => expect(assessTrade([c(0.1)], [c(0.1)]).verdict).toBe('fair'));
  it('one 2.0 equals five 10.0s', () => expect(assessTrade([c(2)], [c(10), c(10), c(10), c(10), c(10)]).verdict).toBe('fair'));
  it('a 10.0 for two 20.0s is fair (10 vs 5+5)', () => expect(assessTrade([c(10)], [c(20), c(20)]).verdict).toBe('fair'));
  it('a 2.0 for two 10.0s is lopsided and the proposer is the giver', () => {
    const a = assessTrade([c(2)], [c(10), c(10)]);
    expect(a.verdict).toBe('lopsided'); expect(a.giver).toBe('proposer'); expect(a.offerWorth).toBe(50); expect(a.requestWorth).toBe(20);
  });
  it('tiny gaps never nag (two near-common cards)', () => expect(assessTrade([c(70)], [c(60), c(95)]).verdict).toBe('fair'));
  it('a free gift of a valuable card is lopsided', () => expect(assessTrade([c(10)], []).giver).toBe('proposer'));
});

describe('trade acknowledgement', () => {
  function setup() {
    const env = makeEnv(); const a = give(env, 'A', 'isagi_001'); const b = give(env, 'B', 'reo_001'); // 14.5 (worth 6.9) vs 26.3 (worth 3.8)
    return { env, a, b };
  }
  it('a small gap (6.9 vs 3.8 worth) is fair, so nobody is asked to acknowledge', () => {
    const { env, a, b } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a], requestCopyIds: [b] }); if (!p.ok) throw new Error('propose');
    expect(assessTradeById(env, p.tradeId)?.giver).toBeNull(); // 6.9 vs 3.8 is under the 5-worth gap: fair
    expect(acceptTrade(env, p.tradeId, 'B').ok).toBe(true);
    expect(confirmTrade(env, p.tradeId, 'A').ok).toBe(true);
  });
  it('gift of 6.9 worth needs the proposer to confirm twice; recipient accept is free', () => {
    const { env, a } = setup();
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [a], requestCopyIds: [] }); if (!p.ok) throw new Error('propose');
    expect(acceptTrade(env, p.tradeId, 'B')).toEqual({ ok: true });
    expect(confirmTrade(env, p.tradeId, 'A')).toEqual({ ok: false, reason: 'needs_ack' });
    expect(env.db.prepare("SELECT status FROM trades WHERE id=?").get(p.tradeId)).toEqual({ status: 'accepted' });
    expect(confirmTrade(env, p.tradeId, 'A', true).ok).toBe(true);
  });
  it('recipient giving clearly more must acknowledge accept', () => {
    const env = makeEnv(); const cheap = give(env, 'A', 'reo_001'); const rich = give(env, 'B', 'barou_001'); // 3.8 worth for 10.4 worth
    const p = proposeTrade(env, { proposerId: 'A', recipientId: 'B', offerCopyIds: [cheap], requestCopyIds: [rich] }); if (!p.ok) throw new Error('propose');
    expect(acceptTrade(env, p.tradeId, 'B')).toEqual({ ok: false, reason: 'needs_ack' });
    expect(acceptTrade(env, p.tradeId, 'B', true).ok).toBe(true);
  });
});

describe('catalogue rules', () => {
  const chars = [{ id: 'a', name: 'Alpha Man' }];
  const card = (o: object) => ({ id: 'c1', characterId: 'a', edition: 'Base', dv: 70, strike: 110, ego: 112, setId: 's', ...o });
  const sets = [{ id: 's', name: 'S' }, { id: 'arcset', name: 'Arc' }];
  const arcs = [{ id: 'arc1', name: 'Arc', startsAt: '2026-11-20T00:00:00Z', endsAt: '2026-12-04T00:00:00Z', setId: 'arcset', rewardCardId: 'rw' }];
  const run = (cards: object[], a: object[] = []) => validateCatalogue(chars, { sets, cards }, a);
  it('a valid base card passes and gets its tier from DV', () => expect(run([card({})]).cards[0]!.tier).toBe('common'));
  it('stats outside the tier range are rejected', () => expect(() => run([card({ strike: 150 })])).toThrow(/outside the Common range/));
  it('base cards cannot be Legendary or Mythic', () => expect(() => run([card({ dv: 1.2, strike: 195, ego: 195 })])).toThrow(/base cards cannot be Legendary/));
  it('DV must have at most one decimal and sit in 0.1-100', () => { expect(() => run([card({ dv: 70.55 })])).toThrow(CatalogueError); expect(() => run([card({ dv: 0 })])).toThrow(CatalogueError); });
  it('one base card per character', () => expect(() => run([card({}), card({ id: 'c2' })])).toThrow(/already has base card/));
  it('special versions must be rarer than their base', () => {
    const special = card({ id: 'c2', edition: 'Arc', release: 'arc', versionOf: 'c1', arcId: 'arc1', setId: 'arcset', dv: 80, strike: 110, ego: 110 });
    expect(() => run([card({}), special], arcs)).toThrow(/must be rarer than its base/);
  });
  it('arc cards must use the arc set and exist in arcs.json', () => {
    const ok = card({ id: 'c2', edition: 'Arc', release: 'arc', versionOf: 'c1', arcId: 'arc1', setId: 'arcset', dv: 40, strike: 135, ego: 135 });
    const rw = card({ id: 'rw', edition: 'Reward', release: 'reward', versionOf: 'c1', setId: 'arcset', dv: 30, strike: 135, ego: 135, available: false });
    expect(run([card({}), ok, rw], arcs).cards).toHaveLength(3);
    expect(() => run([card({}), { ...ok, setId: 's' }, rw], arcs)).toThrow(/arc's set/);
    expect(() => run([card({}), ok, rw], [])).toThrow(/unknown arcId/);
  });
  it('arc reward cards must be unavailable so they can never drop', () => {
    const ok = card({ id: 'c2', edition: 'Arc', release: 'arc', versionOf: 'c1', arcId: 'arc1', setId: 'arcset', dv: 40, strike: 135, ego: 135 });
    const rw = card({ id: 'rw', edition: 'Reward', release: 'reward', versionOf: 'c1', setId: 'arcset', dv: 30, strike: 135, ego: 135 });
    expect(() => run([card({}), ok, rw], arcs)).toThrow(/available": false/);
  });
});

describe('the shipped catalogue (your final base cards)', () => {
  const cat = loadCatalogueFiles('catalogue');
  it('has 99 base cards, one per character, all in the Genesis set', () => {
    expect(cat.cards).toHaveLength(99); expect(cat.characters).toHaveLength(99);
    expect(cat.cards.every((c) => c.release === 'base' && c.setId === 'genesis' && c.edition === 'Base')).toBe(true);
    expect(new Set(cat.cards.map((c) => c.characterId)).size).toBe(99);
  });
  it('every base card is Common, Rare or Super Rare (Epic and up are reserved for special cards)', () => {
    for (const c of cat.cards) expect(['common', 'rare', 'super_rare']).toContain(c.tier);
  });
  it('rating locks: Barou has more EGO than Isagi; the anchor DVs are as supplied', () => {
    const by = (id: string) => cat.cards.find((c) => c.id === id)!;
    expect(by('shoei_barou_001').ego).toBeGreaterThan(by('yoichi_isagi_001').ego);
    expect(by('yoichi_isagi_001').dv).toBe(14.5); expect(by('tomonori_tada_001').dv).toBe(99.5); expect(by('michael_kaiser_001').dv).toBe(6.4);
  });
  it('every character can be guessed by given name, family name and full name (ambiguous ones need the full name)', () => {
    const owner = new Map<string, string>();
    for (const c of cat.characters) for (const a of [c.name, ...c.aliases]) owner.set(normalizeAlias(a), c.id);
    expect(owner.get(normalizeAlias('Isagi'))).toBe('yoichi_isagi'); expect(owner.get(normalizeAlias('Yoichi Isagi'))).toBe('yoichi_isagi');
    expect(owner.get(normalizeAlias('King'))).toBe('shoei_barou'); expect(owner.has(normalizeAlias('Itoshi'))).toBe(false); expect(owner.get(normalizeAlias('Rin'))).toBe('rin_itoshi');
  });
  it('the rarest card is still reachable: worse than 1 in 1000 spawns would break "anyone can complete the set"', () => {
    const pool = cat.cards.map((c) => ({ id: c.id, dv: c.dv, rarity: c.tier }));
    const p = dvProbabilities(pool, defaultGameplay.dvWeightExponent);
    expect(1 / Math.min(...p.values())).toBeLessThan(1000); // rarest card: better than 1 in 1000
    expect(1 / Math.max(...p.values())).toBeGreaterThan(50); // commonest card is not a flood either
  });
});

describe('weighted spawns and arcs', () => {
  it('spawn weight follows DV ^ exponent: a lower DV is proportionally rarer', () => {
    const pool = [{ id: 'rare_one', dv: 10, rarity: 'super_rare' as Rarity }, { id: 'common_one', dv: 80, rarity: 'common' as Rarity }];
    const rng = seededRng(5); const n = 20000; let rareHits = 0;
    for (let i = 0; i < n; i++) if (pickByDv(pool, 0.6, rng).id === 'rare_one') rareHits++;
    const expected = 10 ** 0.6 / (10 ** 0.6 + 80 ** 0.6);
    expect(rareHits / n).toBeGreaterThan(expected - 0.015); expect(rareHits / n).toBeLessThan(expected + 0.015);
  });
  it('arc cards are out of the pool before the arc, in it during the arc (with rate-up), and reward cards never', () => {
    const env = makeEnv();
    const ids = (now: number) => (env.db.prepare(LIVE_POOL_SQL).all({ now }) as PoolCard[]).map((c) => c.id);
    expect(ids(Date.UTC(2026, 10, 1))).not.toContain('isagi_002');
    const live = env.db.prepare(LIVE_POOL_SQL).all({ now: ARC_LIVE }) as PoolCard[];
    expect(live.map((c) => c.id)).toEqual(expect.arrayContaining(['isagi_002', 'barou_002']));
    expect(live.map((c) => c.id)).not.toContain('isagi_003');
    expect(live.find((c) => c.id === 'isagi_002')!.mult).toBe(3); expect(live.find((c) => c.id === 'isagi_001')!.mult).toBe(1);
    expect(ids(Date.UTC(2026, 11, 4))).not.toContain('isagi_002'); // ends_at is exclusive
  });
  it('spawns during the arc can be arc cards, outside it never are', () => {
    const env = makeEnv({ spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 9999 } });
    const seen = (now: number) => { env.now = now; const s = new Set<string>(); for (let i = 0; i < 400; i++) { const r = createSpawn(env, { guildId: 'g' + i, channelId: 'c' }); if (r.ok) s.add(r.spawn.card_definition_id); } return s; };
    expect(seen(Date.UTC(2026, 9, 30)).has('isagi_002')).toBe(false);
    const during = seen(ARC_LIVE); expect(during.has('isagi_002') || during.has('barou_002')).toBe(true); expect(during.has('isagi_003')).toBe(false);
  });
  it('shiny is paused: no shiny spawns by default', () => {
    const env = makeEnv({ spawn: { ...defaultGameplay.spawn, minIntervalMs: 0, maxPerGuildPerHour: 9999 } });
    for (let i = 0; i < 300; i++) { const r = createSpawn(env, { guildId: 'g' + i, channelId: 'c' }); if (r.ok) expect(r.spawn.variant).toBe('normal'); }
  });
});

describe('packs: floor, pity, arc pack', () => {
  it('the last card of a weekly pack is at least the floor tier', () => {
    const env = makeEnv({ weeklyFloorTier: 'epic', packTierWeights: { ...defaultGameplay.packTierWeights, common: 1000, rare: 1000, super_rare: 1000 } });
    env.now = ARC_LIVE; // arc live so Epic cards exist in the pool
    for (let u = 0; u < 25; u++) {
      const r = claimPeriodic(env, 'u' + u, 'x', 'weekly'); if (!r.ok) throw new Error('claim');
      expect(rank(tierOf(env, r.cards.at(-1)!.cardId))).toBeGreaterThanOrEqual(rank('epic'));
    }
  });
  it('pity forces the best available tier after N pack cards without it', () => {
    // Heavily Rare-weighted: without pity, a Super Rare would almost never show up.
    const env = makeEnv({ packPityCards: 3, packTierWeights: { common: 0, rare: 1_000_000, super_rare: 0.000001, epic: 0, legendary: 0, mythic: 0 } });
    const tiers: Rarity[] = [];
    for (let day = 0; day < 3; day++) { const r = claimPeriodic(env, '1', 'x', 'daily'); if (!r.ok) throw new Error('claim'); tiers.push(tierOf(env, r.cards[0]!.cardId)); env.advance(86_400_000); }
    expect(tiers[2]).toBe('super_rare');
    expect((env.db.prepare('SELECT pack_pity p FROM collectors WHERE user_id=?').get('1') as { p: number }).p).toBe(0);
  });
  it('arc pack: needs a live arc, 3 cards, last one featured, once per arc', () => {
    const env = makeEnv(); seedQuests(env);
    expect(claimArcPack(env, '1', 'x')).toEqual({ ok: false, reason: 'no_live_arc' });
    env.now = ARC_LIVE;
    const r = claimArcPack(env, '1', 'x'); if (!r.ok) throw new Error('claim');
    expect(r.cards).toHaveLength(3);
    expect(['isagi_002', 'barou_002']).toContain(r.cards[2]!.cardId);
    expect(claimArcPack(env, '1', 'x')).toEqual({ ok: false, reason: 'already_claimed' });
    expect(claimArcPack(env, '2', 'y').ok).toBe(true);
  });
  it('completing the arc set grants the exclusive reward card exactly once', () => {
    const env = makeEnv(); seedQuests(env);
    give(env, '1', 'isagi_002');
    expect(evaluateMilestones(env, '1').map((g) => g.questId)).not.toContain('set_first_selection');
    give(env, '1', 'barou_002');
    const grants = evaluateMilestones(env, '1').filter((g) => g.questId === 'set_first_selection');
    expect(grants).toHaveLength(1); expect(grants[0]!.cards.map((c) => c.cardId)).toEqual(['isagi_003']);
    expect(evaluateMilestones(env, '1').filter((g) => g.questId === 'set_first_selection')).toHaveLength(0);
  });
});

describe('score leaderboard uses DV', () => {
  it('one 14.5 DV card scores 10 + 10 per halving, duplicates add nothing', () => {
    const env = makeEnv(); give(env, '1', 'isagi_001'); give(env, '1', 'isagi_001');
    expect(leaderboard(env.db, 'score')[0]!.value).toBe(scoreOf(14.5));
    give(env, '1', 'reo_001'); expect(leaderboard(env.db, 'score')[0]!.value).toBe(scoreOf(14.5) + scoreOf(26.3));
  });
});

describe('migration v1 -> v2 keeps existing data', () => {
  it('maps old rarities, keeps owned cards and passes the foreign key check', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    db.exec(migrations[0]!.sql); db.prepare("INSERT INTO schema_migrations VALUES (1,'initial_schema',0)").run();
    db.exec(`INSERT INTO collectors (user_id, created_at) VALUES ('1', 0);
      INSERT INTO characters (id, display_name) VALUES ('a','A');
      INSERT INTO sets (id, name) VALUES ('s','S');
      INSERT INTO card_definitions (id, character_id, edition_name, rarity, set_id, normal_card_art, shiny_card_art) VALUES ('c1','a','E','uncommon','s','x','y'), ('c2','a','F','legendary','s','x','y');
      INSERT INTO owned_cards (id, owner_id, card_definition_id, variant, acquired_at, source) VALUES ('ABCDEF','1','c1','normal',0,'catch');`);
    expect(migrate(db)).toEqual({ from: 1, to: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT id, rarity FROM card_definitions ORDER BY id').all()).toEqual([{ id: 'c1', rarity: 'rare' }, { id: 'c2', rarity: 'legendary' }]);
    expect(db.prepare('SELECT card_definition_id c FROM owned_cards').get()).toEqual({ c: 'c1' });
    expect(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('collectors') WHERE name='pack_pity'").get()).toEqual({ n: 1 });
  });
});

describe('card renderer', () => {
  it('draws a valid PNG with a placeholder portrait, with and without flavour text', async () => {
    initFonts('assets');
    const base = { name: 'Yoichi Isagi', edition: 'Base', dv: 14.5, tier: 'super_rare' as Rarity, strike: 160, ego: 163, team: 'Team Z', variant: 'normal' as const, portraitPath: null };
    for (const description of ['', 'A long piece of flavour text that has to wrap over several lines without running out of the panel at all.']) {
      const png = await renderCard({ ...base, description });
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); expect(png.length).toBeGreaterThan(5000);
    }
    expect((await renderSpawnArt(null)).subarray(1, 4).toString()).toBe('PNG');
  });
  it('ships the fonts it needs', () => { expect(readFileSync('assets/fonts/RobotoCondensed-Bold.woff2').length).toBeGreaterThan(1000); });
});
