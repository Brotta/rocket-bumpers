import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map(); // path → Promise<GLTF>

/**
 * Load a static (non-animated) GLB model. Clones from cache on repeat calls.
 * @param {string} path - URL to GLB file
 * @returns {Promise<THREE.Group>}
 */
export async function loadModel(path) {
  const gltf = await _load(path);
  const clone = gltf.scene.clone(true);
  clone.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return clone;
}

/**
 * Preload all car GLBs into cache. Call once at startup.
 * @param {string[]} paths
 */
export function preloadAll(paths) {
  return Promise.all(paths.map((p) => _load(p)));
}

function _load(path) {
  if (!cache.has(path)) {
    cache.set(
      path,
      new Promise((resolve, reject) => {
        loader.load(path, resolve, undefined, (err) =>
          reject(new Error(`Failed to load: ${path} — ${err.message || err}`)),
        );
      }),
    );
  }
  return cache.get(path);
}
