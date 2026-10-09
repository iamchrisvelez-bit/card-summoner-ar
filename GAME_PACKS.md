# Game packs: adding a TCG

Every trading card game is a **game pack**: a folder under `app/games/<id>/` listed in
`app/games/index.json`. The start screen's Game picker chooses the active pack, and that
pack's board, card data set and ruleset drive both the Quest and phone modes. Nothing about
a specific TCG is hard-coded in the app.

Packs are plain JSON on purpose. The rules are declarative, so the same pack can be read by
this JS prototype and by a later native Quest client (Unity) without rewriting rules in a
second language.

```
app/games/index.json            catalog: [{ id, name, summary }]
app/games/<id>/game.json        board layout, card fields, ruleset, card style
app/games/<id>/cards.json       the card data set
app/games/<id>/cards/*.png      printable card images (also the tracking targets)
app/games/<id>/targets.mind     compiled image targets (node tools/compile.mjs <id>)
```

## game.json

| Key | Meaning |
|---|---|
| `id`, `name`, `version` | Identity. `id` matches the folder. |
| `defaultModel` | glTF used when a card has no `model.src` (path relative to the pack). |
| `creatureTypes` | Card types that put a 3D monster on the table (default `monster`, `creature`). |
| `targets` | Compiled MindAR targets file, or `null` when the pack has no card images yet. |
| `board.width`, `board.depth` | Mat size in metres. |
| `board.theme` | `fill` gradient, `edge` colour, `kinds` colour per zone kind. |
| `board.zones[]` | `{ id, kind, x, z }`, position in metres from the mat centre (+z toward the player). |
| `cardFields` | Stats each card carries: `{ name: { label, types? } }`. `types` limits a field to some card types. |
| `rules` | The ruleset, below. |
| `cardStyle` | How cards are drawn: by `tools/make_cards.py` for printable demo cards, and by `app/card-face.js` in the headset for packs without images (`frames` colour per `card.frame`, `typeLine`, `statLine`, `gemsStat`). |

## Ruleset primitives (`rules`)

| Primitive | Example | Effect |
|---|---|---|
| `life` | `{ "name": "LP", "starting": 8000 }` | Starting life total and its label. |
| `zones` | `{ "spell": { "accepts": ["spell", "trap"] } }` | Which card types each zone kind accepts (default: the type named like the kind). |
| `deck` | `{ "startingHand": 5, "drawPerTurn": 1 }` | Deal a hand from the deck (`deckList` in game.json, or one of each card) and draw at the start of each later turn. Cards are played from the hand. |
| `turn.playsPerTurn` | `{ "monster": 1 }` | Plays allowed per turn, per card type. |
| `turn.noAttackFirstTurn` | `true` | Nobody attacks on the duel's first turn. |
| `resources` | `{ "name": "mana", "costStat": "cost", "mode": "ramp", "max": 10 }` | A resource paid from a card stat. `ramp` refills to the turn number; `accumulate` adds `perTurn`. |
| `summonCost.tributes` | `{ "stat": "level", "types": ["monster"], "from": ["monster", "extra-monster"], "tiers": [{ "min": 5, "count": 1 }] }` | Cards of `types` whose stat reaches a tier need that many cards of `from` on the field (default: the same type); the weakest are tributed. |
| `summoningSickness` | `true` | Creatures can't attack the turn they arrive. |

The engine (`app/engine/rules-engine.js`) interprets these: `canPlay`, `play` (returns
`destroy` / `summon` events for the view to animate), `canAttack`, `endTurn`, `describe`.
A rule a TCG needs that isn't here becomes a new primitive in the engine, with a test.

## cards.json

```json
{ "id": "zd-ember-drake", "name": "Ember Drake", "type": "monster",
  "stats": { "level": 5, "atk": 2000, "def": 1500 },
  "model": { "scale": 1.25, "hue": -110 },
  "image": "cards/zd-ember-drake.png", "target": 1,
  "art": { "hue": -110, "view": 1 }, "text": ["Requires 1 tribute."] }
```

`type` must be a type the ruleset knows. `stats` must match `cardFields`. `target` values run
0..n-1 with no gaps. `model.hue` recolours the shared model so variants match their art.
`art` and `text` are only for the card renderer. The loader validates all of this and refuses
a broken pack with a list of problems.

## Adding a game

1. Copy a pack folder, change `id`, add it to `index.json`.
2. Edit `game.json` (zones, fields, rules) and `cards.json`.
3. Render cards: `python3 tools/make_cards.py app/games/<id> <model preview.png>`, or drop in
   your own card scans (straight-on, cropped to the edges).
4. Compile targets: `node tools/compile.mjs <id>`.
5. `npm test` (loads and validates every pack) and `node tools/e2e-quest.mjs <id>`.

## The Yu-Gi-Oh! pack

`app/games/yugioh/` is the first real TCG and the default game. It models the Master Rule
board (5 Main Monster Zones, 2 Extra Monster Zones, 5 Spell & Trap Zones, Field Zone, plus
Graveyard / Deck / Extra Deck markers that accept nothing), 8000 LP, a 5-card opening hand
and one draw per turn, one Normal Summon per turn, tributes for Level 5-6 (1) and 7+ (2),
Extra Deck monsters outside the Normal Summon limit, and no attacks on the first turn.

Its 16 starter cards (Baby Dragon, Blue-Eyes White Dragon, Dark Magician, Pot of Greed,
Mirror Force, Yami, ...) were hand-entered with their 8-digit passcodes; card art is not
bundled, so the headset draws faces from the data. Refresh or add cards with
`python3 tools/import_ygoprodeck.py [passcode or name ...]` (needs internet access to
db.ygoprodeck.com). Every real Yu-Gi-Oh! card prints its passcode in the bottom-left corner,
which makes it a natural key for card recognition later.

Not modelled yet: Special Summons beyond the Extra Monster Zone, setting cards face-down,
battle position, battle damage, card effects and chains.

Only use card data and art you have the rights to. Zone Duel and Mana Clash are original
example games written to exercise different rule shapes.
