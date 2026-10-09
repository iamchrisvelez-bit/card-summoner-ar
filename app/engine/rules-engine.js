// Data-driven rules engine. A game's rules are a JSON "ruleset" built from a small set of
// primitives (life, deck/hand, turn limits, resources, summon costs, summoning sickness), so the same
// game pack can be interpreted by this JS engine or a future native (Unity) client.
// Pure logic: no three.js or DOM, so it runs in node tests too.

/**
 * Create the state for a new duel of `game` (a loaded game pack). The deck is the pack's
 * `deckList` (card ids) or one of every card; `shuffle: false` keeps that order (tests).
 */
export function createDuel(game, { shuffle = true, random = Math.random } = {}) {
  const r = game.rules;
  const deck = [...(game.deckList ?? game.cards.map((c) => c.id))];
  if (shuffle) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  const duel = {
    gameId: game.id,
    turn: 1,
    life: r.life.starting,
    resources: resourceForTurn(r, 1),
    playsThisTurn: {},
    deck,
    hand: [],
    field: {}, // zoneId -> { cardId, summonedTurn }
    log: [],
  };
  draw(duel, r.deck?.startingHand ?? deck.length);
  return duel;
}

function draw(duel, n) {
  const drawn = duel.deck.splice(0, n);
  duel.hand.push(...drawn);
  return drawn;
}

/**
 * Can `cardId` be played into `zoneId` right now? Returns { ok: true, cost } or
 * { ok: false, reason }. `cost` describes what playing it will consume (tributes, resources).
 */
export function canPlay(game, duel, cardId, zoneId, { fromHand = true } = {}) {
  const r = game.rules;
  const card = game.cardsById[cardId];
  if (!card) return no(`Unknown card ${cardId}`);
  if (fromHand && !duel.hand.includes(cardId)) return no(`${card.name} is not in your hand`);
  const zone = game.board.zones.find((z) => z.id === zoneId);
  if (!zone) return no(`Unknown zone ${zoneId}`);
  const accepts = r.zones?.[zone.kind]?.accepts ?? [zone.kind];
  if (!accepts.includes(card.type)) return no(`A ${card.type} can't go in a ${zone.kind} zone`);
  if (duel.field[zoneId]) return no('That zone is already occupied');

  const limit = r.turn?.playsPerTurn?.[card.type];
  if (limit != null && (duel.playsThisTurn[card.type] ?? 0) >= limit) {
    return no(`Only ${limit} ${card.type} play${limit === 1 ? '' : 's'} per turn`);
  }

  const cost = { tributes: [], resources: 0 };
  if (r.resources) {
    cost.resources = Number(card.stats[r.resources.costStat] ?? 0);
    if (cost.resources > duel.resources) {
      return no(`Needs ${cost.resources} ${r.resources.name}, you have ${duel.resources}`);
    }
  }
  const tier = tributeTier(r, card);
  if (tier) {
    const from = r.summonCost.tributes.from ?? [card.type];
    const candidates = Object.entries(duel.field)
      .filter(([, f]) => from.includes(game.cardsById[f.cardId].type))
      .sort(([, a], [, b]) => tributeValue(r, game.cardsById[a.cardId]) - tributeValue(r, game.cardsById[b.cardId]));
    if (candidates.length < tier.count) {
      return no(`${card.name} needs ${tier.count} tribute${tier.count === 1 ? '' : 's'} on the field`);
    }
    // Tribute the weakest ones.
    cost.tributes = candidates.slice(0, tier.count).map(([z]) => z);
  }
  return { ok: true, cost };
}

/**
 * Play a card. Returns the events for the view to animate: destroy (tributes) then summon.
 * `fromHand: false` plays a card from outside the virtual hand (a recognised physical card).
 */
export function play(game, duel, cardId, zoneId, { fromHand = true } = {}) {
  const check = canPlay(game, duel, cardId, zoneId, { fromHand });
  if (!check.ok) return { ok: false, reason: check.reason, events: [] };
  const card = game.cardsById[cardId];
  const events = [];
  for (const z of check.cost.tributes) {
    events.push({ type: 'destroy', zoneId: z, cardId: duel.field[z].cardId, reason: 'tribute' });
    delete duel.field[z];
  }
  duel.resources -= check.cost.resources;
  const inHand = duel.hand.indexOf(cardId);
  if (inHand >= 0) duel.hand.splice(inHand, 1);
  duel.playsThisTurn[card.type] = (duel.playsThisTurn[card.type] ?? 0) + 1;
  duel.field[zoneId] = { cardId, summonedTurn: duel.turn };
  events.push({ type: 'summon', zoneId, cardId });
  duel.log.push(`Turn ${duel.turn}: ${card.name} -> ${zoneId}`);
  return { ok: true, events };
}

/** Can the creature in `zoneId` attack this turn? */
export function canAttack(game, duel, zoneId) {
  const f = duel.field[zoneId];
  if (!f) return no('Nothing there');
  if (game.rules.turn?.noAttackFirstTurn && duel.turn === 1) return no("No attacks on the duel's first turn");
  if (game.rules.summoningSickness && f.summonedTurn === duel.turn) {
    return no(`${game.cardsById[f.cardId].name} can't attack the turn it arrives`);
  }
  return { ok: true };
}

export function endTurn(game, duel) {
  duel.turn += 1;
  duel.playsThisTurn = {};
  duel.resources = resourceForTurn(game.rules, duel.turn, duel.resources);
  const drawn = draw(duel, game.rules.deck?.drawPerTurn ?? 0);
  return [{ type: 'turn', turn: duel.turn }, ...drawn.map((cardId) => ({ type: 'draw', cardId }))];
}

/** One line for a HUD, e.g. "Turn 2 · LP 8000 · 1 normal summon left". */
export function describe(game, duel) {
  const r = game.rules;
  const parts = [`Turn ${duel.turn}`, `${r.life.name} ${duel.life}`];
  if (r.deck) parts.push(`${duel.deck.length} in deck`);
  if (r.resources) parts.push(`${duel.resources} ${r.resources.name}`);
  for (const [type, limit] of Object.entries(r.turn?.playsPerTurn ?? {})) {
    parts.push(`${Math.max(limit - (duel.playsThisTurn[type] ?? 0), 0)} ${type} play left`);
  }
  return parts.join(' · ');
}

function resourceForTurn(r, turn, previous = 0) {
  const res = r.resources;
  if (!res) return 0;
  // "ramp": refill to min(turn, max) each turn. "accumulate": add perTurn, capped at max.
  if (res.mode === 'accumulate') return Math.min(previous + (res.perTurn ?? 1), res.max ?? Infinity);
  return Math.min(turn, res.max ?? Infinity);
}

function tributeTier(r, card) {
  const t = r.summonCost?.tributes;
  if (!t || !(t.types ?? [card.type]).includes(card.type)) return null;
  const v = Number(card.stats[t.stat] ?? 0);
  return [...t.tiers].sort((a, b) => b.min - a.min).find((tier) => v >= tier.min) ?? null;
}

function tributeValue(r, card) {
  return Number(card.stats[r.summonCost.tributes.stat] ?? 0);
}

function no(reason) {
  return { ok: false, reason };
}
