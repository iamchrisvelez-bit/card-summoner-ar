import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ONE_SHOT = ['Roar'];
const loader = new GLTFLoader();
const cache = new Map();

/** Load (once) the glTF for a model URL. */
export function loadModel(url) {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url));
  return cache.get(url);
}

/**
 * An animated monster instance, cloned so several can share one loaded model.
 * The model is Y-up, facing +Z, feet on y = 0. Its colour lives in the COLOR_0 vertex
 * colours, so `hue` (degrees) recolours a variant by rotating them, keeping the shading.
 * Returns { object, play(name), update(dt) }; `onAnim` reports the clip playing.
 */
export function createCreature(gltf, { hue, onAnim } = {}) {
  const object = SkeletonUtils.clone(gltf.scene);
  if (hue) {
    const c = new THREE.Color();
    const hsl = {};
    object.traverse((o) => {
      const colors = o.isMesh && o.geometry.getAttribute('color');
      if (!colors) return;
      o.geometry = o.geometry.clone();
      const attr = o.geometry.getAttribute('color');
      for (let i = 0; i < attr.count; i++) {
        c.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i)).getHSL(hsl);
        c.setHSL((hsl.h + hue / 360 + 1) % 1, hsl.s, hsl.l);
        attr.setXYZ(i, c.r, c.g, c.b);
      }
    });
  }
  const mixer = new THREE.AnimationMixer(object);
  const actions = Object.fromEntries(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
  for (const name of ONE_SHOT) {
    if (!actions[name]) continue;
    actions[name].setLoop(THREE.LoopOnce, 1);
    actions[name].clampWhenFinished = true;
  }
  let current = null;
  function play(name, fade = 0.25) {
    const next = actions[name];
    if (!next) return;
    next.reset().setEffectiveWeight(1).play();
    if (current && current !== next) current.crossFadeTo(next, fade, false);
    current = next;
    onAnim?.(name);
  }
  mixer.addEventListener('finished', () => play('Idle', 0.4));
  return { object, play, update: (dt) => mixer.update(dt) };
}

/** easeOutBack: overshoots slightly then settles, for a "pop in" scale. */
export function easeOutBack(t) {
  return 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
}

/** Does this card put a 3D monster on the table? (Spells and traps stay as cards.) */
export function isCreature(card, game) {
  return (game.creatureTypes ?? ['monster', 'creature']).includes(card.type);
}
