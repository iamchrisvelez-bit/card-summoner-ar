// Mixed-reality duel board for Meta Quest (WebXR immersive-ar in Quest Browser).
//
// 1. Point at the table and pull the trigger (or pinch) to lay down the active game's board.
// 2. Point at a card in your hand (dealt from the game's deck, along the near edge) to pick it,
//    then at a zone to play it. The active game's ruleset decides what is allowed; refusals show on the banner.
// 3. Point at a monster on the field to attack (rules permitting), or at "End turn".
// 4. Optional: "Watch for cards" tries the headset camera (getUserMedia). When it sees a card
//    from the active game's set, that card is played into the first zone the rules allow.
//
// Units are metres in a local-floor reference space.
import * as THREE from 'three';
import { Controller } from './vendor/mindar/mindar-image.prod.js';
import { createCreature, easeOutBack, isCreature, loadModel } from './creature.js';
import { startSelectedGame } from './active-game.js';
import { drawCardFace } from './card-face.js';
import { canAttack, canPlay, describe, endTurn, play } from './engine/rules-engine.js';

const CARD_W = 0.063;
const CARD_H = 0.088;
const MONSTER_SCALE = 0.24; // 1.55 m model -> ~0.37 m nose to tail, times card.model.scale
// Monsters stand on the table just beyond the board, spread wider than the zones so they don't overlap.
const FIELD_SPREAD = 2.6;
const FIELD_GAP = 0.16;

const state = window.__questAR = {
  supported: false, session: false, hitTest: false, placed: false, summoned: 0, camera: 'off', error: null,
  selected: null, refused: [],
};

const enterBtn = document.getElementById('enter-xr');
const watchBox = document.getElementById('watch-cards');

if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    state.supported = ok;
    if (ok) document.getElementById('xr-block').classList.remove('hidden');
  }).catch(() => {});
}
enterBtn?.addEventListener('click', () => enterXR().catch((err) => {
  console.error(err);
  state.error = String(err?.message || err);
  alert(`Could not start mixed reality: ${state.error}`);
}));

