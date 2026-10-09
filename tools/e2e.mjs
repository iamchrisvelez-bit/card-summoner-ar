// Drive the app in Chromium with a fake camera showing the card, and screenshot the result.
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const root = new URL('..', import.meta.url).pathname;
const server = await serve(root + 'app', 8124);
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${root}test-out/card_on_table.y4m`],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on('console', (m) => { if (m.type() !== 'debug') console.log('[page]', m.type(), m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8124/');
await page.screenshot({ path: root + 'test-out/0-intro.png' });
// Yu-Gi-Oh! (the default) has no card images yet, so track the printable demo cards.
await page.waitForFunction(() => document.querySelector('#game').options.length);
await page.selectOption('#game', 'zone-duel');
await page.click('#start');
await page.waitForFunction(() => window.__cardAR.started || window.__cardAR.error, null, { timeout: 120000 });
console.log('after start', await page.evaluate(() => JSON.stringify(window.__cardAR)));
await page.waitForFunction(() => window.__cardAR.found > 0, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: root + 'test-out/1-summon.png' });
await page.waitForTimeout(4000);
await page.screenshot({ path: root + 'test-out/2-idle.png' });
await page.click('#actions [data-anim=Flap]').catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: root + 'test-out/3-flap.png' });
console.log('final', await page.evaluate(() => JSON.stringify({ ...window.__cardAR, hud: document.getElementById('hud').textContent })));
await browser.close();
server.close();
