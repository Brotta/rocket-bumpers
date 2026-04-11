/**
 * MenuMusic — background music for splash / lobby / car-select screens.
 * Plays `hot_roadway_bpm160.ogg` in a loop, with fade-in on start
 * and fade-out on stop.
 *
 * Migrated to AudioManager:
 *  - Uses MediaElementAudioSourceNode to route HTML5 Audio through the MUSIC bus
 *  - Keeps the simple .play()/.pause() API of HTMLAudioElement
 *  - Gains volume bus routing (independent MUSIC volume control)
 *  - Autoplay retry handled by AudioManager globally
 */

import { audioManager } from './AudioManager.js';
import { AUDIO_BUS, AUDIO_VOLUMES } from './AudioConfig.js';

const FADE_IN_MS = 1500;
const FADE_OUT_MS = 800;
const VOLUME = 0.45;

let _audio = null;
let _mediaSource = null; // MediaElementAudioSourceNode (created once per element)
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

/**
 * Route the Audio element through the MUSIC bus if AudioManager is ready.
 * Uses MediaElementAudioSourceNode so the HTMLAudioElement output goes
 * through AudioContext (gains the bus volume control) instead of directly
 * to speakers.
 */
function _routeToMusicBus() {
  if (_mediaSource) return; // already routed
  if (!audioManager.isInitialized || !_audio) return;

  try {
    const ctx = audioManager.ctx;
    const musicBus = audioManager.getBus(AUDIO_BUS.MUSIC);
    if (!ctx || !musicBus) return;

    _mediaSource = ctx.createMediaElementSource(_audio);
    _mediaSource.connect(musicBus);
  } catch (e) {
    // MediaElementAudioSourceNode can only be created once per element.
    // If it fails (e.g., CORS), the audio still plays via default output.
    console.warn('MenuMusic: could not route to MUSIC bus', e);
  }
}

export const menuMusic = {
  _pendingRetry: false,

  /** Start looping menu music with fade-in. Safe to call multiple times. */
  play() {
    if (_audio) return; // already playing
    _audio = new Audio('assets/splash/hot_roadway_bpm160.ogg');
    _audio.loop = true;
    _audio.volume = 0;

    // Ensure AudioManager is initialized before routing
    if (!audioManager.isInitialized) {
      audioManager.init();
    }

    _audio.play().then(() => {
      _routeToMusicBus();
      _fade(0, VOLUME, FADE_IN_MS);
      this._pendingRetry = false;
    }).catch(() => {
      // Autoplay blocked — retry on first user gesture
      _audio = null;
      _mediaSource = null;
      if (!this._pendingRetry) {
        this._pendingRetry = true;
        const retry = () => {
          window.removeEventListener('click', retry);
          window.removeEventListener('keydown', retry);
          window.removeEventListener('touchstart', retry);
          this._pendingRetry = false;
          this.play();
        };
        window.addEventListener('click', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
        window.addEventListener('touchstart', retry, { once: true });
      }
    });
  },

  /** Fade out and stop. Returns a promise that resolves when silent. */
  async stop() {
    if (!_audio) return;
    await _fade(_audio.volume, 0, FADE_OUT_MS);
    if (_audio) {
      _audio.pause();
      // Disconnect media source before destroying the element
      if (_mediaSource) {
        try { _mediaSource.disconnect(); } catch (_) {}
        _mediaSource = null;
      }
      _audio.src = '';
      _audio = null;
    }
  },
};