async function enterXR() {
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['hit-test', 'hand-tracking', 'plane-detection', 'anchors'],
  });
  state.session = true;
  document.getElementById('intro').classList.add('hidden');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.5, 2, 1);
  scene.add(sun);

  const { game, duel } = await startSelectedGame();
  state.game = game.id;
  const texLoader = new THREE.TextureLoader();
  const cardTextures = Object.fromEntries(await Promise.all(game.cards.map(async (c) => {
    // Packs without card images (e.g. Yu-Gi-Oh!, art not bundled) get a face drawn from the data.
    const t = c.imageUrl ? await texLoader.loadAsync(c.imageUrl) : new THREE.CanvasTexture(drawCardFace(c, game));
    t.colorSpace = THREE.SRGBColorSpace;
    return [c.id, t];
  })));
  const models = Object.fromEntries(await Promise.all(
    game.cards.filter((c) => isCreature(c, game)).map(async (c) => [c.id, await loadModel(c.modelUrl)])));

  const reticle = makeReticle();
  scene.add(reticle);
  const board = makeBoard(game);
  board.group.visible = false;
  scene.add(board.group);
  const hand = makeHand(game, cardTextures);
  hand.sync(duel.hand);
  board.group.add(hand.group);
  const endTurnBtn = makeButton('End turn');
  endTurnBtn.position.set(game.board.width / 2 + 0.07, 0.03, game.board.depth / 2 - 0.03);
  endTurnBtn.rotation.x = -Math.PI / 4;
  board.group.add(endTurnBtn);
  const banner = makeBanner(`${game.name}: point at the table and pull the trigger to place the board`);
  scene.add(banner.mesh);
  const say = (msg) => banner.set(msg ? `${describe(game, duel)}\n${msg}` : describe(game, duel));

  const live = []; // per-frame updaters; one returning false is dropped
  const onField = new Map(); // zoneId -> { creature, holder, cardMesh }

  await renderer.xr.setSession(session);

  // Hit-test against real surfaces from the head; fall back to a spot in front of the user.
  let hitSource = null;
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
    state.hitTest = true;
  } catch { hitSource = null; }

  // Controllers (hands pinching also fire "select").
  const raycaster = new THREE.Raycaster();
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    ctrl.add(makeRay());
    ctrl.addEventListener('select', () => onSelect(ctrl));
    scene.add(ctrl);
  }

  function onSelect(ctrl) {
    if (!state.placed) {
      if (reticle.visible) placeBoard(reticle.matrix);
      return;
    }
    const m = new THREE.Matrix4().extractRotation(ctrl.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(m);
    const targets = [...hand.cards, ...board.zones, endTurnBtn, ...[...onField.values()].map((f) => f.hitbox).filter(Boolean)];
    const hit = raycaster.intersectObjects(targets, false)[0]?.object;
    if (!hit) return;
    const { cardId, zoneId, fieldZone } = hit.userData;
    if (hit === endTurnBtn) {
      const drawn = endTurn(game, duel).filter((e) => e.type === 'draw');
      hand.sync(duel.hand);
      say(drawn.length ? `New turn: drew ${drawn.map((e) => game.cardsById[e.cardId].name).join(', ')}` : 'New turn');
    } else if (cardId) {
      hand.select(cardId);
      state.selected = cardId;
      say(`${game.cardsById[cardId].name} selected: point at a zone`);
    } else if (fieldZone || (zoneId && duel.field[zoneId])) {
      attack(fieldZone ?? zoneId);
    } else if (zoneId) {
      if (!state.selected) return say('Pick a card from your hand first');
      tryPlay(state.selected, zoneId);
    }
  }

  function attack(zoneId) {
    const check = canAttack(game, duel, zoneId);
    if (check.ok) onField.get(zoneId)?.creature?.play('Roar');
    say(check.ok ? 'Attack!' : check.reason);
  }

  function tryPlay(cardId, zoneId, opts) {
    const result = play(game, duel, cardId, zoneId, opts);
    if (!result.ok) {
      state.refused.push({ card: cardId, zone: zoneId, reason: result.reason });
      return say(result.reason);
    }
    for (const e of result.events) {
      if (e.type === 'destroy') banish(e.zoneId);
      if (e.type === 'summon') summon(e.cardId, e.zoneId);
    }
    if (state.selected === cardId && !duel.hand.includes(cardId)) state.selected = null;
    hand.sync(duel.hand);
    say(`${game.cardsById[cardId].name} played`);
  }

  function placeBoard(matrix) {
    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
    board.group.position.copy(pos);
    // Turn the board so its near edge (+Z) faces the player.
    const head = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
    board.group.rotation.set(0, Math.atan2(head.x - pos.x, head.z - pos.z), 0);
    board.group.visible = true;
    reticle.visible = false;
    state.placed = true;
    state.zones = () => Object.fromEntries(board.zones.map((z) => [z.userData.zoneId, z.getWorldPosition(new THREE.Vector3()).toArray()]));
    state.endTurnPos = () => endTurnBtn.getWorldPosition(new THREE.Vector3()).toArray();
    state.handCards = () => Object.fromEntries(hand.cards.map((c) => [c.userData.cardId, c.getWorldPosition(new THREE.Vector3()).toArray()]));
    say('Pick a card from your hand, then point at a zone');
  }

  function summon(cardId, zoneId) {
    const card = game.cardsById[cardId];
    const zone = game.board.zones.find((z) => z.id === zoneId);
    const zoneMesh = board.zones.find((z) => z.userData.zoneId === zoneId);

    // The card itself lies in its zone as a hologram.
    const cardMesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: cardTextures[cardId], transparent: true, opacity: 0.9 }));
    cardMesh.position.copy(zoneMesh.position).setY(0.004);
    board.group.add(cardMesh);
    const entry = { cardMesh };
    onField.set(zoneId, entry);
    state.summoned++;

    if (!isCreature(card, game)) return;
    const spot = new THREE.Vector3(zone.x * FIELD_SPREAD, 0, -(game.board.depth / 2 + FIELD_GAP));
    const fx = makeSummonFX(cardTextures[cardId], game.board.theme.edge);
    fx.group.position.copy(spot);
    board.group.add(fx.group);
    live.push(fx);

    const creature = createCreature(models[cardId], { hue: card.model?.hue });
    const holder = new THREE.Group();
    holder.position.copy(spot);
    holder.rotation.y = Math.PI; // monsters face the opponent's side (-Z)
    holder.scale.setScalar(0.0001);
    holder.add(creature.object);
    board.group.add(holder);
    const scale = MONSTER_SCALE * (card.model?.scale ?? 1);
    const hitbox = new THREE.Mesh(new THREE.BoxGeometry(0.25 * scale / MONSTER_SCALE, 0.2, 0.3 * scale / MONSTER_SCALE),
      new THREE.MeshBasicMaterial({ visible: false }));
    hitbox.position.copy(spot).setY(0.1);
    hitbox.userData.fieldZone = zoneId;
    board.group.add(hitbox);
    Object.assign(entry, { creature, holder, hitbox });

    let t = -0.45; // appear once the card hologram has risen
    live.push({
      update(dt) {
        if (!holder.parent) return false;
        creature.update(dt);
        t += dt;
        if (t < 0) return true;
        if (t - dt < 0) creature.play('Roar', 0.1);
        holder.scale.setScalar(scale * Math.max(easeOutBack(Math.min(t / 0.8, 1)), 0.0001));
        return true;
      },
    });
  }

  /** Tributed or destroyed: the monster shrinks into a burst and its card fades. */
  function banish(zoneId) {
    const entry = onField.get(zoneId);
    if (!entry) return;
    onField.delete(zoneId);
    let t = 0;
    const start = entry.holder?.scale.x ?? 0;
    entry.hitbox?.removeFromParent();
    live.push({
      update(dt) {
        t += dt;
        const k = Math.min(t / 0.6, 1);
        entry.holder?.scale.setScalar(Math.max(start * (1 - k), 0.0001));
        if (entry.holder) entry.holder.position.y = k * 0.1;
        entry.cardMesh.material.opacity = 0.9 * (1 - k);
        if (k < 1) return true;
        entry.holder?.removeFromParent();
        entry.cardMesh.removeFromParent();
        return false;
      },
    });
  }

  // Experimental: watch the headset camera for cards of the active set.
  if (watchBox?.checked) startCardWatcher(game.targetsSrc, (targetIndex) => {
    const card = game.cardsByTarget[targetIndex];
    if (!card || !state.placed) return;
    if (Object.values(duel.field).some((f) => f.cardId === card.id)) return;
    // A physical card is played from the real hand, not the virtual one.
    const zone = game.board.zones.find((z) => canPlay(game, duel, card.id, z.id, { fromHand: false }).ok);
    if (zone) tryPlay(card.id, zone.id, { fromHand: false });
    else say(`${card.name} seen, but the rules don't allow playing it now`);
  });

  const clock = new THREE.Clock();
  let fallbackAt = performance.now() + 2500;
  renderer.setAnimationLoop((time, frame) => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const head = renderer.xr.getCamera();

    if (!state.placed && frame) {
      const results = hitSource ? frame.getHitTestResults(hitSource) : [];
      const pose = results[0]?.getPose(renderer.xr.getReferenceSpace());
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        reticle.visible = true;
        fallbackAt = performance.now() + 2500;
      } else if (performance.now() > fallbackAt) {
        // No surface found: offer a spot ~60 cm ahead at table height below the eyes.
        const p = head.getWorldPosition(new THREE.Vector3());
        const fwd = head.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
        p.addScaledVector(fwd, 0.6).setY(Math.max(p.y - 0.5, 0.4));
        reticle.matrix.makeTranslation(p.x, p.y, p.z);
        reticle.visible = true;
      }
    }

    banner.follow(head, dt);
    hand.update(dt);
    for (let i = live.length - 1; i >= 0; i--) if (live[i].update(dt) === false) live.splice(i, 1);
    renderer.render(scene, camera);
  });

  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    renderer.domElement.remove();
    state.session = false;
    document.getElementById('intro').classList.remove('hidden');
  });
}

