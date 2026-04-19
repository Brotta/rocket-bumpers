/**
 * AudioManager — centralized audio system for the entire game.
 *
 * Owns a single AudioContext and routes all audio through categorized buses
 * (ENGINE, SFX, MUSIC, UI) with independent volume controls.
 *
 * Provides:
 *  - Sample preloading and caching (decode once, reuse forever)
 *  - Priority-based voice management with configurable max concurrent voices
 *  - Protected voices that cannot be culled (nearby geysers, lava eruption)
 *  - Browser autoplay policy handling (resume on first user gesture)
 *  - Tab visibility suspend/resume (zero CPU when tab hidden)
 *  - Listener position tracking for spatial audio
 *
 * Audio graph:
 *   [ENGINE bus] ─┐
 *   [SFX bus]    ──┤→ [Master GainNode] → AudioContext.destination
 *   [MUSIC bus]  ──┤
 *   [UI bus]     ──┘
 *
 * All time-dependent operations use delta-time, never frame count.
 */

import { AUDIO_BUS, AUDIO_VOLUMES, VOICE_LIMITS } from './AudioConfig.js';

class AudioManagerSingleton {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;

    /** @type {GainNode|null} */
    this._master = null;

    /** @type {Map<string, GainNode>} bus name → GainNode */
    this._buses = new Map();

    /** @type {Map<string, AudioBuffer>} url → decoded AudioBuffer */
    this._sampleCache = new Map();

    /** @type {Map<number, VoiceEntry>} voiceId → VoiceEntry */
    this._voices = new Map();
    this._nextVoiceId = 1;

    // Listener position (local player), updated per frame
    this._listenerX = 0;
    this._listenerZ = 0;

