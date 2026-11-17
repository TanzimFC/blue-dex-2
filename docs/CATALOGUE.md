# Catalogue format and art

Files in `CATALOGUE_DIR` (default `./catalogue`) are validated (`npm run catalogue:validate`) and synced into the DB at every start.
Nothing is hard-deleted: removed cards become `unavailable`, removed characters `retired`, so owned copies never dangle.

## characters.json
```json
{ "id": "yoichi_isagi", "name": "Yoichi Isagi", "aliases": ["Isagi", "Yoichi", "Isagi Yoichi"] }
```
- `id`: stable, `[a-z0-9_]`, never reuse. `name` is also an accepted alias.
- Aliases are normalised (lower-case, accents, punctuation and spaces removed). The same normalised alias on two characters is a **validation error**.
  That is why `Itoshi` and `Wanima` are not aliases: two characters share them, so those players type the given name or the full name.
- `spawnArt` is **optional** (see art below).

## cards.json
```json
{ "sets": [{ "id": "genesis", "name": "Genesis" }],
  "cards": [{ "id": "yoichi_isagi_001", "characterId": "yoichi_isagi", "edition": "Base", "dv": 14.5, "strike": 160, "ego": 163,
              "team": "Team Z", "setId": "genesis" }] }
```
| Field | Required | Notes |
|---|---|---|
| `id`, `characterId`, `edition`, `setId` | yes | base cards use edition `Base` |
| `dv` | yes | 0.1 to 100, one decimal. The tier is derived from it |
| `strike`, `ego` | yes | whole numbers inside the tier's range (`docs/ECONOMY.md`) |
| `team` | no | shown on the card |
| `description` | no | flavour text; special cards usually have it, base cards do not need it |
| `release` | no | `base` (default), `arc`, `event`, `reward` |
| `versionOf`, `arcId` | special cards | see `docs/ARCS.md` |
| `art.normal` | no | `file:` portrait for this specific card |
| `available` | no | `false` hides it from drops |

Rules: one base card per character; base cards cannot be Legendary or Mythic; a special version must be rarer than its base.

## Art
Cards are **drawn by the bot** from the data above (`src/render/card.ts`, 457 x 640). You only supply **one portrait per character**:

```
assets/portraits/<character id>.png        (.jpg / .jpeg / .webp also work)
```
- A card uses its own `art.normal` if set, else the character portrait, else a built-in placeholder silhouette with initials.
- **Spawn images are generated from the portrait** (heavily pixelated "who's that?"), the same for every spawn, so nothing can leak. No separate spawn art is needed.
  If you ever want hand-made spawn art, set `spawnArt` on the character.
- Recommended portrait: about 800 x 600 or larger, face in the upper half (the frame crops to the centre, slightly high). Local files only.
- `npm run art:check` lists missing portraits. `npm run cards:preview -- all` renders every card to `./preview`.
- Only use original or properly licensed artwork. Do not imply affiliation with Blue Lock or its rights holders.
- Fonts are in `assets/fonts` (Roboto Condensed, SIL Open Font License).