function makeReticle() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd86b }),
  );
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  return ring;
}

function makeRay() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd86b, transparent: true, opacity: 0.6 }));
}

/** The game's board: a mat drawn from game.board (size, theme, zones) plus invisible zone hit boxes. */
function makeBoard(game) {
  const { width, depth, theme, zones: zoneDefs } = game.board;
  const group = new THREE.Group();
  const px = 1600;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = Math.round(px * depth / width);
  const g = canvas.getContext('2d');
  const s = px / width; // pixels per metre
  const grad = g.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, theme.fill[0]);
  grad.addColorStop(1, theme.fill[1]);
  g.globalAlpha = 0.85;
  g.fillStyle = grad;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalAlpha = 1;
  g.strokeStyle = theme.edge;
  g.lineWidth = 10;
  g.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);

  const zones = [];
  for (const z of zoneDefs) {
    const color = theme.kinds?.[z.kind] ?? theme.edge;
    const w = (CARD_W + 0.012) * s, h = (CARD_H + 0.012) * s;
    const cx = (z.x + width / 2) * s, cy = (z.z + depth / 2) * s;
    g.strokeStyle = color;
    g.lineWidth = 6;
    g.strokeRect(cx - w / 2, cy - h / 2, w, h);
    g.globalAlpha = 0.12;
    g.fillStyle = color;
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    g.globalAlpha = 1;
    const zone = new THREE.Mesh(new THREE.BoxGeometry(CARD_W + 0.012, 0.01, CARD_H + 0.012),
      new THREE.MeshBasicMaterial({ visible: false }));
    zone.position.set(z.x, 0.005, z.z);
    zone.userData.zoneId = z.id;
    zones.push(zone);
    group.add(zone);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  plane.position.y = 0.002;
  group.add(plane);
  return { group, zones };
}

