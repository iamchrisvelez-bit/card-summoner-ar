// Drive the Quest mode in Chromium with IWER emulating a Meta Quest 3: place the board, play
// cards from the hand under each game's rules, and screenshot the result.
// Usage: node tools/e2e-quest.mjs [game id]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const gameId = process.argv[2] || 'zone-duel';
const root = new URL('..', import.meta.url).pathname;
const server = await serve(root + 'app', 8125);
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 600 } });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[page]', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('dialog', (d) => { console.log('[dialog]', d.message()); d.dismiss(); });

// Install the emulated Quest 3 before the app's modules run.
await page.route('**/iwer.module.js', (r) => r.fulfill({ contentType: 'text/javascript',
  body: readFileSync(root + 'node_modules/iwer/build/iwer.module.js') }));
await page.route('http://localhost:8125/?noshuffle', async (r) => {
  const html = readFileSync(root + 'app/index.html', 'utf8').replace('<script type="module" src="main.js">',
    `<script type="module">import { XRDevice, metaQuest3 } from '/iwer.module.js';
     window.__device = new XRDevice(metaQuest3); window.__device.installRuntime({ forceInstall: true });</script>
     <script type="module" src="main.js">`);
  r.fulfill({ contentType: 'text/html', body: html });
});

const q = () => page.evaluate(() => window.__questAR);
const trigger = async () => {
  await page.evaluate(() => window.__device.controllers.right.updateButtonValue('trigger', 1));
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__device.controllers.right.updateButtonValue('trigger', 0));
  await page.waitForTimeout(250);
};
// Point the right controller from just below the head at a world-space target.
const aimAt = (target) => page.evaluate(([tx, ty, tz]) => {
  const c = window.__device.controllers.right;
  const p = { x: 0.15, y: 1.35, z: -0.15 };
  c.position.set(p.x, p.y, p.z);
  let dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
  const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
  let ax = dy, ay = -dx;
  const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
  const half = Math.acos(Math.max(-1, Math.min(1, -dz))) / 2;
  c.quaternion.set(ax * Math.sin(half), ay * Math.sin(half), 0, Math.cos(half));
}, target);
// Let a few frames pass so three.js picks up the new controller pose before the trigger.
const pointAndPull = async (pos) => { await aimAt(pos); await page.waitForTimeout(300); await trigger(); };

const results = [];
const check = (label, cond, detail = '') => { results.push(cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${detail}`); };

await page.goto('http://localhost:8125/?noshuffle');
await page.waitForFunction(() => window.__questAR.supported && document.querySelector('#game').options.length, null, { timeout: 15000 });
await page.selectOption('#game', gameId);
await page.screenshot({ path: `${root}test-out/q0-intro-${gameId}.png` });
await page.click('#enter-xr');
await page.waitForFunction(() => window.__questAR.session && window.__questAR.game, null, { timeout: 30000 });
await page.waitForTimeout(3500); // no real surfaces in the emulator -> fallback reticle
await trigger();
check('board placed', (await q()).placed);
await page.waitForTimeout(500);

const zones = await page.evaluate(() => window.__questAR.zones());
// The hand fan is rebuilt after each play or draw, so look card positions up each time.
const pick = async (cardId) => pointAndPull(await page.evaluate((id) => window.__questAR.handCards()[id], cardId));
const endTurnPos = await page.evaluate(() => window.__questAR.endTurnPos());

const lastRefusal = async () => (await q()).refused.at(-1)?.reason ?? '';
if (gameId === 'yugioh') {
  const baby = 'ygo-88819587', winged = 'ygo-87796900', curse = 'ygo-28279543';
  await pick(curse);
  await pointAndPull(zones.MMZ1);
  check('Curse of Dragon (Lv5) needs a tribute', /needs 1 tribute/.test(await lastRefusal()), await lastRefusal());
  await pick(baby);
  await pointAndPull(zones.MMZ3);
  check('Baby Dragon normal summoned', (await q()).summoned === 1);
  await page.waitForTimeout(1200);
  await pointAndPull(zones.MMZ3);
  check('no attacks on the first turn', /No attacks on the duel's first turn/.test((await q()).banner), (await q()).banner);
  await pick(winged);
  await pointAndPull(zones.MMZ2);
  check('one Normal Summon per turn', /Only 1 monster play per turn/.test(await lastRefusal()), await lastRefusal());
  await page.screenshot({ path: `${root}test-out/q1-${gameId}-turn1.png` });
  await pointAndPull(endTurnPos);
  check('drew a card on turn 2', /drew Summoned Skull/.test((await q()).banner), (await q()).banner);
  await pick(curse);
  await pointAndPull(zones.MMZ4);
  const field = await page.evaluate(() => window.__game.duel.field);
  check('Curse of Dragon tributed Baby Dragon', !field.MMZ3 && field.MMZ4?.cardId === curse, JSON.stringify(field));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${root}test-out/q2-${gameId}-tribute.png` });
} else if (gameId === 'zone-duel') {
  await pick('zd-ember-drake');
  await pointAndPull(zones.M1);
  check('level 5 needs a tribute', (await q()).refused.at(-1)?.reason?.includes('needs 1 tribute'), (await q()).refused.at(-1)?.reason);
  await pick('zd-dragon-whelp');
  await pointAndPull(zones.M2);
  check('whelp summoned', (await q()).summoned === 1);
  await pick('zd-dragon-hoard');
  await pointAndPull(zones.M3);
  check('spell refused in monster zone', /can't go in a monster zone/.test((await q()).refused.at(-1)?.reason));
  await pointAndPull(zones.S3);
  check('spell played in spell zone', (await q()).summoned === 2);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${root}test-out/q1-${gameId}-turn1.png` });
  await pointAndPull(endTurnPos);
  await pick('zd-ember-drake');
  await pointAndPull(zones.M4);
  const duel = await page.evaluate(() => window.__game.duel.field);
  check('ember drake tributed the whelp', !duel.M2 && duel.M4?.cardId === 'zd-ember-drake', JSON.stringify(duel));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${root}test-out/q2-${gameId}-tribute.png` });
} else {
  await pick('mc-dragon-whelp');
  await pointAndPull(zones.B3);
  check('whelp costs 2 mana on turn 1', /Needs 2 mana/.test((await q()).refused.at(-1)?.reason), (await q()).refused.at(-1)?.reason);
  await pick('mc-hatchling');
  await pointAndPull(zones.B3);
  check('hatchling played', (await q()).summoned === 1);
  await pointAndPull(zones.B3);
  check('summoning sickness blocks attack', /can't attack/.test((await q()).banner));
  for (let i = 0; i < 3; i++) await pointAndPull(endTurnPos);
  await pick('mc-ember-drake');
  await pointAndPull(zones.B4);
  await pick('mc-dragon-whelp');
  await pointAndPull(zones.B2);
  check('turn 4: 4 mana spent on the drake, whelp refused', (await q()).summoned === 2 && /Needs 2 mana, you have 0/.test((await q()).refused.at(-1)?.reason), (await q()).banner);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${root}test-out/q1-${gameId}.png` });
}
console.log('banner:', (await q()).banner.replace('\n', ' | '));
await browser.close();
server.close();
process.exit(results.every(Boolean) ? 0 : 1);
