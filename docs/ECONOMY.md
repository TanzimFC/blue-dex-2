# The Blue Dex economy

One number runs everything: **DV (Dex Value)**. Lower is rarer. The code lives in `src/domain/value.ts`; this page is the human version.

## DV and tiers

DV goes from **0.1 (rarest) to 100.0 (most common)**, one decimal. The tier is *derived* from DV, never typed by hand, so the two can never disagree.

| Tier | DV | Stat range (STRIKE and EGO) | Meaning |
|---|---|---|---|
| 👟 Common | 60.0 to 100.0 | 100 to 129 | Widely available. Fodder, background players, trade filler |
| 💎 Rare | 20.0 to 59.9 | 130 to 149 | The standard card of a named character |
| ✨ Super Rare | 6.0 to 19.9 | 150 to 169 | Backbone of serious collections |
| ⚡ Epic | 2.0 to 5.9 | 170 to 189 | Hard to pull, excellent trade bait |
| 🌟 Legendary | 0.6 to 1.9 | 190 to 209 | Ultra rare, heavily hoarded |
| 👑 Mythic | 0.1 to 0.5 | 210 to 240 | Absolute peak rarity |

`npm run catalogue:validate` rejects a card whose STRIKE or EGO is outside its tier's range.

**Base cards** are one per anime character, DV 6.0 or higher (Common, Rare or Super Rare), and anyone can complete the set.
Epic, Legendary and Mythic exist only as **special versions** (arc, event, reward). A special version must have a **lower DV than its base card**.

## Stats

Exactly two: **⚽ STRIKE** (finishing, shot power, raw speed) and **🔥 EGO** (how hard the player forces the play and takes the shot).
They are display and future match-sim values. They never change DV, worth or trade value.

## Worth: the trade rule

> **Worth = 100 ÷ DV. Half the DV is double the worth.**

| Card | Worth |
|---|---|
| DV 100 | 1 |
| DV 50 | 2 |
| DV 20 | 5 |
| DV 10 | 10 |
| DV 2.0 | 50 |
| DV 0.1 | 1000 |

So `0.1 for 0.1` is fair, one 2.0 equals five 10.0s, and a 10.0 equals two 20.0s.

**Fair Trade meter.** Every trade shows the total worth on each side.
- Fair: the sides are within 15% of each other, or the gap is under 5 worth (swapping two commons never nags).
- Lopsided: allowed, never blocked (friends gift cards), but the side giving clearly more must confirm a second time with a red **Accept anyway / Confirm anyway** button.
- Limits: 5 cards per side, 15 minute expiry (`src/gameplay.ts`, `trade`).

## Spawns

One weighted draw over every card that can spawn: `weight = DV ^ 0.6`. The character is whoever owns the drawn card.
The exponent is `DV_WEIGHT_EXPONENT` (0.3 to 1). `1` makes DV literally the odds, lower values compress the extremes so top tiers stay reachable.
Run `npm run odds` to see the real odds of the current catalogue. With the 99 base cards: about 50% Common, 43% Rare, 7% Super Rare per spawn, and the rarest card is about 1 in 345.

## Packs

- **Daily**: 1 card. **Weekly**: 3 cards, the last one is always **Super Rare or better** (`weeklyFloorTier`).
- Pack odds are tier odds (published, in `packTierWeights`): Common 62, Rare 27, Super Rare 8, Epic 2.5, Legendary 0.45, Mythic 0.05. Only tiers that have cards are used. Inside a tier every card is equally likely.
- **Pity**: after 50 pack cards without an Epic or better, the next one is guaranteed (`packPityCards`). Until Epic cards exist, pity guarantees the best tier that does exist.
- **Arc pack**: see `docs/ARCS.md`.

## Collection score (leaderboard)

For every distinct card owned: `10 + 10 per halving of DV` (DV 100 = 10, DV 50 = 20, DV 25 = 30, DV 0.1 = about 110). Duplicates never add score.
It is precomputed per card at catalogue sync (`score_normal` / `score_shiny`).

## Shiny is paused

Shiny spawns and shiny pack cards are off (`shinySpawnOdds = 0`, `packShinyOdds = 0`) and hidden from every command.
The engine is intact: a shiny is the same card at DV / 3 (floor 0.1). To bring it back later, set `SHINY_SPAWN_ODDS` / `PACK_SHINY_ODDS` and re-add the shiny filters to the commands.

## Tuning knobs

| Knob | Where | Default |
|---|---|---|
| Spawn weight exponent | `DV_WEIGHT_EXPONENT` | 0.6 |
| Pack tier odds, weekly floor, pity | `src/gameplay.ts` | see above |
| Trade tolerance and minimum gap | `src/gameplay.ts` `trade` | 0.15 and 5 |
| Tier boundaries and stat ranges | `src/domain/value.ts` `TIERS` | table above |