/** The player's hand (duel.hand), fanned along the board's near edge. */
function makeHand(game, textures) {
  const group = new THREE.Group();
  // Nearly flat along the near edge, so it stays below the line of sight to the far zones.
  group.position.set(0, 0.015, game.board.depth / 2 + CARD_H / 2 + 0.02);
  group.rotation.x = -Math.PI / 2 + 0.35;
  const geometry = new THREE.PlaneGeometry(CARD_W, CARD_H);
  let cards = [];
  let selected = null;
  return {
    group,
    get cards() { return cards; },
    /** Rebuild the fan to show these card ids, overlapping when the hand gets wide. */
    sync(ids) {
      for (const m of cards) m.removeFromParent();
      const spacing = Math.min(CARD_W * 1.15, (game.board.width + 0.1) / Math.max(ids.length, 1));
      cards = ids.map((id, i) => {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: textures[id], side: THREE.DoubleSide }));
        mesh.position.set((i - (ids.length - 1) / 2) * spacing, 0, i * 0.0005);
        mesh.userData.cardId = id;
        group.add(mesh);
        return mesh;
      });
      if (!ids.includes(selected)) selected = null;
    },
    select(id) { selected = id; },
    update(dt) {
      for (const m of cards) {
        const target = m.userData.cardId === selected ? 0.02 : 0; // selected card slides forward
        m.position.y += (target - m.position.y) * Math.min(dt * 10, 1);
      }
    },
  };
}

function makeButton(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const g = canvas.getContext('2d');
  g.fillStyle = '#d6ac40';
  g.beginPath();
  g.roundRect(0, 0, 256, 96, 40);
  g.fill();
  g.fillStyle = '#1a1408';
  g.font = '600 40px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.034),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
}

