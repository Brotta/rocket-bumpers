/**
 * AnnouncerSFX — arena-shooter style voice announcer that shouts
 * the same impact word shown on screen ("POW!", "KABOOM!", etc.).
 *
 * Pre-recorded clips are generated offline with Bark (Suno AI) and
 * post-processed for a deep, aggressive, reverberant announcer voice.
 *
 * Uses the existing SFXPlayer singleton for playback (pool, priority,
 * voice limiting). Non-spatial — the announcer is always centered,
 * like Quake/UT announcers.
 */

import { sfxPlayer } from './SFXPlayer.js';
import { ANNOUNCER, IMPACT_TEXT } from '../core/Config.js';

class AnnouncerSFXSingleton {
  constructor() {
    this._lastPlayTime = 0;
    this._registered = new Set();
    this._preloaded = false;
  }

  /**
   * Pre-register all announcer clips in the SFXPlayer.
   * Call once after audioManager.init() (e.g., in Game.setPlayer()).
   */
  async preload() {
    if (this._preloaded) return;
    this._preloaded = true;

    // Collect all unique words from IMPACT_TEXT config
    const allWords = new Set();
    for (const typeWords of Object.values(IMPACT_TEXT.words)) {
      for (const tierWords of Object.values(typeWords)) {
        for (const word of tierWords) allWords.add(word.toLowerCase());
      }
    }

    const entries = [];
    for (const w of allWords) {
      const name = `announcer_${w}`;
      entries.push({ name, url: `${ANNOUNCER.basePath}announcer_${w}.ogg` });
      this._registered.add(name);
    }

    await sfxPlayer.registerAll(entries);
  }

  /**
   * Play the announcer clip for the given impact word.
   * Respects a cooldown to prevent rapid-fire overlap (e.g., turret hits).
   * @param {string} word — the impact word (e.g., "KABOOM")
   */
  play(word) {
    const now = performance.now() / 1000;
    if (now - this._lastPlayTime < ANNOUNCER.cooldown) return;

    const name = `announcer_${word.toLowerCase()}`;
    if (!this._registered.has(name)) return;

    sfxPlayer.play(name, { priority: 8, volume: ANNOUNCER.volume });
    this._lastPlayTime = now;
  }
}

export const announcerSFX = new AnnouncerSFXSingleton();
