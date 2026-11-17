# Arcs (events)

An **arc** is a time window that features a set of special cards. While it is live:

- Its cards **spawn and drop**, with a spawn rate-up (default x3). Outside the window they are not in the pool at all.
- `/arc info` shows the arc, time left and the player's progress.
- `/arc pack` gives **one free pack per player per arc**: 3 cards, the last one always a featured arc card.
- Owning every card of the arc set grants an **exclusive reward card**, once, forever.

When the arc ends, set `"available": false` on its cards. They stay owned and tradable, they just stop dropping and stop counting toward completion.

## Files

`catalogue/arcs.json`
```json
[{
  "id": "first_selection",
  "name": "First Selection",
  "description": "Team Z fights for survival.",
  "startsAt": "2026-12-01T00:00:00Z",
  "endsAt": "2026-12-15T00:00:00Z",
  "setId": "first_selection",
  "rateUp": 3,
  "rewardCardId": "yoichi_isagi_900"
}]
```

`catalogue/cards.json` (add the set and the cards)
```json
{ "id": "first_selection", "name": "First Selection" }

{ "id": "yoichi_isagi_002", "characterId": "yoichi_isagi", "edition": "Awakened Eye", "dv": 2.4, "strike": 178, "ego": 181,
  "team": "Team Z", "description": "Short flavour text.", "release": "arc", "versionOf": "yoichi_isagi_001",
  "arcId": "first_selection", "setId": "first_selection" }

{ "id": "yoichi_isagi_900", "characterId": "yoichi_isagi", "edition": "First Selection Winner", "dv": 0.4, "strike": 220, "ego": 224,
  "description": "Reward for completing the arc.", "release": "reward", "versionOf": "yoichi_isagi_001", "setId": "first_selection", "available": false }
```

## Rules the validator enforces

- Arc cards: `release: "arc"`, `arcId`, `versionOf` (the base card), and the arc's own `setId`.
- A special version must be **rarer than its base** (lower DV). Base cards cannot be Legendary or Mythic.
- The reward card must be `"available": false` so it can never drop or appear in packs.
- STRIKE and EGO must be inside the tier range of the card's DV.

## Running one

1. Add the files above, `npm run catalogue:validate`, `npm run odds`.
2. Put portraits in `assets/portraits/<character id>.png` (or set `art.normal` on the card: `"art": { "normal": "file:portraits/yoichi_isagi_awakened.png" }`).
3. Restart the bot. The catalogue syncs, the arc quest is created automatically, and `/arc` goes live at `startsAt`. No re-registration of commands is needed.
4. After `endsAt`, set the arc cards to `"available": false` and restart.