/** Anime-style summon: the card rises as a hologram inside a light pillar with rings and sparks. */
function makeSummonFX(cardTexture, ringColor) {
  const group = new THREE.Group();
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };

  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W * 1.6, CARD_H * 1.6),
    new THREE.MeshBasicMaterial({ map: cardTexture, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.8, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x9cffc4, ...additive }));
  pillar.position.y = 0.4;
  const rings = [0, 1, 2].map(() => {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.06, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: ringColor, ...additive }));
    r.position.y = 0.004;
    return r;
  });

  const N = 160;
  const seeds = Array.from({ length: N }, () => ({
    a: Math.random() * Math.PI * 2, r: 0.02 + Math.random() * 0.06, v: 0.25 + Math.random() * 0.5, d: Math.random() * 0.4,
  }));
  const positions = new Float32Array(N * 3);
  const sparksGeo = new THREE.BufferGeometry();
  sparksGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const sparks = new THREE.Points(sparksGeo, new THREE.PointsMaterial({ color: 0xfff2b0, size: 0.008, ...additive }));

  group.add(card, pillar, sparks, ...rings);

  let t = 0;
  const DURATION = 1.8;
  return {
    group,
    update(dt) {
      t += dt;
      const k = Math.min(t / DURATION, 1);
      // Card: flat on the table -> upright and floating, spinning once, then fading.
      const rise = Math.min(t / 0.5, 1);
      card.position.y = 0.02 + rise * 0.22;
      card.rotation.set(-Math.PI / 2 * (1 - rise), rise * Math.PI * 2, 0);
      card.material.opacity = t < 0.6 ? 1 : Math.max(1 - (t - 0.6) / 0.4, 0);
      pillar.material.opacity = 0.5 * Math.sin(Math.PI * Math.min(t / 1.2, 1));
      pillar.scale.set(1 + k, 1, 1 + k);
      rings.forEach((r, i) => {
        const rk = Math.max(Math.min((t - i * 0.18) / 0.9, 1), 0);
        r.scale.setScalar(1 + rk * 4);
        r.material.opacity = rk > 0 ? 1 - rk : 0;
      });
      seeds.forEach((s, i) => {
        const st = Math.max(t - s.d, 0);
        const a = s.a + st * 4;
        positions.set([Math.cos(a) * (s.r + st * 0.05), st * s.v, Math.sin(a) * (s.r + st * 0.05)], i * 3);
      });
      sparksGeo.attributes.position.needsUpdate = true;
      sparks.material.opacity = 1 - k;
      if (k >= 1) {
        group.removeFromParent();
        return false;
      }
      return true;
    },
  };
}

/** A text panel (one or two lines) that floats in front of and below the user's gaze. */
function makeBanner(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 200;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.098),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  mesh.renderOrder = 10;
  function set(msg) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(15,26,20,0.85)';
    g.beginPath();
    g.roundRect(0, 0, canvas.width, canvas.height, 40);
    g.fill();
    g.fillStyle = '#f3ecd6';
    g.font = '600 38px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = [];
    for (const para of msg.split('\n')) {
      lines.push('');
      for (const w of para.split(' ')) {
        const next = lines.at(-1) ? `${lines.at(-1)} ${w}` : w;
        if (g.measureText(next).width > canvas.width - 80) lines.push(w); else lines[lines.length - 1] = next;
      }
    }
    lines.forEach((l, i) => g.fillText(l, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * 46));
    tex.needsUpdate = true;
    state.banner = msg;
  }
  const target = new THREE.Vector3();
  function follow(head, dt) {
    const fwd = head.getWorldDirection(new THREE.Vector3());
    target.copy(head.getWorldPosition(new THREE.Vector3())).addScaledVector(fwd, 0.7);
    target.y += 0.12;
    mesh.position.lerp(target, Math.min(dt * 3, 1));
    mesh.lookAt(head.getWorldPosition(new THREE.Vector3()));
  }
  set(text);
  return { mesh, set, follow };
}

/**
 * Experimental: Quest Browser does not offer WebXR camera access, but getUserMedia can
 * return passthrough camera frames. Run MindAR's detector on them to recognise cards of
 * the active set; calls onSeen(targetIndex) each time a card comes into view.
 */
async function startCardWatcher(targetsSrc, onSeen) {
  try {
    state.camera = 'starting';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const visible = new Set();
    const controller = new Controller({
      inputWidth: video.videoWidth,
      inputHeight: video.videoHeight,
      maxTrack: 2,
      onUpdate: (data) => {
        if (data.type !== 'updateMatrix') return;
        if (data.worldMatrix === null) visible.delete(data.targetIndex);
        else if (!visible.has(data.targetIndex)) {
          visible.add(data.targetIndex);
          onSeen(data.targetIndex);
        }
      },
    });
    await controller.addImageTargets(targetsSrc);
    controller.dummyRun(video);
    controller.processVideo(video);
    state.camera = 'watching';
  } catch (err) {
    console.warn('Card watcher unavailable:', err);
    state.camera = `unavailable: ${err?.message || err}`;
  }
}
