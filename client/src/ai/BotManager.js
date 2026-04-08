import { BOTS, CARS, PLAYERS, ARENA, getSpawnPosition } from '../core/Config.js';
import { buildCar } from '../rendering/CarFactory.js';
import { CarBody } from '../physics/CarBody.js';
import { AbilitySystem } from '../physics/AbilitySystem.js';
import { BotBrain } from './BotBrain.js';
import { PERSONALITIES, randomPersonality } from './BotPersonalities.js';

const CAR_KEYS = Object.keys(CARS);

/**
 * BotManager — spawns AI bots to fill empty slots up to 8 players.
 *
 * Bots are first-class citizens: they use the same CarBody, AbilitySystem,
 * and collision/respawn flow as the local player. Their BotBrain produces
 * human-like input that is fed into applyControls() each frame.
 */
export class BotManager {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {CANNON.World} deps.world
   * @param {CarBody[]} deps.carBodies          — shared array (Game.carBodies)
   * @param {Map<CarBody, AbilitySystem>} deps.abilities — shared map (Game.abilities)
   * @param {import('../core/PowerUpManager.js').PowerUpManager} deps.powerUpManager
   */
  constructor({ scene, world, carBodies, abilities, powerUpManager, carMaterial }) {
    this.scene = scene;
    this.world = world;
    this.carBodies = carBodies;
    this.abilities = abilities;
    this.powerUpManager = powerUpManager;
    this.carMaterial = carMaterial || null;

    /** @type {{ carBody: CarBody, ability: AbilitySystem, brain: BotBrain, personalityName: string }[]} */
    this.bots = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Fill empty slots with bots until we reach PLAYERS.maxPerRoom.
   * Call once after the local player has been added to carBodies.
   */
  async fillSlots() {
    const slotsToFill = PLAYERS.maxPerRoom - this.carBodies.length;
    const availableNames = BOTS.names.slice();
    // Shuffle names
    for (let i = availableNames.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [availableNames[i], availableNames[j]] = [availableNames[j], availableNames[i]];
    }

    const promises = [];
    // Slot 0 is reserved for local player; bots fill slots 1..7
    const startSlot = this.carBodies.length; // typically 1 (after local player)
    for (let i = 0; i < slotsToFill; i++) {
      const name = availableNames[i % availableNames.length];
      const carType = CAR_KEYS[Math.floor(Math.random() * CAR_KEYS.length)];
      promises.push(this._spawnBot(name, carType, startSlot + i));
    }
    await Promise.all(promises);
  }

  /** Tick all bot brains and apply their inputs. */
  update(dt) {
    for (const bot of this.bots) {
      // Skip dead / fallen / eliminated bots
      if (bot.carBody.isEliminated) continue;
      if (bot.carBody.body.position.y < -2) continue;
      if (!bot.carBody.mesh.visible) continue;

      const input = bot.brain.update(dt);
      bot.carBody.applyControls(input, dt);
    }
  }

  /** Check if a CarBody belongs to a bot. */
  isBot(carBody) {
    return this.bots.some((b) => b.carBody === carBody);
  }

  /** Reset brain state for a bot after respawn. */
  resetBrain(carBody) {
    const bot = this.bots.find((b) => b.carBody === carBody);
    if (bot) bot.brain.reset();
  }

  /** Remove all bots (e.g. on round reset before re-filling). */
  removeAll() {
    for (const bot of this.bots) {
      this.scene.remove(bot.carBody.mesh);
      this.world.removeBody(bot.carBody.body);
      bot.ability.dispose();
      this.abilities.delete(bot.carBody);

      const idx = this.carBodies.indexOf(bot.carBody);
      if (idx !== -1) this.carBodies.splice(idx, 1);
    }
    this.bots.length = 0;
  }

  /** Reset all bots for a new round (reposition, reset scores). */
  resetForNewRound() {
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      const cb = bot.carBody;
      // Bots occupy slots 1..7 (slot 0 is local player)
      const sp = getSpawnPosition(i + 1);
      cb.setPosition(sp.x, sp.y, sp.z, sp.yaw);
      cb.mesh.visible = true;
      cb.resetHP();
      cb.isInvincible = false;

      // Invalidate stale timeouts and restore mass/speed/flags
      cb.resetState();

      // Reset brain state properly
      bot.brain.reset();
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  async _spawnBot(name, carType, slotIndex = 1) {
    const mesh = await buildCar(carType);
    this.scene.add(mesh);

    const carBody = new CarBody(carType, mesh, this.world, {
      carMaterial: this.carMaterial,
    });
    carBody.playerId = `bot_${name}`;
    carBody.nickname = name;

    // Spawn at octagon vertex (slot-based), facing center
    const sp = getSpawnPosition(slotIndex);
    carBody.setPosition(sp.x, sp.y, sp.z, sp.yaw);

    this.carBodies.push(carBody);

    // Ability system
    const ability = new AbilitySystem(carType, carBody, {
      scene: this.scene,
      world: this.world,
      getOtherBodies: () => this.carBodies.filter((cb) => cb !== carBody),
    });
    this.abilities.set(carBody, ability);

    // Personality + brain
    const personalityName = randomPersonality();
    const personality = PERSONALITIES[personalityName];
    const brain = new BotBrain(
      carBody,
      ability,
      personality,
      () => this.carBodies.filter((cb) => cb !== carBody),
      { powerUpManager: this.powerUpManager, world: this.world },
    );

    this.bots.push({ carBody, ability, brain, personalityName });

    // Share brain references so bots can coordinate (anti-gangup on humans)
    this._syncBrainReferences();
  }

  /** Let each bot brain see all other brains for coordination (e.g. anti-gangup). */
  _syncBrainReferences() {
    const allBrains = this.bots.map(b => b.brain);
    for (const bot of this.bots) {
      bot.brain._otherBrains = allBrains;
    }
  }
}
