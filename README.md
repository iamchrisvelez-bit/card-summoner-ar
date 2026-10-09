# Card Summoner AR (prototype)

Summon 3D monsters onto a virtual duel board on your real table, Yu-Gi-Oh anime style,
for any trading card game you load as a **game pack**. Pick the game on the start screen;
its card data set, board layout and ruleset drive everything that follows. See
[GAME_PACKS.md](GAME_PACKS.md) for the pack format and how to add a TCG.

**Yu-Gi-Oh! is the first and default game** (Master Rule board, 8000 LP, 5-card hand,
one Normal Summon per turn, tributes for Level 5+, no attacks on turn 1; 16 starter cards).
Two original example packs show other rule shapes:

- **Zone Duel:** 5 monster + 5 spell/trap zones, 8000 LP, one normal summon per turn,
  level 5+ needs 1 tribute and level 7+ needs 2, no summoning sickness.
- **Mana Clash:** a free 7-slot battlefield, 20 life, mana ramps with the turn number,
  creatures can't attack the turn they arrive.

Two modes share one page:

- **Meta Quest (primary target):** WebXR `immersive-ar` passthrough in Quest Browser.
  Point at the table and pull the trigger (or pinch) to lay down the game's board. Point at a
  card in your hand (along the near edge) and then at a zone to play it; the active game's
  rules allow or refuse it, with the reason on the floating banner. Monsters arrive in a
  light pillar with the card rising as a hologram, then stand on the table beyond the board.
  Tributes shrink away. Point at a monster to attack, or at "End turn".
  *Experimental:* "Watch for real cards" runs MindAR's detector on `getUserMedia` frames
  (Quest Browser has no WebXR camera access) and plays a recognised card into the first
  zone the rules allow. Untested on hardware.
- **Phone:** point the camera at a printed card; it is played under the active game's rules
  and its monster appears on the card inside a virtual board.

- **Stack:** three.js + [MindAR](https://github.com/hiukim/mind-ar-js) image tracking, plain
  static files (no build step), vendored in `app/vendor`.
- **Monster:** `dragon_whelp.glb` from `iamchrisvelez-bit/skills`
  (branch `claude/dragon-whelp-glb-model-2iyvyp`), recoloured per card.
- **Engine:** `app/engine/` holds the pack loader/validator and the data-driven rules engine,
  with no three.js or DOM dependencies.

## Phone mode

1. Card detected → it is played into the first zone the rules allow. If the rules refuse
   (e.g. no tributes yet), the reason shows at the top and nothing is summoned.
2. Otherwise a board appears around the card (the real card shows through the centre slot)
   and its monster scales in with a ring and light pillar, roars, then idles.
3. Buttons: Attack (checks the rules), Flap, Walk, End turn. One card is tracked at a time,
   because similar card frames can false-match while another card is tracked.

## Run it

The camera needs HTTPS (or localhost). Any static host works, e.g. GitHub Pages serving `app/`.

```bash
node tools/serve.mjs app 8080          # http://localhost:8080 on a desktop with a webcam
```

## Tools

```bash
npm i --ignore-scripts                     # mind-ar, three, iwer (dist files are vendored in app/vendor)
npm test                                   # rules engine + every game pack loads and validates
python3 tools/make_cards.py app/games/<id> <model preview.png>   # render a pack's printable cards
node tools/compile.mjs <id>                # card PNGs -> targets.mind (headless Chromium)
python3 tools/make_fake_camera.py app/games/zone-duel/cards/zd-dragon-whelp.png test-out/card_on_table.y4m
node tools/e2e.mjs                         # phone mode: fake-camera end-to-end test
node tools/e2e-quest.mjs <id>              # Quest mode: IWER-emulated Quest 3, plays a scripted duel
```

## Coordinates

MindAR anchor space: card width = 1 unit, origin at the card centre, +Y toward the
card's top edge, +Z up out of the table. The glTF model is Y-up facing +Z, so it is
rotated +90° about X to stand on the card facing the player.

## Toward real card recognition on Quest

The WebXR route cannot see real cards reliably: Quest Browser rejects the `camera-access`
feature, and `getUserMedia` frames have no pose alignment with the headset. The robust path
is a native build (Unity + Meta's Passthrough Camera API, Horizon OS v76+), which gives
camera frames with intrinsics and pose so a detected card can be placed exactly in 3D.
