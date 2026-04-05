# 🚀 ROCKET BUMPERS — Game Design Document

## Concept
Arena vehicular combat. Pick your ride, crash into others for points. 8 unique cars with different stats and abilities. Pure chaos, zero skill floor, infinite skill ceiling. Think **Destruction Derby × Mario Kart Battle Mode × Rocket League** but simpler.

---

## Core Loop (30 seconds to understand)
1. Pick a car (each plays different)
2. Crash into other cars = points
3. Knock cars off the edge = bonus points
4. Grab power-ups + use your car's unique ability
5. Round ends after 90 seconds → scoreboard → new round

---

## Player Flow
```
LANDING → ENTER NICKNAME → CHOOSE CAR → PLAY → RESULTS → (CHOOSE CAR) → PLAY
```
- Nickname: input field, max 12 chars, default "PLAYER" + random 3 digits
- Car select: scroll through 8 cars, see 3D preview + stat bars + ability name
- After results: can change car or tap "PLAY AGAIN" to keep same car

---

## Tech Stack (ALL FREE — verified)

| Layer | Tech | License | Cost | Notes |
|-------|------|---------|------|-------|
| **Rendering** | Three.js (r175+) | MIT | Free | CDN import, no build step needed |
| **Physics** | cannon-es | MIT | Free | Best ThreeJS integration, easy for vibe coding |
| **Multiplayer** | PartyKit | MIT | Free tier | Built on Cloudflare edge, WebSocket rooms, zero config |
| **Audio** | Howler.js 2.x | MIT | Free | Web Audio API wrapper, sprites support |
| **Client hosting** | Vercel | — | Free tier | Static site, auto-deploy from GitHub, custom domain support |
| **Build** | Vite | MIT | Free | Fast dev server, ESM imports |

### Custom Domain
Both Vercel and PartyKit support custom domains on free tier:
- **Vercel**: Settings → Domains → add your domain, point DNS A/CNAME
- **PartyKit**: `npx partykit deploy --domain your-domain.com` or set in partykit.json

### Why NOT other options (verified):
- ~~Colyseus Cloud~~: **NO free tier** (framework is free but hosting starts at paid)
- ~~Fly.io~~: **NO free tier** since 2024 (only 2-hour trial for new accounts)
- ~~Railway~~: **NO permanent free plan** ($5/mo minimum for hobby)
- ~~Render free tier~~: WebSocket connections **cut after 5 min**, service sleeps after 15 min inactivity
- ~~Rapier.js~~: Better performance but WASM complexity, harder to vibe code with cannon-es's simpler API

---

## Architecture

```
rocket-bumpers/
├── client/                    # Vite + ThreeJS app
│   ├── public/
│   │   └── assets/
│   │       ├── models/        # Kenney Car Kit GLBs + Textures/colormap.png
│   │       ├── textures/      # Arena textures, skybox
│   │       ├── sounds/        # SFX (impacts, boost, pickup)
│   │       └── music/         # BGM loop
│   ├── src/
│   │   ├── main.js            # Entry point, init game
│   │   ├── core/
│   │   │   ├── Game.js        # Main game loop, state machine
│   │   │   ├── GameState.js   # Round state (LOBBY, COUNTDOWN, PLAYING, RESULTS)
│   │   │   ├── Config.js      # All tunables in one place
│   │   │   └── PowerUpManager.js  # Spawn, pickup, activate arena power-ups
│   │   ├── rendering/
│   │   │   ├── SceneManager.js    # ThreeJS scene, camera, renderer
│   │   │   ├── ArenaBuilder.js    # Build arena geometry
│   │   │   ├── AssetLoader.js      # GLTFLoader cache, model cloning
│   │   │   ├── CarFactory.js      # Loads Kenney GLB models, normalizes scale, wheel animation
│   │   │   ├── Effects.js         # Particles, trails, explosions
│   │   │   └── PostProcessing.js  # Bloom, screen shake
│   │   ├── physics/
│   │   │   ├── PhysicsWorld.js    # Cannon-es world setup
│   │   │   ├── CarBody.js         # Vehicle rigid body + controls (reads car stats)
│   │   │   ├── AbilitySystem.js   # Per-car unique ability logic
│   │   │   └── CollisionHandler.js # Detect impacts, calc damage/score
│   │   ├── network/
│   │   │   ├── NetworkManager.js  # PartyKit client connection
│   │   │   ├── MessageTypes.js    # Enum of all message types
│   │   │   └── Interpolation.js   # Lerp remote player positions
│   │   ├── ai/
│   │   │   ├── BotManager.js      # Spawn/despawn bots, fill slots, reset on round/respawn
│   │   │   ├── BotBrain.js        # State machine per bot, human-like imperfections, ground-ahead raycast
│   │   │   └── BotPersonalities.js # 4 personality presets with human-feel tuning params
│   │   ├── audio/
│   │   │   └── AudioManager.js    # Howler.js wrapper, SFX + music
│   │   ├── ui/
│   │   │   ├── HUD.js             # Timer, score, ability indicator
│   │   │   ├── Lobby.js           # Join screen (nickname input)
│   │   │   ├── CarSelect.js       # Car selection carousel
│   │   │   ├── Scoreboard.js      # End-of-round results
│   │   │   ├── NameTags.js        # Floating player names above cars (DOM overlay, 3D→2D projection)
│   │   │   └── MobileControls.js  # Touch joystick + buttons
│   │   └── utils/
│   │       ├── MathHelpers.js     # Clamp, lerp, random range
│   │       └── ObjectPool.js      # Reuse particles/projectiles
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── server/                    # PartyKit server
│   ├── src/
│   │   └── GameRoom.ts        # Room logic: state sync, round management
│   ├── partykit.json
│   └── package.json
├── GAME_DESIGN.md             # THIS FILE — source of truth
├── PROMPT_GUIDE.md            # Prompts for Claude Code
└── README.md
```

---

## Cars (8 models)

### Design Philosophy
- All cars use **Kenney Car Kit GLB models** with UV-mapped colormap texture, loaded via GLTFLoader
- Models are preloaded at startup (`preloadCarModels()`), async `buildCar()` clones from cache
- Each car: 3 visible stats + 1 unique ability
- Stat budget: always sums to **15 points** (no car is strictly better)
- Ability has a **cooldown** (shown as circular meter in HUD), not a resource
- Wheels are separate nodes in each GLB (`wheel-front-left`, etc.) — animated at runtime based on car speed

### Stat Mapping
| Stat points | Speed (max u/s) | Mass (kg) | Handling (rad/s) |
|-------------|----------------|-----------|-----------------|
| 2 | 20 | 3 | 2.0 |
| 3 | 24 | 4 | 2.5 |
| 4 | 28 | 5 | 3.0 |
| 5 | 32 | 6 | 3.5 |
| 6 | 36 | 7 | 4.0 |
| 7 | 40 | 8 | 4.5 |
| 8 | 44 | 9 | 5.0 |

### The 8 Cars

#### 1. FANG — Muscle Car
- **Speed 6 / Mass 5 / Handling 4**
- **Ability: NITRO** — Burst of speed (1.8× for 1.5s). Cooldown: 6s
- Model: `sedan-sports.glb` (Kenney Car Kit)
- *The all-rounder. Good first pick.*

#### 2. HORNET — Go-Kart
- **Speed 7 / Mass 2 / Handling 6**
- **Ability: DASH** — Instant short-range teleport forward (5 units). Cooldown: 4s
- Model: `kart-oopi.glb` (Kenney Car Kit)
- *Blazing fast, drifty, flies off on impact. High risk high reward.*

#### 3. RHINO — Armored Truck
- **Speed 3 / Mass 8 / Handling 4**
- **Ability: RAM** — 2s of infinite mass + slight speed boost. Cooldown: 8s
- Model: `truck.glb` (Kenney Car Kit)
- *Slow bulldozer. When RAM is active, nothing stops you.*