    this._initialized = false;
    this._gestureListenerAttached = false;
    this._visibilityListenerAttached = false;
  }

  // ══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Create AudioContext and buses. Safe to call multiple times.
   * Must be called after a user gesture for autoplay policy compliance.
   */
  init() {
    if (this._initialized) return;

    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('AudioManager: Web Audio API not available', e);
      return;
    }

    // Master gain
    this._master = this.ctx.createGain();
    this._master.gain.value = AUDIO_VOLUMES.master;
    this._master.connect(this.ctx.destination);

    // Create category buses
    for (const busName of Object.values(AUDIO_BUS)) {
      const bus = this.ctx.createGain();
      bus.gain.value = AUDIO_VOLUMES[busName] ?? 1.0;
      bus.connect(this._master);
      this._buses.set(busName, bus);
    }

    this._initialized = true;

    // Handle suspended context (autoplay policy)
    this._ensureContextRunning();
    this._attachVisibilityListener();
  }

  /**
   * Resume context if suspended. Attaches user-gesture listeners if needed.
   *
   * NOTE: listeners are intentionally persistent. In multiplayer the async
   * WebSocket handshake between the user's click and the first audio
   * activity can span several seconds; some browsers auto-suspend the
   * AudioContext during that gap. If we remove the listeners on first
   * fire (as the previous one-shot version did), the context has no way
   * to come back until a visibility change — which presents as "no SFX
   * online, everything fine offline" because the offline path starts
   * audio immediately after the click with nothing to suspend it.
   */
  _ensureContextRunning() {
    if (!this.ctx) return;

    // Try immediate resume if suspended
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (this._gestureListenerAttached) return;
    this._gestureListenerAttached = true;
    const resumeOnGesture = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('click', resumeOnGesture, { passive: true });
    window.addEventListener('keydown', resumeOnGesture, { passive: true });
    window.addEventListener('touchstart', resumeOnGesture, { passive: true });
  }

  /**
   * Suspend context when tab is hidden, resume when visible.
   * Saves 100% of audio CPU when the tab is in background.
   */
  _attachVisibilityListener() {
    if (this._visibilityListenerAttached) return;
    this._visibilityListenerAttached = true;

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this.ctx.suspend();
      } else {
        this.ctx.resume();
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUS ACCESS & VOLUME CONTROL
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Get the GainNode for a bus category.
   * @param {string} busName - One of AUDIO_BUS values
   * @returns {GainNode|null}
   */
  getBus(busName) {
    return this._buses.get(busName) || null;
  }

  /**
   * Set volume for a specific bus (0-1).
   */
  setBusVolume(busName, volume) {
    const bus = this._buses.get(busName);
    if (bus) {
      bus.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Set master volume (0-1).
   */
  setMasterVolume(volume) {
    if (this._master) {
      this._master.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // SAMPLE LOADING
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Load and decode an audio sample. Returns cached buffer on repeat calls.
   * @param {string} url - Path to the audio file
   * @returns {Promise<AudioBuffer>}
   */
  async loadSample(url) {
    if (this._sampleCache.has(url)) {
      return this._sampleCache.get(url);
    }

    if (!this.ctx) {
      throw new Error('AudioManager: not initialized. Call init() first.');
    }

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

    this._sampleCache.set(url, audioBuffer);
    return audioBuffer;
  }

  /**
   * Preload multiple samples in parallel. Logs warnings for failures
   * but does not throw (graceful degradation).
   * @param {string[]} urls - Array of audio file paths
   */
  async preloadAll(urls) {
    const results = await Promise.allSettled(
      urls.map((url) => this.loadSample(url)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.warn(`AudioManager: failed to load ${urls[i]}`, results[i].reason);
      }
    }
  }

  /**
   * Get a cached AudioBuffer (already loaded).
   * @param {string} url
   * @returns {AudioBuffer|null}
   */
  getCachedSample(url) {
    return this._sampleCache.get(url) || null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // LISTENER POSITION (for spatial audio)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Update the listener position (should be called each frame with local player pos).
   */
  setListenerPosition(x, z) {
    this._listenerX = x;
    this._listenerZ = z;
  }

  get listenerX() { return this._listenerX; }
  get listenerZ() { return this._listenerZ; }

  // ══════════════════════════════════════════════════════════════════════
  // VOICE MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Register a voice for priority tracking.
   * @param {object} opts
   * @param {number} opts.priority - 0-10 (higher = more important)
   * @param {string} opts.category - AUDIO_BUS value
   * @param {boolean} [opts.protected] - If true, cannot be culled
   * @param {GainNode} [opts.gainNode] - The gain node to silence when culled
   * @returns {number} voiceId for later updates/unregistration
   */
  registerVoice({ priority, category, protected: isProtected = false, gainNode = null }) {
    const id = this._nextVoiceId++;
    this._voices.set(id, {
      id,
      priority,
      category,
      protected: isProtected,
      gainNode,
      active: true,
      distance: 0,
    });
    return id;
  }

  /**
   * Update a voice's priority and distance (call per frame for dynamic voices).
   */
  updateVoice(voiceId, { priority, distance, protected: isProtected } = {}) {
    const voice = this._voices.get(voiceId);
    if (!voice) return;
    if (priority !== undefined) voice.priority = priority;
    if (distance !== undefined) voice.distance = distance;
    if (isProtected !== undefined) voice.protected = isProtected;
  }

  /**
   * Unregister a voice (on car removal, sound end, etc.)
   */
  unregisterVoice(voiceId) {
    this._voices.delete(voiceId);
  }

  /**
   * Enforce max voice limit. Silences lowest-priority non-protected voices.
   * Should be called once per frame (from the render update loop).
   */
  enforceVoiceLimits() {
    if (this._voices.size <= VOICE_LIMITS.maxVoices) return;

    // Collect non-protected, active voices sorted by priority ascending (lowest first)
    const cullable = [];
    for (const voice of this._voices.values()) {
      if (!voice.protected && voice.active) {
        cullable.push(voice);
      }
    }
    cullable.sort((a, b) => a.priority - b.priority || b.distance - a.distance);

    // Cull excess
    let excess = this._voices.size - VOICE_LIMITS.maxVoices;
    for (const voice of cullable) {
      if (excess <= 0) break;
      if (voice.gainNode) {
        voice.gainNode.gain.value = 0;
      }
      voice.active = false;
      excess--;
    }
  }

  /**
   * Re-activate previously culled voices if capacity is available.
   * Called after enforceVoiceLimits to reclaim voices when others drop off.
   */
  reactivateVoices() {
    let activeCount = 0;
    const inactive = [];
    for (const voice of this._voices.values()) {
      if (voice.active) activeCount++;
      else inactive.push(voice);
    }

    // Sort by priority descending — highest priority gets reactivated first
    inactive.sort((a, b) => b.priority - a.priority);

    for (const voice of inactive) {
      if (activeCount >= VOICE_LIMITS.maxVoices) break;
      voice.active = true;
      activeCount++;
      // Gain will be set by the owning system on next update
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // SPATIAL HELPERS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Calculate distance from listener to a world position.
   */
  distanceToListener(x, z) {
    const dx = x - this._listenerX;
    const dz = z - this._listenerZ;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Calculate inverse-distance attenuation gain (0-1).
   * @param {number} distance - Distance from listener
   * @param {number} refDist - Distance at which gain = 1.0
   * @param {number} maxDist - Distance beyond which gain = 0
   * @returns {number} 0-1 gain value
   */
  distanceGain(distance, refDist, maxDist) {
    if (distance >= maxDist) return 0;
    if (distance <= refDist) return 1;
    return refDist / distance;
  }

  /**
   * Calculate stereo pan value (-1 to +1) for a world position.
   * Negative = left, positive = right.
   * Uses a simplified model based on the angle from listener's forward direction.
   * @param {number} x - World X of the sound source
   * @param {number} z - World Z of the sound source
   * @param {number} listenerYaw - Listener's yaw angle (radians)
   * @returns {number} -1 to +1
   */
  stereoPan(x, z, listenerYaw) {
    const dx = x - this._listenerX;
    const dz = z - this._listenerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.1) return 0;

    // Angle from listener to source
    const angle = Math.atan2(dx, dz);
    // Relative angle (how far left/right of listener's facing)
    const relAngle = angle - listenerYaw;

    // Normalize to [-PI, PI]
    const normalized = Math.atan2(Math.sin(relAngle), Math.cos(relAngle));

    // Map to -1..+1 (sin gives natural left/right distribution)
    return Math.sin(normalized);
  }

  // ══════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Pause all audio processing (tab switch, pause menu).
   */
  pause() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend();
    }
  }

  /**
   * Resume audio processing.
   */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Best-effort ensure the context is running. Safe to call from any
   * audio-emitting code path — it cheaply no-ops when already running.
   * Useful as a defensive kick before scheduling one-shot SFX so we
   * don't emit into a suspended context.
   */
  ensureRunning() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Mute/unmute master output (soft, with short ramp to avoid clicks).
   */
  setMuted(muted) {
    if (!this._master || !this.ctx) return;
    const target = muted ? 0 : AUDIO_VOLUMES.master;
    this._master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
  }

  /**
   * Clean up everything. Call on game destroy.
   */
  dispose() {
    for (const [, voice] of this._voices) {
      if (voice.gainNode) {
        try { voice.gainNode.disconnect(); } catch (_) {}
      }
    }
    this._voices.clear();
    this._sampleCache.clear();
    this._buses.clear();

    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
    this.ctx = null;
    this._master = null;
    this._initialized = false;
  }

  /** @returns {boolean} Whether the manager has been initialized */
  get isInitialized() {
    return this._initialized;
  }
}

// ── Singleton export ──────────────────────────────────────────────────
export const audioManager = new AudioManagerSingleton();
