// The game picker on the start screen. Whichever TCG is selected supplies the card data set,
// board layout and ruleset for both the Quest and phone modes.
import { loadCatalog, loadGame } from './engine/game-loader.js';
import { createDuel } from './engine/rules-engine.js';

const STORAGE_KEY = 'card-summoner.game';
const select = document.getElementById('game');
const summary = document.getElementById('game-summary');
const printLink = document.getElementById('print-cards');

export const catalogReady = (async () => {
  const games = await loadCatalog();
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch {}
  for (const g of games) select.add(new Option(g.name, g.id, false, g.id === saved));
  const update = () => {
    const g = games.find((x) => x.id === select.value);
    summary.textContent = g?.summary ?? '';
    printLink.href = `cards.html?game=${encodeURIComponent(select.value)}`;
    try { localStorage.setItem(STORAGE_KEY, select.value); } catch {}
  };
  select.addEventListener('change', update);
  update();
  return games;
})();

/** Load the selected game pack and start a fresh duel under its rules. */
export async function startSelectedGame() {
  await catalogReady;
  const game = await loadGame(select.value);
  const shuffle = !new URLSearchParams(location.search).has('noshuffle'); // tests use a fixed deck order
  const duel = createDuel(game, { shuffle });
  window.__game = { game, duel }; // for tests and debugging
  return { game, duel };
}
