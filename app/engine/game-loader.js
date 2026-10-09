// Loads TCG game packs. Each pack is a folder under games/ listed in games/index.json:
//
//   games/<id>/game.json    name, board layout, ruleset (see engine/rules-engine.js)
//   games/<id>/cards.json   the card data set: id, name, type, stats, model, image, target
//   games/<id>/targets.mind compiled image targets for card recognition (index = card.target)
//
// Paths inside a pack are relative to the pack folder.

const GAMES_ROOT = new URL('../games/', import.meta.url);

export async function loadCatalog(fetchJson = defaultFetchJson) {
  const index = await fetchJson(new URL('index.json', GAMES_ROOT));
  return index.games;
}

export async function loadGame(id, fetchJson = defaultFetchJson) {
  const base = new URL(`${id}/`, GAMES_ROOT);
  const manifest = await fetchJson(new URL('game.json', base));
  const cardData = await fetchJson(new URL(manifest.cards ?? 'cards.json', base));
  const game = {
    ...manifest,
    base: base.href,
    cards: cardData.cards,
    cardsById: Object.fromEntries(cardData.cards.map((c) => [c.id, c])),
    targetsSrc: manifest.targets ? new URL(manifest.targets, base).href : null,
    cardsByTarget: Object.fromEntries(cardData.cards.filter((c) => c.target != null).map((c) => [c.target, c])),
  };
  const errors = validateGame(game);
  if (errors.length) throw new Error(`Game pack "${id}" is invalid:\n- ${errors.join('\n- ')}`);
  for (const c of game.cards) {
    if (c.image) c.imageUrl = new URL(c.image, base).href;
    c.modelUrl = new URL(c.model?.src ?? manifest.defaultModel, base).href;
  }
  return game;
}

/** Light structural checks so a broken data set fails loudly at load, not mid-duel. */
export function validateGame(game) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(game.id && game.name, 'game.json needs id and name');
  need(Array.isArray(game.board?.zones) && game.board.zones.length, 'board.zones must list at least one zone');
  need(game.rules?.life?.starting > 0, 'rules.life.starting must be a positive number');
  const zoneIds = new Set();
  for (const z of game.board?.zones ?? []) {
    need(!zoneIds.has(z.id), `duplicate zone id ${z.id}`);
    zoneIds.add(z.id);
    need(typeof z.x === 'number' && typeof z.z === 'number', `zone ${z.id} needs numeric x and z`);
  }
  const cardIds = new Set();
  const targets = new Set();
  const statNames = new Set(Object.keys(game.cardFields ?? {}));
  for (const c of game.cards ?? []) {
    need(c.id && c.name && c.type, `card ${c.id ?? '?'} needs id, name and type`);
    need(!cardIds.has(c.id), `duplicate card id ${c.id}`);
    cardIds.add(c.id);
    if (c.target != null) {
      need(!targets.has(c.target), `two cards use target ${c.target}`);
      targets.add(c.target);
    }
    for (const [field, spec] of Object.entries(game.cardFields ?? {})) {
      if (spec.types && !spec.types.includes(c.type)) continue;
      need(c.stats?.[field] != null, `card ${c.id} is missing stat "${field}"`);
    }
    for (const k of Object.keys(c.stats ?? {})) need(statNames.has(k), `card ${c.id} has unknown stat "${k}"`);
  }
  const r = game.rules ?? {};
  if (r.resources) need(statNames.has(r.resources.costStat), `rules.resources.costStat "${r.resources.costStat}" is not a card field`);
  if (r.summonCost?.tributes) need(statNames.has(r.summonCost.tributes.stat), 'rules.summonCost.tributes.stat is not a card field');
  return errors;
}

async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