#### 4. VIPER — Formula Racer
- **Speed 8 / Mass 3 / Handling 4**
- **Ability: TRAIL** — 3s speed boost (1.5×) + leaves damaging fire trail behind. Cooldown: 7s
- Model: `race.glb` (Kenney Car Kit)
- *Fastest car. Pure glass cannon.*

#### 5. TOAD — Van
- **Speed 4 / Mass 6 / Handling 5**
- **Ability: PULSE** — Radial knockback (8 unit radius, strong force). Cooldown: 6s
- Model: `van.glb` (Kenney Car Kit)
- *Tanky and nimble. PULSE clears space around you.*

#### 6. LYNX — Hatchback
- **Speed 5 / Mass 4 / Handling 6**
- **Ability: DRIFT** — 2s of zero-friction turning + speed maintained through turns. Cooldown: 5s
- Model: `hatchback-sports.glb` (Kenney Car Kit)
- *The skill car. Master DRIFT to weave through chaos.*

#### 7. MAMMOTH — Tractor
- **Speed 4 / Mass 7 / Handling 4**
- **Ability: LEAP** — Jump up (impulse Y). On landing: radial shockwave (radius 6, force 200) pushes nearby cars. Track `isLeaping` flag; trigger shockwave on floor collision. Cooldown: 7s
- Model: `tractor.glb` (Kenney Car Kit)
- *Airborne chaos. LEAP over enemies, crush them on landing.*

#### 8. GHOST — Cyber Car
- **Speed 6 / Mass 3 / Handling 6**
- **Ability: PHASE** — 0.8s of intangibility (pass through cars only, arena floor still solid — uses cannon-es collision filter groups). Cooldown: 5s
- Model: `race-future.glb` (Kenney Car Kit)
- *Dodge anything. Time PHASE to avoid hits or pass through enemies.*

### Car Select UI
- Full screen overlay after nickname entry
- 3D car GLB model rotating slowly on a neon pedestal (async loading, preloaded at startup)
- 3 horizontal stat bars (Speed / Mass / Handling) with numeric labels
- Ability name + one-line description below the car
- Left/Right arrows or swipe (mobile) to browse
- "SELECT" button or Enter to confirm
- Each car shows its Kenney colormap texture

---

## Gameplay Details

### Arena (Volcano Flat)
- **Shape**: Octagonal platform (flat, 120 units diameter — 50% larger than original)
- **Edges**: No walls — you fall off and respawn (costs points)
- **Surface**: Flat volcanic rock with procedural texture (FBM noise) + normal map for depth
- **Central lava pool**: Radius 10, recessed at Y=-0.08. Procedural lava texture with animated UV offset (flowing effect). Cars in lava for 2s die (self-KO). Visual feedback: car emissive glows red proportionally to contact time
- **Boost pads**: 8 glowing strips at 55% radius, volcano yellow (0xffcc00)
- **Visual style**: Volcanic theme — warm amber/orange lighting, dark rock surface, lava glow, ash cloud skybox, ember particles, distant volcanic mountains, decorative rock pillars at arena edges
- **Theme**: `THEME` export in Config.js centralizes all volcano palette colors

#### Dynamic Hazards
Three hazard systems managed by `DynamicHazards.js`, all active during PLAYING state:

1. **Rotating rock arms** (2 arms, 180° apart)
   - Physical stone barriers that rotate slowly (0.3 rad/s) around the center
   - Length: 28 units, starting at radius 12 (past lava), height 2.5
   - Both physics bodies (CANNON.Box, updated every frame) and visual meshes (with rough detail rocks on top)
   - Cars collide with arms and get pushed/blocked — creates dynamic chokepoints

2. **Lava eruptions** (every ~20s)
   - 2s warning: lava pool emissive pulses with rising intensity (1.5→5.0) + sinusoidal wobble (4Hz), lava bubbles accelerate (×3). Procedural audio: sub-bass rumble 20→40Hz + filtered noise sweep 50→250Hz + accelerating LFO tremolo
   - Blast: radial shockwave pushes all cars outward (force 25, with distance falloff). Ease-out expanding ring VFX (1.0s). 30 lava surge particles (additive blending, gravity arc from pool). 8 debris chunks (InstancedMesh, DodecahedronGeometry, arcing outward with spin). Screen flash (orange additive, 0.25s). Procedural audio: 4-layer blast (sub thud 80→15Hz + wideband noise burst + 3s rumble tail + debris crackle pops)
   - Camera shake: intensity 0.012 (4× geyser), 400ms, always felt with distance falloff (100% within 30u, 15% minimum beyond 60u)
   - First eruption at half interval (~10s)

3. **Random geysers** (6 slots) — production visual system
   - Random positions on arena (avoids lava center and very edge)
   - Lifecycle: idle → warning (1.5s) → active (3s) → cooldown (5s) → idle
   - **Warning phase**: 5 radial ground cracks (merged into single mesh) grow outward with pulsing emissive. Warning ring pulses on ground. 10 steam particles (white/grey, additive blending) rise upward. Shared point light fades in (orange, from 2-light pool). Procedural audio: low rumble with frequency sweep + sub-bass + LFO tremolo
   - **Active phase**: 2-layer tapered eruption column (inner bright + outer ghost) with wobble animation. 20 lava fountain particles (gravity arc). 4 lava droplets (InstancedMesh spheres arcing outward). Splash ring expands at base (0.6s). Scorch mark appears (procedural Canvas2D texture with charred cracks + ember-glow veins + emissive map). Shared point light intensifies (red, flicker). Cars launched upward (force 15). Procedural audio: explosion burst + sustained hiss + random crackle pops. Camera shake if within 15 units of player (intensity 0.003, 150ms)
   - **Cooldown phase**: Column shrinks smoothly (not instant hide). Steam lingers 1.5s. Light fades. Scorch mark: emissive fades first, then opacity fades after 2s delay over 3s. Procedural audio: sizzle decay
   - Staggered initial spawns
   - **Performance**: 2 shared PointLights (pooled, assigned to highest-priority geysers). InstancedMesh for all droplets (1 draw call for all 24). Merged crack geometry (1 mesh per slot, not 5). Shared materials where possible. Idle geysers cost zero per-frame work

#### Car Visual Tilt
- Physics body stays upright (`fixedRotation: true`) — arcade driving model preserved
- Three.js mesh tilts visually based on ground surface normal via Raycaster
- `_updateVisualTilt()` on CarBody: casts ray downward, extracts face normal, builds quaternion from yaw + ground normal, slerps smoothly
- `arenaGroup` (THREE.Group of driveable surfaces) used as raycast target — set by Game.js each frame
- **Roll only** (lateral lean into turns) — pitch (forward/backward tilt on accel/brake) removed for more realistic feel
- Roll scales with steer input × speed × inverse mass. Heavy cars roll less

#### Procedural Textures (`ProceduralTextures.js`)
All textures generated via Canvas2D at startup — no external files:
- **Rock texture** (512px): Tileable FBM noise (torus-mapped coordinates for seamless wrapping), dark volcanic tones with cracks and warm undertone
- **Rock normal map** (512px): Height-to-normal conversion via finite differences, gives surface depth/bumps
- **Lava texture** (512px): No repeat (single fill), smooth gradient from bright yellow-orange (hot) → orange → dark red-brown (cooled crust)
- **Lava emissive map** (512px): Matches lava texture — only hot areas glow
- **Magma underlay** (256px): Dark with thin bright veins, visible below arena floor
- **Scorch texture** (256px): Radial burn mark with FBM noise for organic char pattern, ember-glowing crack edges, cubic radial falloff for soft edges. Used as decal under geyser eruptions
- **Scorch emissive map** (256px): Vein-based glow pattern matching scorch cracks — residual heat that fades before the texture itself

