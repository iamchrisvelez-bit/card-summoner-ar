// Compile a game pack's card images into its MindAR targets file (target index = card.target).
// Usage: node tools/compile.mjs <game id>
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { serve } from './serve.mjs';

const id = process.argv[2];
const root = new URL('..', import.meta.url).pathname;
const pack = `app/games/${id}`;
const game = JSON.parse(readFileSync(`${root}${pack}/game.json`, 'utf8'));
const cards = JSON.parse(readFileSync(`${root}${pack}/cards.json`, 'utf8')).cards
  .filter((c) => c.target != null).sort((a, b) => a.target - b.target);
cards.forEach((c, i) => { if (c.target !== i) throw new Error(`targets must be 0..n-1 without gaps (${c.id})`); });

const server = await serve(root, 8123);
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('http://localhost:8123/tools/compile.html');
await page.waitForFunction(() => window.ready);
const b64 = await page.evaluate((urls) => window.compileTargets(urls), cards.map((c) => `/${pack}/${c.image}`));
const out = `${root}${pack}/${game.targets}`;
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`wrote ${out} (${cards.length} targets)`);
await browser.close();
server.close();
