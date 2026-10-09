// Phone mode: MindAR image tracking. Each card of the active game's data set is an image
// target; when a card is seen it is played under that game's rules and its monster appears
// standing on the physical card, inside a virtual board.
import * as THREE from 'three';
import { MindARThree } from './vendor/mindar/mindar-image-three.prod.js';
import { createCreature, easeOutBack, isCreature, loadModel } from './creature.js';
import { startSelectedGame } from './active-game.js';
import { canAttack, canPlay, describe, endTurn, play } from './engine/rules-engine.js';

// MindAR anchor space: the card's width is 1 unit, origin at the card centre,
// +Y towards the card's top edge and +Z pointing up out of the table.
const CARD_ASPECT = 1050 / 750;
const MONSTER_SCALE = 0.58; // 1.55 m nose-to-tail -> ~0.9 card widths, times card.model.scale
const BOARD_W = 4.2;
const BOARD_H = 3.4;
const RESUMMON_AFTER_MS = 4000; // re-play the entrance if the card was gone this long

const $ = (id) => document.getElementById(id);
const container = $('ar');
const ui = { intro: $('intro'), start: $('start'), hint: $('hint'), hud: $('hud'), actions: $('actions') };

// Exposed for automated tests.
const state = window.__cardAR = {
  started: false, found: 0, lost: 0, visible: false, anim: null, error: null, played: [], refused: [],
};

function makeBoardTexture(theme) {
  const pxPerUnit = 256;
  const canvas = document.createElement('canvas');
  canvas.width = BOARD_W * pxPerUnit;
  canvas.height = BOARD_H * pxPerUnit;
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const fill = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.6);
  fill.addColorStop(0, theme.fill[0]);
  fill.addColorStop(1, theme.fill[1]);
  g.fillStyle = fill;
  roundRect(g, 0, 0, W, H, 60);
  g.fill();
  g.lineWidth = 14;
  g.strokeStyle = theme.edge;
  g.stroke();

  // Card slots: the centre one holds the physical card, the side ones are empty.
  const slotW = 1.1 * pxPerUnit;
  const slotH = slotW * CARD_ASPECT;
  const gap = 0.25 * pxPerUnit;
  for (const i of [-1, 0, 1]) {
    const x = W / 2 + i * (slotW + gap) - slotW / 2;
    const y = H / 2 - slotH / 2;
    g.lineWidth = i === 0 ? 10 : 5;
    g.strokeStyle = theme.edge;
    g.globalAlpha = i === 0 ? 1 : 0.55;
    roundRect(g, x, y, slotW, slotH, 18);
    g.stroke();
    g.globalAlpha = 1;
  }
  // Punch a hole so the real card shows through the virtual board.
  const cw = pxPerUnit * 1.02, ch = cw * CARD_ASPECT;
  g.globalCompositeOperation = 'destination-out';
  g.fillRect(W / 2 - cw / 2, H / 2 - ch / 2, cw, ch);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Board, monster and summon effect for one card's anchor. */