### Controls
| Action | Keyboard | Mobile |
|--------|----------|--------|
| Accelerate | W / ↑ | Left joystick Y+ |
| Brake/Reverse | S / ↓ | Left joystick Y- |
| Steer Left | A / ← | Left joystick X- |
| Steer Right | D / → | Left joystick X+ |
| Use Ability | Space | Ability button (big, right side) |
| Use Power-up | E / Shift | Power-up button (smaller, right side) |

### Mobile Controls Layout
```
┌─────────────────────────────────┐
│                                 │
│  [JOYSTICK]          [ABILITY]  │
│     ○                   ◉      │
│                       [PWRUP]  │
│                         ◎      │
└─────────────────────────────────┘
```
- Joystick: left half of screen, appears where thumb touches
- Ability button: large circle, bottom-right, shows cooldown as circular fill + ability icon
- Power-up button: smaller circle above ability, shows current power-up color, greyed if empty
- Auto-detected via `'ontouchstart' in window`
- All touch areas prevent default scroll/zoom
- Multitouch: joystick + button simultaneously

### Scoring
| Event | Points |
|-------|--------|
| Hit another car (>5 u/s relative velocity) | +10 |
| Big hit (>15 u/s) | +25 |
| Mega hit (>25 u/s) | +50 |
| Knock car off arena edge | +100 |
| Fall off edge yourself | -50 |
| Destroy with power-up | +30 |
| Ability KO (knock off using ability) | +75 |

### Collision & Damage Rules

#### KO Attribution (who gets credit?)
- Every car tracks `lastHitBy: { playerId, timestamp, wasAbility }`.
- On any collision or force-applying event (ability shockwave, TRAIL fire, PULSE, LEAP landing), update the victim's `lastHitBy`.
- When a car falls off (Y < -5): if `lastHitBy.timestamp` was within **3 seconds**, credit that player with KO (+100). If `lastHitBy.wasAbility` is true, give Ability KO (+75) instead of normal KO.
- If no `lastHitBy` within 3s → self-KO, victim gets -50, nobody gets +100.

#### Ability Damage Sources
These abilities apply force without a direct car-to-car collision. They must still update the victim's `lastHitBy`:
- **LEAP** landing shockwave → all cars in radius get `lastHitBy = MAMMOTH player, wasAbility = true`
- **PULSE** radial push → all cars in radius get `lastHitBy = TOAD player, wasAbility = true`
- **TRAIL** fire objects → car touching trail gets `lastHitBy = VIPER player, wasAbility = true`
- **RAM** collisions → normal collision but `wasAbility = true` (since RAM is active)
- **DASH** overlap → if HORNET teleports into another car, cannon-es separates them violently; this counts as a normal collision and scores normally

#### Global Max Velocity Cap
- **Max velocity: 70 u/s** regardless of any ability/power-up stacking.
- Applied every physics frame: `if (velocity.length() > 70) velocity.normalize().scale(70)`
- This prevents FANG NITRO (1.8×) + Rocket Boost power-up (2×) + boost pad from reaching absurd speeds.

