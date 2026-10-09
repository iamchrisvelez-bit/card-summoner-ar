import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCatalog, loadGame, validateGame } from '../app/engine/game-loader.js';
import { canAttack, canPlay, createDuel, describe, endTurn, play } from '../app/engine/rules-engine.js';

const fsJson = async (url) => JSON.parse(await readFile(url, 'utf8'));
const fixed = { shuffle: false };

test('every game in the catalog loads and validates', async () => {
  const games = await loadCatalog(fsJson);
  assert.equal(games[0].id, 'yugioh', 'Yu-Gi-Oh! is the first (default) game');
  for (const g of games) {
    const game = await loadGame(g.id, fsJson);
    assert.equal(game.id, g.id);
    assert.ok(game.cards.length > 0);
  }
});

test('validation catches broken packs', async () => {
  const game = await loadGame('zone-duel', fsJson);
  const broken = structuredClone({ ...game, cardsById: undefined });
  broken.cards[1].stats = { level: 5, atk: 1 }; // missing def
  broken.cards[2].target = 0; // duplicate target
  const errors = validateGame(broken);
  assert.ok(errors.some((e) => e.includes('missing stat "def"')));
  assert.ok(errors.some((e) => e.includes('two cards use target 0')));
});

test('deck and hand: starting hand, draw per turn, play only from hand', async () => {
  const game = await loadGame('yugioh', fsJson);
  const duel = createDuel(game, fixed);
  assert.equal(duel.hand.length, 5);
  assert.equal(duel.deck.length, game.cards.length - 5);
  assert.match(canPlay(game, duel, 'ygo-89631139', 'MMZ1').reason, /not in your hand/);
  const events = endTurn(game, duel);
  assert.deepEqual(events.map((e) => e.type), ['turn', 'draw']);
  assert.equal(duel.hand.length, 6);
  const shuffled = createDuel(game, { random: () => 0 });
  assert.notDeepEqual(shuffled.hand, duel.hand.slice(0, 5));
});

test('yugioh: master rule zones, normal summon limit, tributes, first-turn attack ban', async () => {
  const game = await loadGame('yugioh', fsJson);
  const duel = createDuel(game, fixed);
  assert.equal(duel.life, 8000);
  const baby = 'ygo-88819587', curse = 'ygo-28279543', blueEyes = 'ygo-89631139';
  const thousand = 'ygo-41462083', yami = 'ygo-59197169', trapHole = 'ygo-04206964';
  const any = { fromHand: false };

  assert.match(canPlay(game, duel, curse, 'MMZ1').reason, /needs 1 tribute/);
  assert.ok(play(game, duel, baby, 'MMZ1').ok);
  assert.equal(canAttack(game, duel, 'MMZ1').reason, "No attacks on the duel's first turn");
  assert.equal(canPlay(game, duel, 'ygo-87796900', 'MMZ2').reason, 'Only 1 monster play per turn');
  assert.match(canPlay(game, duel, trapHole, 'MMZ2', any).reason, /can't go in a monster zone/);
  assert.ok(canPlay(game, duel, trapHole, 'ST1', any).ok);
  assert.match(canPlay(game, duel, yami, 'ST1', any).reason, /can't go in a spell-trap zone/);
  assert.ok(canPlay(game, duel, yami, 'FIELD', any).ok);
  assert.ok(canPlay(game, duel, thousand, 'EMZ-L', any).ok, 'extra deck monsters skip the normal summon limit');
  assert.match(canPlay(game, duel, baby, 'GY', any).reason, /graveyard/);

  endTurn(game, duel);
  assert.ok(canAttack(game, duel, 'MMZ1').ok);
  assert.ok(play(game, duel, curse, 'MMZ2').ok, 'Curse of Dragon tributes Baby Dragon');
  assert.equal(duel.field.MMZ1, undefined);
  endTurn(game, duel);
  assert.match(canPlay(game, duel, blueEyes, 'MMZ3', any).reason, /needs 2 tributes/);
  assert.ok(play(game, duel, thousand, 'EMZ-L', any).ok);
  const r = play(game, duel, blueEyes, 'MMZ3', any);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.events.filter((e) => e.type === 'destroy').map((e) => e.zoneId).sort(), ['EMZ-L', 'MMZ2']);
});

test('zone duel: one normal summon per turn, tributes for high levels', async () => {
  const game = await loadGame('zone-duel', fsJson);
  const duel = createDuel(game, fixed);
  assert.equal(duel.life, 8000);

  assert.equal(canPlay(game, duel, 'zd-ember-drake', 'M1').reason, 'Ember Drake needs 1 tribute on the field');
  assert.ok(play(game, duel, 'zd-dragon-whelp', 'M1').ok);
  assert.equal(canPlay(game, duel, 'zd-elder-wyrm', 'M2').reason, 'Only 1 monster play per turn');
  assert.match(canPlay(game, duel, 'zd-dragon-hoard', 'M2').reason, /can't go in a monster zone/);
  assert.ok(canPlay(game, duel, 'zd-dragon-hoard', 'S1').ok, 'spells are not limited by the monster summon');

  endTurn(game, duel);
  const r = play(game, duel, 'zd-ember-drake', 'M2');
  assert.deepEqual(r.events.map((e) => [e.type, e.zoneId]), [['destroy', 'M1'], ['summon', 'M2']]);
  assert.equal(duel.field.M1, undefined);
  assert.ok(canAttack(game, duel, 'M2').ok, 'no summoning sickness in zone duel');
});

test('mana clash: mana ramps per turn, summoning sickness applies', async () => {
  const game = await loadGame('mana-clash', fsJson);
  const duel = createDuel(game, fixed);
  assert.equal(duel.life, 20);
  assert.equal(duel.resources, 1);
  assert.equal(canPlay(game, duel, 'mc-dragon-whelp', 'B1').reason, 'Needs 2 mana, you have 1');
  assert.ok(play(game, duel, 'mc-hatchling', 'B1').ok);
  assert.equal(duel.resources, 0);
  assert.match(canAttack(game, duel, 'B1').reason, /can't attack the turn it arrives/);

  endTurn(game, duel);
  assert.equal(duel.resources, 2);
  assert.ok(canAttack(game, duel, 'B1').ok);
  assert.ok(play(game, duel, 'mc-dragon-whelp', 'B2').ok);
  assert.equal(describe(game, duel), 'Turn 2 · Life 20 · 0 in deck · 0 mana');
});