function buildCardScene(anchorGroup, card, gltf, theme) {
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_W, BOARD_H),
    new THREE.MeshBasicMaterial({ map: makeBoardTexture(theme), transparent: true, opacity: 0.92 }),
  );
  board.position.z = -0.005;
  anchorGroup.add(board);

  // The model is Y-up facing +Z; stand it on the card, facing the card's bottom edge (the player).
  const holder = new THREE.Group();
  anchorGroup.add(holder);
  const creature = gltf ? createCreature(gltf, { hue: card.model?.hue, onAnim: (n) => { state.anim = n; } }) : null;
  if (creature) {
    creature.object.rotation.x = Math.PI / 2;
    holder.add(creature.object);
  }
  const scale = MONSTER_SCALE * (card.model?.scale ?? 1);

  // Summon effect: a ring that expands and fades, plus a light pillar.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.45, 0.55, 64),
    new THREE.MeshBasicMaterial({ color: theme.edge, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.position.z = 0.01;
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 1.6, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x9cffc4, transparent: true, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pillar.rotation.x = Math.PI / 2;
  pillar.position.z = 0.8;
  anchorGroup.add(ring, pillar);

  let summonT = Infinity;
  let alive = false;
  return {
    play: (name) => creature?.play(name),
    summon() {
      alive = true;
      summonT = 0;
      creature?.play('Roar', 0.1);
    },
    destroy() { alive = false; },
    update(dt) {
      creature?.update(dt);
      summonT += dt;
      const t = Math.min(summonT / 0.7, 1);
      holder.scale.setScalar(alive ? scale * Math.max(easeOutBack(t), 0.001) : 0.001);
      const fx = Math.min(summonT / 1.2, 1);
      ring.visible = pillar.visible = fx < 1;
      ring.scale.setScalar(1 + fx * 2.5);
      ring.material.opacity = 1 - fx;
      pillar.material.opacity = 0.6 * (1 - fx);
    },
  };
}

/** The first zone the rules allow this card into, or the reason none does. */
function chooseZone(game, duel, card) {
  let reason = `No free zone for ${card.name}`;
  for (const z of game.board.zones) {
    const check = canPlay(game, duel, card.id, z.id, { fromHand: false });
    if (check.ok) return { zoneId: z.id };
    if (!/zone|occupied/.test(check.reason)) reason = check.reason; // prefer a rules reason
  }
  return { reason };
}

async function startAR() {
  ui.start.disabled = true;
  ui.start.textContent = 'Starting…';
  try {
    const { game, duel } = await startSelectedGame();
    if (!game.targetsSrc) {
      throw Object.assign(new Error(`${game.name} has no card recognition targets yet. Use Quest mode, or scan your cards (see GAME_PACKS.md).`), { userFacing: true });
    }
    const mindar = new MindARThree({
      container,
      imageTargetSrc: game.targetsSrc,
      maxTrack: 1, // similar card frames can false-match while another card is tracked
      uiScanning: 'no',
      uiLoading: 'no',
      filterMinCF: 0.0001,
      filterBeta: 0.01,
    });
    const { renderer, scene, camera } = mindar;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 1);
    scene.add(sun);

    const setHud = (msg) => { ui.hud.textContent = msg ? `${describe(game, duel)} · ${msg}` : describe(game, duel); };
    const cardViews = [];
    const byZone = new Map(); // zoneId -> card view on the field
    let focused = null; // zoneId of the card most recently seen (for the action buttons)

    for (const card of game.cards.filter((c) => c.target != null)) {
      const anchor = mindar.addAnchor(card.target);
      const gltf = isCreature(card, game) ? await loadModel(card.modelUrl) : null;
      const view = buildCardScene(anchor.group, card, gltf, game.board.theme);
      cardViews.push(view);
      let zoneId = null;
      let lostAt = -Infinity;

      anchor.onTargetFound = () => {
        state.found++;
        state.visible = true;
        ui.hint.classList.add('hidden');
        if (zoneId && duel.field[zoneId]?.cardId === card.id) {
          // Already on the field: show it again, replaying the entrance after a long absence.
          if (performance.now() - lostAt > RESUMMON_AFTER_MS) view.summon();
        } else {
          const choice = chooseZone(game, duel, card);
          // A recognised physical card comes from the player's real hand, not the virtual one.
          const result = choice.zoneId ? play(game, duel, card.id, choice.zoneId, { fromHand: false })
            : { ok: false, reason: choice.reason };
          if (!result.ok) {
            state.refused.push({ card: card.id, reason: result.reason });
            setHud(result.reason);
            return;
          }
          zoneId = choice.zoneId;
          for (const e of result.events) if (e.type === 'destroy') byZone.get(e.zoneId)?.destroy();
          byZone.set(zoneId, view);
          state.played.push(card.id);
          view.summon();
          setHud(`${card.name} summoned`);
        }
        focused = zoneId;
        ui.actions.classList.remove('hidden');
      };
      anchor.onTargetLost = () => {
        state.lost++;
        state.visible = false;
        lostAt = performance.now();
        ui.hint.classList.remove('hidden');
      };
    }

    ui.actions.onclick = (e) => {
      const { action, anim } = e.target.dataset ?? {};
      if (action === 'end-turn') {
        endTurn(game, duel);
        setHud('New turn');
      } else if (action === 'attack' && focused) {
        const check = canAttack(game, duel, focused);
        if (check.ok) byZone.get(focused)?.play('Roar');
        setHud(check.ok ? 'Attack!' : check.reason);
      } else if (anim && focused) {
        byZone.get(focused)?.play(anim);
      }
    };

    await mindar.start();
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = clock.getDelta();
      for (const v of cardViews) v.update(dt);
      renderer.render(scene, camera);
    });

    state.started = true;
    ui.intro.classList.add('hidden');
    ui.hint.classList.remove('hidden');
    ui.hud.classList.remove('hidden');
    setHud(`Playing ${game.name}`);
  } catch (err) {
    console.error(err);
    state.error = String(err?.message || err);
    ui.start.disabled = false;
    ui.start.textContent = 'Start phone camera';
    alert(`Could not start AR: ${state.error}${err?.userFacing ? '' : '\n\nThe page needs HTTPS and camera permission.'}`);
  }
}

ui.start.addEventListener('click', startAR);