#### Boost Pad Effect
- Instant impulse: adds **15 u/s** in the car's current forward direction.
- No cooldown per pad, but each pad has a **1s individual cooldown per car** (same car can't re-trigger the same pad for 1s).

#### Shield vs RAM Resolution
- **Shield** protects from knockback (no velocity change from collisions).
- **RAM** applies force with mass 999.
- When RAM hits Shield: Shield absorbs **50% of the force** instead of 100%. The shielded car gets pushed, but at half the normal knockback. RAM still gets full points for the hit.
- Hierarchy: RAM partially overrides Shield. No other ability overrides Shield.

#### Collision Filter Groups (cannon-es)
- **Group ARENA** (1): floor, ramps, walls → collides with everything
- **Group CAR** (2): all car bodies → collides with ARENA + CAR + PICKUP + TRAIL
- **Group PICKUP** (4): power-up pedestals → collides with CAR only
- **Group TRAIL** (8): VIPER trail fire objects → collides with CAR only
- **PHASE active**: temporarily set car's collision mask to ARENA only (removes CAR, PICKUP, TRAIL)
- **Invincible (respawn)**: same as PHASE — collide with ARENA only

### Power-ups (arena pickups — separate from car abilities)
Spawn on 6 fixed pedestals. Respawn 8s after pickup. Max 1 held at a time.

| Power-up | Color | Effect | Duration |
|----------|-------|--------|----------|
| **Rocket Boost** | Orange | 2× speed, fire trail damages others | 2s |
| **Shockwave** | Blue | Radial pushback (15 units radius) | Instant |
| **Shield** | Green | Immune to knockback, double mass | 4s |
| **Magnet** | Purple | Pull nearby cars (8 unit radius) then release | 3s |

### Round Structure
1. **LOBBY** (5-30s): Players join, pick car, bots fill to 8
2. **COUNTDOWN** (3s): "3… 2… 1… SMASH!" — cars locked on spawn points
3. **PLAYING** (90s): Active gameplay
4. **RESULTS** (8s): Scoreboard → "PLAY AGAIN" or "CHANGE CAR"
5. Loop back to COUNTDOWN

### Respawn
- Fall off edge (Y < -5) → controls disabled, camera follows falling car for 2s → teleport to random arena position (radius 8-18 from center)
- Velocity zeroed on respawn, car faces center
- 1.5s invincibility (car blinks at 8Hz, collision mask = ARENA only)
- Controls restored after invincibility ends
- Held power-up is **dropped** (lost) on fall — `PowerUpManager.drop(victim)` called immediately
- White screen flash on respawn (0.4s fade-out)
- No respawn during last 10s of round — car stays dead until round ends
- `_isDead` flag on Game prevents `applyControls()` during fall+respawn sequence

---

## Multiplayer Architecture

### PartyKit Room Logic
- Each room = 1 arena, max 8 players
- Server authoritative for: round state, scores, power-up spawns, join/leave
- Client authoritative for: own position/velocity (client-side prediction)
- Server validates: scoring events, power-up pickups (first-come)

### Network Messages (Client → Server)
```
PLAYER_JOIN     { nickname: string, carType: string }
PLAYER_STATE    { pos: [x,y,z], rot: [x,y,z,w], vel: [x,y,z], abilityActive: bool }  // 20 Hz
COLLISION       { targetId: string, relativeVelocity: number }
PICKUP_POWERUP  { powerupId: string }
USE_POWERUP     { type: string, pos: [x,y,z] }
USE_ABILITY     { type: string, pos: [x,y,z] }
PLAYER_FELL     { }
CHANGE_CAR      { carType: string }
```

### Network Messages (Server → Client)
```
ROOM_STATE      { players: [...], round: {...}, powerups: [...] }
PLAYER_JOINED   { id, nickname, carType, color }
PLAYER_LEFT     { id }
PLAYER_UPDATE   { id, pos, rot, vel, abilityActive }
ROUND_START     { countdown: number }
ROUND_END       { scores: [...] }
SCORE_UPDATE    { playerId, score, event }
POWERUP_SPAWNED { id, type, position }
POWERUP_TAKEN   { id, playerId }
POWERUP_USED    { playerId, type, pos }
ABILITY_USED    { playerId, type, pos }
PLAYER_RESPAWN  { playerId, pos }
```

---

## AI Bots
- Run **client-side** (no server compute)
- Each bot picks a random car type → gets those stats + uses that ability
- Names: "TURBO", "BLAZE", "NITRO", "CRASH", "FURY", "BOLT", "HAVOC", "STORM"
- State machine: ROAM → TARGET → CHARGE → EVADE (+ POWERUP_SEEK)
- 4 personalities: Aggressive, Defensive, Kamikaze, Hunter
- **Think rate**: decisions every ~200-350ms (not every frame) — input persists between ticks
- **Steering commitment**: holds turn direction for 120-220ms minimum (no frame-by-frame oscillation)
- **Throttle modulation**: coasts through turns, brakes before sharp direction changes (angleDiff > 0.7-1.0 rad)
- **Collision recovery**: detects velocity spikes from hits → 300-700ms stun, halves `_currentSpeed`
- **Ground-ahead raycast** (map-agnostic edge detection): 3 downward raycasts (ahead, left, right) with `collisionFilterMask: ARENA`. Ray origin relative to car Y (`carY + 2` → `carY - 3`). Probe distance scales with speed (`max(4, speed * 0.4)`). No ground → EVADE with brake-first-then-turn. Works for any arena shape
- **Lava avoidance**: ahead-probe checks if destination is within lava radius + margin → triggers EVADE
- **EVADE targeting**: steers toward ideal radius (midpoint between lava edge and arena edge) instead of absolute center (which is the lava pool)
- **Roam angle**: biases toward center when too close to outer edge, biases outward when too close to lava
- **Power-up awareness**: seeks nearby pedestals (weighted by personality), uses held power-ups contextually (BOOST in charge, SHIELD when threatened, SHOCKWAVE/MAGNET near enemies)
- **Ability usage**: contextual per ability type (NITRO/TRAIL when charging, RAM at close range, PULSE when surrounded, DASH to close distance, PHASE when enemy incoming, DRIFT in turns, LEAP on enemies)
- **Human-feel imperfections**: occasional wrong turns (0.2-0.5% per tick), brief coasting (2-10%), wider steering deadzone (0.15 rad)

### Personalities (tuning params per type)
| Param | Aggressive | Defensive | Kamikaze | Hunter |
|-------|-----------|-----------|----------|--------|
| targetRange | 30 | 18 | 40 | 35 |
| chargeSpeed | 1.0 | 0.7 | 1.3 | 0.9 |
| evadeThreshold | 0.25 | 0.45 | 0.1 | 0.3 |
| powerupWeight | 0.3 | 0.7 | 0.1 | 0.5 |
| abilityEagerness | 0.85 | 0.5 | 1.0 | 0.75 |
| roamTime | 1.0s | 2.0s | 0.5s | 1.2s |
| reactionDelay | 0.12s | 0.2s | 0.08s | 0.15s |
| mistakeChance | 0.003 | 0.004 | 0.005 | 0.002 |

---

## Visual Effects

### P0 (must-have)
- Rocket flame particles (scale with speed)
- Collision sparks (burst at impact point)
- Ability activation VFX (per-ability)
- Screen shake on big hits
- Car emissive glow
- Edge glow (neon arena perimeter)
- Ability cooldown circle in HUD

### P1 (nice-to-have)
- Boost trail on ground, slow-mo on last KO, score popups, bloom

---

## Audio
- SFX: engine hum, ability sounds (unique per type), collision tiers, pickup, countdown, fanfare
- Music: 1 electronic loop, intensity increase last 30s
- Placeholder: Web Audio API synth, replace with real files later

---

## Hosting & Deploy

### Client → Vercel
```bash
cd client && npx vercel
```
Custom domain: Vercel Dashboard → Domains → point DNS

### Server → PartyKit
```bash
cd server && npx partykit deploy
```
Custom domain: add `"domain"` in partykit.json

### Recommended
- `yourdomain.com` → Vercel (game)
- `play.yourdomain.com` → PartyKit (multiplayer)

---

## Implementation Status

### ✅ DONE — Foundation
- [x] **Project setup**: Vite + vanilla JS, package.json (three, cannon-es, howler, vite), index.html fullscreen canvas
- [x] **Config.js**: All constants from this doc — 8 cars with stats/abilities, stat mapping, arena, scoring, round timing, collision groups, power-ups, respawn, physics caps
- [x] **SceneManager.js**: THREE.WebGLRenderer (antialias, PCFSoft shadows, ACES tone mapping), PerspectiveCamera, FogExp2 (dark warm fog 0x0d0805, density 0.004), resize handling, render loop
- [x] **ArenaBuilder.js**: Volcano-themed flat arena. Octagonal platform (120u diameter) with ExtrudeGeometry + center hole for lava pool. Procedural rock texture + normal map on floor. Lava pool with procedural texture + animated UV offset + emissive map + bubbles. Warm orange edge tubes (TubeGeometry per segment). 8 pulsing yellow boost pads. Volcanic skybox (sky dome, 22 ash clouds, 500 ember particles drifting upward, 5 distant cone mountains with lava tips). Lighting: warm ambient (0x443322), directional sun (0xffd4a0) with shadow map 2048, cool fill light from opposite side (0x6688aa), hemisphere fill. 2 rotating rock arm meshes (synced with physics). 6 geyser visual slots (ground markers + eruption columns). Eruption shockwave ring VFX. 6 decorative rock pillars at arena edge. Magma underlay texture below floor. Animated: boost pad pulse, edge light pulse, lava pulse + UV scroll, magma vein glow, ember particle drift, rock arm rotation
- [x] **ProceduralTextures.js**: Canvas2D-generated textures — rock texture (512px tileable FBM), rock normal map (512px), lava texture (512px seamless), lava emissive map (512px), magma underlay (256px). All tileable via torus-mapped noise coordinates
- [x] **CarFactory.js**: `buildCar(carType, playerColor)` — all 8 cars procedural (Box/Cylinder/Cone/Extrude), 4 wheels + rear rocket with nozzle glow. Body material has configurable color + emissive glow (0.15). Inner group normalization to ~2×1.2×1.2 bounding box with bottom at Y=0. `getCarPreviewScene(carType, playerColor)` for car select screen (dedicated scene with pedestal, ring, 3-point lighting, slow rotation)

### ✅ DONE — Physics & Driving
- [x] **PhysicsWorld.js**: cannon-es World (gravity -9.82), SAPBroadphase, `allowSleep=false`. Octagonal ConvexPolyhedron floor (120u diameter, 8 vertices top + 8 bottom). Central lava floor (16-sided ConvexPolyhedron, radius 10, recessed at Y=-0.6, tagged `_isLava`). 2 rotating rock arm physics bodies (CANNON.Box, mass 0, collision group ARENA → CAR only). `updateRockArms(elapsed)` repositions arm bodies each frame. Default contact material: friction 0.05, restitution 0.3. **Car-Arena ContactMaterial**: restitution 0.0. Fixed timestep 1/120s, max 5 sub-steps
- [x] **CarBody.js**: `CarBody(carType, mesh, world, opts?)` — reads STAT_MAP for maxSpeed/mass/handling. CANNON.Box half-extents (1.0, 0.6, 0.6). `fixedRotation=true` (rotation managed manually via `_yaw`). **Rear-axle bicycle model**: `applyControls(input, dt)` computes `angularVel = speed × tan(steerAngle) / wheelbase`, capped at `maxAngularVel` (3.2 rad/s). Car pivots around rear axle (`rearAxleOffset: 0.5u`) — front sweeps through turns like a real car. **No turning at zero speed** (`minTurnSpeed: 1.0 u/s`). Steering angle smoothly interpolated (`_steerAngle`), self-centers when released. Handling stat scales max steer angle via `handlingFactor = handling / 3.5`. High-speed steering reduction (`highSpeedSteerFactor: 0.5`). **Braking model**: forward+backward = brake; from standstill, backward = reverse (separate `reverseAccel`, capped at 35% of max speed). **Drift mode**: 1.5× wider steer angle + slow velocity blend (2.5 Hz) = tail slides out. **Lateral grip** (0.95) snaps velocity to facing direction — car feels planted. Global 70 u/s cap enforced. **Visual tilt system**: `_updateVisualTilt()` raycasts downward to find ground normal, builds quaternion from yaw + normal, slerps smoothly. Visual roll on turns (0.06 rad max, ~3.4°) + pitch on accel/brake. `syncMesh()` uses visual quaternion (with tilt) instead of physics quaternion. **Properties**: `playerId`, `nickname`, `score`, `lastHitBy` (KO attribution), `hasShield`, `hasRam`, `isInvincible`, `speedMultiplier`, `driftMode`, `_originalMass`, `_arenaGroup` (set by Game.js for tilt raycasting). **`_isFalling`** flag prevents duplicate fall handling. **`_generation`** counter increments on death/respawn. **`resetState()`** hard-resets mass/speed/flags/steerAngle

### ✅ DONE — UI Flow
- [x] **Lobby.js** (`src/ui/Lobby.js`): Fullscreen overlay, neon "ROCKET BUMPERS" title, nickname input (max 12 chars, auto-generated placeholder), PLAY button / Enter to submit
- [x] **CarSelect.js** (`src/ui/CarSelect.js`): Fullscreen carousel after nickname. Dedicated THREE.WebGLRenderer on canvas, uses `getCarPreviewScene()` for 3D rotating car on neon pedestal. Car name + subtitle with per-car color glow. 3 animated stat bars (SPEED red, MASS blue, HANDLING green) with `N/8` labels. Ability name + description + cooldown. Left/Right arrows (click) + keyboard (A/D/arrows) + mobile swipe. Counter `3/8`. SELECT button / Enter. Fade transition 200ms. Full cleanup on confirm (disposes renderer, removes listeners)
- [x] **Flow**: Lobby → CarSelect → Game (wired in main.js)

### ✅ DONE — Ability System
- [x] **AbilitySystem.js** (`src/physics/AbilitySystem.js`): One instance per player/bot. State machine: `ready → active → cooldown → ready`. All 8 abilities implemented:
  - **NITRO** (FANG): `speedMultiplier = 1.8` for 1.5s, boosted emissive glow. CD 6s
  - **DASH** (HORNET): Teleport 5 units forward, ghost trail clone fades 0.5s. Instant → CD 4s
  - **RAM** (RHINO): `body.mass = 999`, `speedMultiplier = 1.2`, sets `hasRam = true`, red glow VFX. 2s duration, CD 8s
  - **TRAIL** (VIPER): `speedMultiplier = 1.5`, spawns fire boxes every 0.3s (CANNON trigger bodies, TRAIL collision group, `_isTrailFire` tag, `_ownerId` for attribution). Trail persists 2s with fade + flicker. 3s duration, CD 7s
  - **PULSE** (TOAD): Radial knockback (radius 8, force 300) with distance falloff + upward pop. Sets `lastHitBy` (wasAbility). Expanding purple ring VFX. Instant → CD 6s
  - **DRIFT** (LYNX): Sets `carBody.driftMode = true` (1.5× wider steer angle + slow velocity blend at 2.5 Hz = tail slides out). 2s duration, CD 5s
  - **LEAP** (MAMMOTH): `velocity.y = 12`, tracks `isLeaping`. Landing detection via downward CANNON raycast (distance < 1.2, collisionFilterMask: ARENA) — works at any height. Shockwave on landing (radius 6, force 200, sets `lastHitBy`). Orange ring VFX. Instant → CD 7s
  - **PHASE** (GHOST): `collisionFilterMask = ARENA only`. Semi-transparent + cyan emissive VFX. 0.8s duration, CD 5s
  - **Static helper**: `AbilitySystem.setInvincible(carBody, bool)` — same PHASE collision mask logic for respawn invincibility
  - **`forceReset()`**: Resets ability to `ready` state without running deactivation logic (CarBody.resetState already cleaned up). Clears all timers, VFX, leap state. Called on respawn and round reset

### ✅ DONE — Collision & Round System
- [x] **CollisionHandler.js** (`src/physics/CollisionHandler.js`): Listens to cannon-es `body.collide` events on car bodies, deduplicates pairs per frame. Relative velocity scoring: >5 → +10, >15 → +25, >25 → +50. Attacker = higher speed car. Updates `victim.lastHitBy = { source, wasAbility, time }` (RAM sets `wasAbility = true`). **Fall detection**: checks `Y < -5` every frame, **guarded by `_isFalling` flag** (prevents duplicate processing — critical fix, without this ~120 setTimeout chains are spawned per fall). If `lastHitBy` within 3s → KO +100 (or Ability KO +75 if `wasAbility`); else self-KO -50. **Shield vs RAM**: pure shield → zero knockback (restores velocity post-contact); RAM vs shield → 50% knockback (SHIELD_VS_RAM.forceAbsorption). **Trail fire**: proximity scan (<1.2 units) on `_isTrailFire` bodies, knockback + `lastHitBy` attribution. **Velocity cap**: `postStep` listener clamps all cars to 70 u/s. Events emitted: `hit`, `ko`, `self-ko`, `fell`, `trail-hit`
- [x] **GameState.js** (`src/core/GameState.js`): State machine `LOBBY → COUNTDOWN (3s) → PLAYING (90s) → RESULTS (8s) → COUNTDOWN → …`. Events: `stateChange { from, to }`, `countdownTick { seconds }` (3, 2, 1, 0=SMASH!), `roundTimeUpdate { remaining }`. `startRound()` triggers LOBBY → COUNTDOWN. Getters: `isPlaying`, `isCountdown`, `remainingTime`
- [x] **Game.js** (`src/core/Game.js`): Main orchestrator. Owns SceneManager, PhysicsWorld, CollisionHandler, GameState, **PowerUpManager**, **BotManager**, **NameTags**, **DynamicHazards**. `setPlayer(nickname, carType)` spawns car + AbilitySystem at random arena position (avoids lava center: radius range `lavaR+5` to `arenaR-10`), then `botManager.fillSlots()` adds 7 bots + registers name tags. `start()` begins rAF loop. **Delta cap** 1/30. Loop order: gameState.update → applyControls → **botManager.update** → abilities.update → physics.step → **floor safety net** → **visual tilt update** → syncMesh → **dynamicHazards.update** → **physicsWorld.updateRockArms** → collisionHandler.update → **powerUpManager.update** → **dynamic camera** → **nameTags.update** → render. During COUNTDOWN: tilt + sync only. **Respawn**: 2s delay → reposition (avoids lava) → 1.5s invincibility blink. **Round management**: resets scores, power-ups, **dynamicHazards**. **Overlay HUD**: volcano-themed countdown (orange glow). **Input**: WASD/arrows for driving, Space for ability, **E/Shift for power-up**
- [x] **main.js**: Thin shell — creates `Game`, wires Lobby → CarSelect → `game.setPlayer()` + `game.start()`. HUD: player info (top-left), live score with tier-colored flash (white/yellow/orange/cyan/magenta), ability cooldown SVG ring (bottom-right, green=ready/yellow=active/grey=cooldown), **power-up HUD slot** (top-right, Mario Kart style: 64×64 box with colored border/glow, emoji icon per type 🚀💥🛡️🧲, pop animation on pickup, white flash on use, `[E] LABEL` text), results overlay (sorted scoreboard). Wires `powerUpManager.on('pickup')` and `powerUpManager.on('used')` events to update the power-up HUD

### ✅ DONE — Power-Up System
- [x] **PowerUpManager.js** (`src/core/PowerUpManager.js`): 6 fixed pedestal positions (35% arena radius, evenly spaced + π/6 offset). Each pedestal: CylinderGeometry base + TorusGeometry glow ring + PointLight. **Pickup meshes**: OctahedronGeometry core (emissive, per-type color) + outer TorusGeometry glow ring, spinning (2 rad/s) + floating (sine wave). Proximity pickup (radius 2.0 units), max 1 held per car via `Map<CarBody, string>`. Respawn 8s after pickup (performance.now timer). **4 effects implemented**:
  - **ROCKET_BOOST**: `speedMultiplier *= 2` for 2s + glowing sphere VFX following car. **Generation-guarded** setTimeout
  - **SHOCKWAVE**: Instant radial pushback (15u radius, force 40 × distance falloff, +3 Y pop), expanding ring VFX (600ms), +30 score per target hit, sets `lastHitBy`
  - **SHIELD**: `hasShield = true` + `mass × 2` (updateMassProperties) for 4s + green glow VFX. Integrates with CollisionHandler's shield/RAM resolution. **Generation-guarded** setTimeout
  - **MAGNET**: rAF pull loop for 3s (12 force, 8u radius), pulls cars toward user, sets `lastHitBy` per frame + purple glow VFX. **Generation-guarded** rAF loop
- **Generation guard**: All timed effects capture `car._generation` at activation. setTimeout/rAF callbacks bail out if `car._generation` has changed (car died/respawned). Prevents stale timeouts from corrupting mass/speedMultiplier (critical — without this, multiply/divide pairs desync on death, mass halves exponentially over multiple deaths)
- **VFX**: `_spawnUseFX(car, color, duration)` — BackSide SphereGeometry (emissive, transparent) follows car, fades opacity + emissive over duration, pulsing scale. `_spawnShockwaveFX(car, config)` — expanding RingGeometry on ground, fades over 600ms. All VFX self-dispose (remove mesh, dispose geo+mat)
- Events emitted: `pickup { car, type, pedestalIndex }`, `used { car, type }`, `powerup-hit { attacker, victim, type }`
- `reset()` clears all held power-ups + respawns all pedestals (called on new round)

### ✅ DONE — AI Bots & Name Tags
- [x] **BotManager.js** (`src/ai/BotManager.js`): Spawns bots to fill empty slots up to `PLAYERS.maxPerRoom` (8). Each bot gets a random car type + shuffled name from `BOTS.names` + random personality. `fillSlots()` creates CarBody + AbilitySystem + BotBrain per bot, pushes to shared `carBodies[]` and `abilities` Map. `update(dt)` ticks all bot brains and calls `applyControls(input, dt)` — skips dead/invisible bots. `resetBrain(carBody)` calls `brain.reset()` after respawn. `resetForNewRound()` repositions all bots and calls `resetState()` + `brain.reset()`. `isBot(carBody)` checks ownership. `removeAll()` cleans up everything (scene, world, abilities, array references)
- [x] **BotBrain.js** (`src/ai/BotBrain.js`): State machine with human-like imperfections. **Think rate**: decisions every 200-350ms via `_thinkTimer` (input persists between ticks). **States**: ROAM (pick random angle biased toward safe zone between lava and edge), TARGET (steer toward nearest enemy, brake into sharp turns), CHARGE (full throttle when aligned, ability usage), EVADE (brake-first-then-turn toward ideal radius, NOT toward center which is lava), POWERUP_SEEK (drive to nearest active pedestal). **Lava avoidance**: ahead-probe detects proximity to lava pool → triggers EVADE. EVADE steers toward midpoint between lava edge and arena edge. Roam biases outward when too close to lava. **Ground-ahead raycast**: `_senseGround()` casts 3 rays (ahead/left/right) downward relative to car Y (`carY+2` → `carY-3`). Probe distance = `max(4, speed * 0.4)`. **Map-agnostic** — works for any arena shape. `reset()` clears all state for respawn
- [x] **BotPersonalities.js** (`src/ai/BotPersonalities.js`): 4 presets (Aggressive, Defensive, Kamikaze, Hunter) with tuning params: `targetRange`, `chargeSpeed`, `evadeThreshold`, `powerupWeight`, `abilityEagerness`, `roamTime`, `reactionDelay`, `steerNoise`, `throttleRelease`, `mistakeChance`, `retargetChance`, `coastChance`. `randomPersonality()` picks one at random
- [x] **NameTags.js** (`src/ui/NameTags.js`): Floating labels above each car. DOM overlay container (`#name-tags`, z-index 5). `add(carBody, isLocal)` creates a `.name-tag` div (Courier New 12px bold, text-shadow). Local player is cyan (`.is-local`). `update(camera, screenW, screenH)` projects `carBody.body.position + Y offset 2.2` to screen coordinates via `THREE.Vector3.project(camera)`. Hides when behind camera or car invisible/fallen. `clear()` removes all tags. Called every frame after camera update

### ✅ DONE — HUD & Mobile Controls
- [x] **HUD.js** (`src/ui/HUD.js`): Full DOM overlay (z-index 10, pointer-events none). **Timer** (top-center): MM:SS, red <10s, CSS `@keyframes hud-pulse` <5s. **Score** (top-left): player label + score number, green flash with scale(1.15) on increase. **Ability indicator** (bottom-center-right): 72px circle with SVG cooldown ring (stroke-dashoffset clockwise fill), first letter of ability name centered, glow box-shadow when ready (green), yellow when active, grey on cooldown. Ability name label below. **Power-up slot** (above ability): 44px square with colored border, icon text, grey when empty. **Kill feed** (top-right): entries fade in, auto-remove after 3s with opacity transition. All elements use CSS transitions. `dispose()` cleans up.
- [x] **MobileControls.js** (`src/ui/MobileControls.js`): Auto-detected via `'ontouchstart' in window`, hidden on desktop via `@media (pointer:fine)`. **Virtual joystick**: left-half touch zone, circle appears at touch origin (60px radius, semitransparent + cyan neon border), thumb follows finger (24px radius, clamped to circle). X = steer (-1..1), Y = accel/brake (-1..1 inverted). 0.2 deadzone. Uses touch identifier tracking for multitouch. **Ability button** (72px, bottom-right): SVG cooldown ring overlay, green/yellow/grey states with glow. **Power-up button** (48px, above ability): border color matches held power-up. All touch events `preventDefault` (no scroll/zoom). `touch-action: none` on all elements. Callbacks: `onInput({ forward, backward, left, right })`, `onAbility()`, `onPowerUp()`.
- **Note**: HUD.js and MobileControls.js are created but **not yet wired into main.js** as the primary HUD. main.js currently uses inline DOM elements for the HUD. HUD.js is ready to replace the inline HUD when needed.

### Car Geometry Summary (for reference)
| Car | Key shapes | Distinguishing features |
|-----|-----------|------------------------|
| FANG | Long flat body + raised rear + cabin | Wide stance wheels (0.9 hw), windshield |
| HORNET | Tiny chassis + nose cone | Exposed steering wheel + column, no roof |
| RHINO | Tall double-box + armored top | 3 bumper guard bars, slit windshield, thick wheels (r=0.4) |
| VIPER | Narrow body + nose cone | Wide front wing with endplates, rear fin + wing on supports, bubble cockpit |
| TOAD | Tall box + half-cylinder roof | Round headlights (emissive spheres), chunky |
| LYNX | Sleek low body + side panels | No roof (visible interior), door line accents, spoiler on cylindrical mounts |
| MAMMOTH | Raised chassis + cab + bed | Roll cage (4 vertical + 2 horizontal bars), suspension struts, huge wheels (r=0.5) |
| GHOST | Faceted extrude body + custom nose wedge | Cyan emissive vent strips, floating wheels on struts with torus glow rings |

### 🔲 TODO — P0 (Must ship)
- [x] Car selection screen UI (carousel + stat bars + ability info)
- [x] Ability system (all 8 abilities)
- [x] Collision scoring + KO attribution + round loop (LOBBY→COUNTDOWN→PLAYING→RESULTS)
- [x] HUD (timer, score, ability cooldown circle)
- [x] Respawn system (death cam → teleport → invincibility blink → power-up drop, no respawn last 10s, flash VFX)
- [x] AI bots (7 bots fill empty slots, random car types, state machine, 4 personalities, human-like behavior, ground-ahead raycast edge detection)
- [x] Name tags (floating labels above each car, 3D→2D projected DOM overlays, cyan for local player)
- [ ] Mobile controls (virtual joystick + ability/power-up buttons)
- [x] Particles (geyser steam/fountain/droplets, eruption surge/debris) + screen shake (geyser + eruption)
- [ ] Deploy on Vercel

### 🔲 TODO — P1 (Should ship)
- [x] Power-ups (4 types, pedestal spawn/pickup, respawn timer, drop on fall)
- [ ] Multiplayer (PartyKit server + client networking + interpolation)
- [x] Sound effects — procedural Web Audio API for geysers (rumble, eruption blast, hiss, sizzle) and central eruption (warning rumble, 4-layer explosion, debris crackle). Distance-attenuated spatialization
- [ ] Music + remaining SFX (car engines, collisions, abilities, power-ups)
- [ ] Boost pad physics (impulse on contact, 1s per-car cooldown)

### ✅ DONE — Volcano Arena & Dynamic Hazards
- [x] **Volcano theme**: Arena resized to 120u diameter. Warm volcanic color palette (THEME export). Procedural rock texture + normal map on floor. Lava pool center with procedural texture + animated UV offset. Volcanic skybox (ash clouds, ember particles, distant mountains). Warm lighting with cool fill for contrast. Decorative rock pillars. Magma underlay below floor
- [x] **ProceduralTextures.js**: Canvas2D texture generation — tileable rock, rock normals, lava, lava emissive, magma underlay. All use torus-mapped FBM noise for seamless tiling
- [x] **DynamicHazards.js**: 3 hazard systems — central lava pool (2s kill timer with visual feedback), lava eruptions (radial shockwave every ~20s with 2s warning), random geysers (6 slots, warning → active → cooldown lifecycle, launch cars upward)
- [x] **Rotating rock arms**: 2 physical stone barriers rotating at 0.3 rad/s around center. Physics bodies + visual meshes synced each frame
- [x] **Car visual tilt**: Mesh tilts on terrain slope via raycasting ground normal. Physics body stays upright (fixedRotation: true). Smooth slerp interpolation. Roll only (no pitch)
- [x] **Bot lava/hazard avoidance**: EVADE targets ideal radius (not center), lava ahead detection, roam angle biases away from lava

### ✅ DONE — Geyser & Eruption FX + Audio
- [x] **GeyserFX.js**: Optimized particle system for all 6 geysers — steam point clouds (10/geyser), lava fountain particles (20/geyser, gravity arc), single InstancedMesh for all 24 lava droplets (1 draw call), single shared splash ring. BufferGeometry.needsUpdate only when particles move. Idle geysers = zero per-frame cost
- [x] **GeyserAudio.js**: Procedural Web Audio API — warning rumble (filtered noise + sub-bass + LFO), eruption blast (noise burst + thud + sustained hiss + crackle), cooldown sizzle. Distance-attenuated spatialization from player position. Also handles central eruption audio (warning rumble with accelerating tremolo, 4-layer explosion)
- [x] **Geyser visuals in ArenaBuilder**: Multi-layer eruption columns (2 concentric cylinders with wobble), merged radial crack geometry (1 mesh per slot), warning ring, procedural scorch texture with emissive map (fades after eruption), 2 shared PointLights pooled across all 6 geysers (assigned by priority)
- [x] **Central eruption FX**: Pulsing lava warning (emissive ramp + accelerated bubbles), 30 surge particles (additive, gravity arc from pool), 8 debris chunks (InstancedMesh), ease-out shockwave ring, screen flash (camera-attached plane, additive blend), camera shake (4× geyser intensity, always felt)
- [x] **Camera shake system**: Game.js manages shake with intensity + duration + decay. Geyser shake: distance-gated (15u max), 0.003 intensity, 150ms. Eruption shake: 0.012 intensity, 400ms, falloff from 30u to 60u with 15% minimum
- [x] **Performance optimizations**: 6 PointLights → 2 shared pool. 36 droplet meshes → 1 InstancedMesh. 30 crack meshes → 6 merged. 3 column layers → 2. Particle counts reduced (steam 18→10, fountain 35→20). Material clones minimized. Early-skip for idle geysers

### 🔲 TODO — P2 (Nice to have)
- [x] Bot personalities (Aggressive, Defensive, Kamikaze, Hunter) — included in AI bots implementation
- [ ] Slow-mo on last KO, score popups, bloom post-processing

### 🔲 TODO — P3 (Cherry on top)
- [ ] Kill cam, spectator mode, car skins, additional arena themes

---

## Agent Handoff — Current State

### What exists (files to READ before working)
```
client/
├── src/
│   ├── main.js                    # Entry point — thin shell, wires UI flow + HUD + Game
│   ├── core/
│   │   ├── Config.js              # ALL game constants — ARENA, THEME, cars, scoring, etc.
│   │   ├── Game.js                # Main orchestrator — owns all subsystems, rAF loop
│   │   ├── GameState.js           # Round state machine (LOBBY→COUNTDOWN→PLAYING→RESULTS)
│   │   └── PowerUpManager.js      # Spawn, pickup, activate arena power-ups (generation-guarded)
│   ├── physics/
│   │   ├── PhysicsWorld.js        # cannon-es world, octagonal floor, lava body, rotating rock arms
│   │   ├── CarBody.js             # Car rigid body, driving, visual tilt system, mesh sync
│   │   ├── AbilitySystem.js       # All 8 abilities with cooldowns, VFX, collision filter switching
│   │   ├── CollisionHandler.js    # Collision scoring, KO attribution, fall detection, shield/RAM
│   │   └── DynamicHazards.js      # Lava pool damage, eruptions, geysers — all dynamic arena hazards
│   ├── rendering/
│   │   ├── SceneManager.js        # Owns renderer + camera + arena, call .update() in loop
│   │   ├── ArenaBuilder.js        # Volcano arena — floor, lava, rock arms, geysers, eruption FX, skybox, lighting
│   │   ├── GeyserFX.js            # Optimized particle system for geysers (steam, fountain, droplets, splash)
│   │   ├── CarFactory.js          # buildCar() + getCarPreviewScene()
│   │   └── ProceduralTextures.js  # Canvas2D texture generation (rock, lava, normals, magma, scorch)
│   ├── audio/
│   │   └── GeyserAudio.js         # Procedural Web Audio API for geysers + eruption (no external files)
│   ├── ai/
│   │   ├── BotManager.js          # Spawn/despawn bots, fill to 8 players, reset on round/respawn
│   │   ├── BotBrain.js            # State machine, lava/edge avoidance, human-like imperfections
│   │   └── BotPersonalities.js    # 4 personality presets with tuning params
│   └── ui/
│       ├── HUD.js                 # Timer, score, ability indicator, kill feed, power-up slot
│       ├── NameTags.js            # Floating player names above cars (DOM overlay, 3D→2D projection)
│       ├── Lobby.js               # Nickname input overlay
│       ├── CarSelect.js           # Car selection carousel with 3D preview
│       └── MobileControls.js      # Touch joystick + buttons (created, not wired)
├── index.html
├── package.json                   # three, cannon-es, howler, vite
└── vite.config.js                 # dev on port 3000
```

### Architecture decisions already made
- **Vanilla JS + ES6 classes** — no React, no framework
- **Config.js is the single source of truth** — all stats, dimensions, timing come from there
- **Game.js is the orchestrator** — owns SceneManager, PhysicsWorld, CollisionHandler, GameState. main.js is a thin shell that creates Game and wires UI
- **Car normalization**: all cars wrapped in inner group scaled to fit 2×1.2×1.2, bottom at Y=0. Position the outer group freely
- **Arena platform top surface at Y=0** — cars sit at position.y=0.6. Physics floor is a finite `CANNON.ConvexPolyhedron` (octagonal prism, 120u diameter, 1-unit thick). Central lava floor (16-sided, radius 10, recessed at Y=-0.6). Cars CAN fall off the outer edge
- **Rotating rock arms**: 2 `CANNON.Box` bodies (mass 0) repositioned every frame via `updateRockArms(elapsed)`. Visual meshes synced in ArenaBuilder.update()
- **DynamicHazards**: manages lava damage (2s kill timer), eruptions (radial force every ~20s with full FX + audio), geysers (6 random-position slots with warning→active→cooldown lifecycle, particles, audio, scorch marks). Owns GeyserAudio instance. Emits `kill`, `geyserErupt`, `eruptionBlast` events. Integrated in Game.js loop during PLAYING
- **Procedural textures**: all arena textures generated via Canvas2D + `THREE.CanvasTexture`. No external image files. Tileable via torus-mapped noise coordinates
- **Car visual tilt**: `fixedRotation: true` preserved. Mesh rotation decoupled from physics — `_updateVisualTilt()` raycasts onto `arenaGroup` (THREE.Group of driveable surfaces), builds quaternion from ground normal + yaw, slerps smoothly. Roll only (lateral lean into turns, no pitch/forward tilt). Physics body stays upright for stable arcade driving
- **Dynamic camera system**: Third-person camera in Game.js with speed and steering-reactive effects. FOV widens from 60° to 72° at top speed (sensation of speed). Lateral offset shifts camera to outside of turns (1.8u max). Slight roll tilt into turns (~1.4° via quaternion premultiply, not Euler — avoids gimbal lock). Follow distance pulls back 3u at top speed. Camera initializes at correct position behind car on spawn (no first-frame jump). All smoothing values in `CAR_FEEL.camera` config
- **Edge tubes**: one LineCurve3 per octagon side (not CatmullRom spline) for sharp corners
- **getCarPreviewScene()** returns `{ scene, camera, car, update(dt) }` — rendered by CarSelect.js on a dedicated canvas+renderer
- **Rear-axle bicycle model driving** — `angularVel = speed × tan(steerAngle) / wheelbase` with rear-axle pivot. No turning at zero speed. Max angular velocity capped at 3.2 rad/s. Direct velocity control (not forces) — CarBody sets `body.velocity.x/z` from `_currentSpeed × forward direction`, Y left to physics (gravity, ramps). `fixedRotation: true`, rotation manual via `_yaw`. Handling stat scales max steer angle. High-speed steer reduction. Lateral grip (0.95) snaps velocity to facing. CAR_FEEL config in Config.js holds all tuning parameters
- **Arrow keys have `preventDefault()`** — stops page/iframe scroll in both keydown and keyup handlers
- **Ability modifiers on CarBody** — `speedMultiplier` (NITRO/TRAIL), `driftMode` (DRIFT: 1.5× steer angle + loose grip), `hasRam` (RAM), `hasShield` (Shield powerup), `isInvincible` (respawn). AbilitySystem sets these; CarBody reads them in `applyControls()`
- **KO attribution via `lastHitBy`** — every CarBody has `lastHitBy: { source: CarBody, wasAbility: bool, time: number }`. Set by CollisionHandler (car-car hits) and AbilitySystem (PULSE, LEAP, TRAIL). Checked by CollisionHandler on fall detection
- **Event system** — Game, GameState, CollisionHandler all use a lightweight `on(event, fn)` / `_emit(event, data)` pattern. No external dependency
- **Delta cap** — Game.js caps dt at 1/30 to avoid physics spiral of death
- **Generation guard pattern** — CarBody has `_generation` counter that increments on `resetState()`. All timed effects (setTimeout/rAF in PowerUpManager) capture generation at activation and bail if it changed. Prevents stale callbacks from corrupting mass/speedMultiplier after death
- **`_isFalling` guard** — CarBody flag set by CollisionHandler on fall detection, cleared by `resetState()`. Prevents the same fall from being processed ~120 times (once per frame while Y < fallOffY during the 2s respawn delay)
- **`resetState()` + `forceReset()` on all transitions** — Called on every respawn and round reset. `resetState()` (CarBody) hard-resets mass, speedMultiplier, flags, increments generation. `forceReset()` (AbilitySystem) returns ability to ready without running deactivation. Together they ensure clean state regardless of what was active when the car died
- **Bot architecture** — Bots are first-class CarBody citizens. BotManager holds refs to shared `carBodies[]` and `abilities` Map. BotBrain produces the same `{ forward, backward, left, right }` input object as keyboard input, fed into `applyControls()`. Brain thinks at ~250ms intervals (not every frame). Edge detection via downward raycasts (map-agnostic, works for any arena shape). **Bicycle model adaptation**: bots creep forward (`input.forward = true`) when speed < 3 u/s to maintain steering authority — prevents getting stuck at standstill in TARGET/CHARGE states

### Known patterns for next agents
- **Use Game.js** — don't create new loops. Add systems to Game and call them from `_animate()`:
  ```js
  import { Game } from './core/Game.js';
  const game = new Game();
  game.setPlayer(nickname, carType);
  game.start();
  ```
- **Access subsystems via Game**: `game.sceneManager`, `game.physicsWorld`, `game.collisionHandler`, `game.gameState`, `game.carBodies` (all CarBody[]), `game.abilities` (Map<CarBody, AbilitySystem>), `game.localPlayer`, `game.localAbility`
- Import constants: `import { CARS, ARENA, SCORING, ... } from '../core/Config.js'`
- Get real stat value: `STAT_MAP.speed[CARS.FANG.stats.speed]` → 36
- Build a car: `import { buildCar } from '../rendering/CarFactory.js'`
- Access scene: `game.sceneManager.scene` or `game.scene`
- Arena elements with animation: `game.sceneManager.arena.boostPads[]`, `.edgeLights[]`, `.arenaGroup` (driveable surfaces for raycasting), `._geyserSlots[]`, `._rockArmMeshes[]`
- Dynamic hazards: `game.dynamicHazards` — `update(dt, carBodies)`, `reset()`, `initAudio()`, `resumeAudio()`, events: `kill`, `geyserErupt`, `eruptionBlast`
- CarBody exposes: `_currentSpeed`, `_yaw`, `body`, `maxSpeed`, `mass`, `handling`, `playerId`, `nickname`, `score`, `lastHitBy`, `speedMultiplier`, `driftMode`, `hasRam`, `hasShield`, `isInvincible`, `_isFalling`, `_generation`, `_originalMass`, `resetState()`
- PowerUpManager exposes: `use(car)`, `drop(car)` (discard without activating), `getHeld(car)`, `getHeldConfig(car)`, `reset()`, events: `pickup`, `used`, `powerup-hit`
- AbilitySystem exposes: `state` ('ready'|'active'|'cooldown'), `cooldownProgress` (0→1), `isLeaping`, `use()`, `update(dt)`, `forceReset()`, `dispose()`
- CollisionHandler events: `hit { attacker, victim, points, tier, relSpeed }`, `ko { attacker, victim, points, isAbilityKO }`, `self-ko { victim, points }`, `fell { victim }`, `trail-hit { attacker, victim }`
- GameState events: `stateChange { from, to }`, `countdownTick { seconds }`, `roundTimeUpdate { remaining }`
- Game events: all of the above re-emitted + `playerSpawned { carBody, carType }`, `roundEnd { results[] }`
- Bots: `game.botManager` — `fillSlots()` (auto-called in setPlayer), `update(dt)` (auto-called in _animate), `isBot(carBody)`, `resetBrain(carBody)`, `removeAll()`, `resetForNewRound()`, `bots[]` array of `{ carBody, ability, brain, personalityName }`
- Name tags: `game.nameTags` — `add(carBody, isLocal)`, `update(camera, w, h)` (auto-called in _animate), `clear()`

### What to build next (recommended order)
1. ~~**BotManager.js + BotBrain.js**~~ ✅ DONE
2. ~~**Power-ups**~~ ✅ DONE
3. ~~**Volcano Arena + Dynamic Hazards**~~ ✅ DONE
4. **Wire HUD.js + MobileControls.js into main.js** — replace inline DOM HUD with HUD.js, wire MobileControls callbacks to Game input/ability/powerup
5. **Effects.js** — rocket flame particles (scale with speed), collision sparks, ability activation VFX, screen shake on big hits
6. **AudioManager.js** — Howler.js / Web Audio API placeholder sounds
7. **Boost pad physics** — impulse on contact with 1s per-car cooldown (visual pads exist, physics trigger not wired)
8. **Multiplayer** — PartyKit server + client networking + interpolation
