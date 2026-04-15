/**
 * ArenaMusic — background music for in-game arena gameplay.
 * Plays `volcano-circuit.mp3` in a loop, with fade-in on start
 * and fade-out on stop.
 *
 * Follows the same pattern as MenuMusic:
 *  - Uses MediaElementAudioSourceNode to route HTML5 Audio through the MUSIC bus
 *  - Gains volume bus routing (independent MUSIC volume control)
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS } from './AudioConfig.js';

const FADE_IN_MS = 2000;
const FADE_OUT_MS = 1000;
const VOLUME = 0.35;

let _audio = null;
let _mediaSource = null;
let _fading = null;

function _fade(from, to, duration) {
  return new Promise((resolve) => {
    if (_fading) cancelAnimationFrame(_fading);
    if (!_audio) { resolve(); return; }

    const start = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      if (_audio) _audio.volume = from + (to - from) * t;
      if (t < 1) {
        _fading = requestAnimationFrame(tick);
      } else {
        _fading = null;
        resolve();
      }
    };
    _fading = requestAnimationFrame(tick);
  });
}

function _routeToMusicBus() {
  if (_mediaSource) return;
  if (!audioManager.isInitialized || !_audio) return;

  try {
    const ctx = audioManager.ctx;
    const musicBus = audioManager.getBus(AUDIO_BUS.MUSIC);
    if (!ctx || !musicBus) return;

    _mediaSource = ctx.createMediaElementSource(_audio);
    _mediaSource.connect(musicBus);
  } catch (e) {
    console.warn('ArenaMusic: could not route to MUSIC bus', e);
  }
}

export const arenaMusic = {
  /** Start looping arena music with fade-in. Safe to call multiple times. */
  play() {
    if (_audio) return;
    _audio = new Audio('assets/music/volcano-circuit.mp3');
    _audio.loop = true;
    _audio.volume = 0;

    if (!audioManager.isInitialized) {
      audioManager.init();
    }

    _audio.play().then(() => {
      _routeToMusicBus();
      _fade(0, VOLUME, FADE_IN_MS);
    }).catch(() => {
      // Autoplay blocked — retry on first user gesture
      _audio = null;
      _mediaSource = null;
      const retry = () => {
        window.removeEventListener('click', retry);
        window.removeEventListener('keydown', retry);
        window.removeEventListener('touchstart', retry);
        this.play();
      };
      window.addEventListener('click', retry, { once: true });
      window.addEventListener('keydown', retry, { once: true });
      window.addEventListener('touchstart', retry, { once: true });
    });
  },

  /** Fade out and stop. Returns a promise that resolves when silent. */
  async stop() {
    if (!_audio) return;
    await _fade(_audio.volume, 0, FADE_OUT_MS);
    if (_audio) {
      _audio.pause();
      if (_mediaSource) {
        try { _mediaSource.disconnect(); } catch (_) {}
        _mediaSource = null;
      }
      _audio.src = '';
      _audio = null;
    }
  },
};
