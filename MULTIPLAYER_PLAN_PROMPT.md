# Prompt: Piano di Integrazione Multiplayer per Rocket Bumpers

## Obiettivo

Devi progettare un piano di implementazione dettagliato per aggiungere il multiplayer real-time a **Rocket Bumpers**, un gioco di combattimento veicolare in Three.js. Il gioco è attualmente single-player con bot AI client-side. Deve diventare multiplayer con fino a 16 giocatori per lobby (umani + bot). I bot restano client-side (max 7) e vengono ridotti dinamicamente quando arrivano giocatori umani.

## Stack tecnologico obbligatorio

- **Server**: PartyKit (WebSocket, edge computing su Cloudflare, free tier)
- **Client**: Three.js + cannon-es (già implementato)
- **Deploy**: Vercel (client) + PartyKit (server)

## Architettura attuale del gioco

### Game Loop (fixed timestep)
- **Physics**: 60 Hz fixed timestep con accumulator (`FIXED_DT = 1/60`)
- **Rendering**: display refresh rate con interpolazione tra frame fisici (alpha blending)
- **Ordine fixed update**: input locale → bot AI → abilities → physics step → floor safety → hazards → collisioni → overlap stun → power-ups → portal system
- **Network send rate previsto**: 20 Hz (`PHYSICS.networkSendRate = 20` già in Config.js)

### Stato per-car (CarBody.js) — da sincronizzare
```
Identità: playerId, nickname, carType
Posizione: body.position (x,y,z), body.velocity (x,y,z), _yaw (heading rad), _currentSpeed
Stato: hp (0-100), isEliminated, isInvincible, _isStunned, _stunTimer
Ability: speedMultiplier, driftMode, hasShield, hasRam
Damage: lastHitBy { source, wasAbility, time }
```

### Metodi chiave CarBody
- `setPosition(x, y, z, yaw)` — reset completo posizione + velocity
- `applyControls(input, dt)` — input = { forward, backward, left, right }
- `takeDamage(amount, source, wasAbility)` — ritorna danno effettivo, elimina se hp<=0
- `resetState()` — pulisce ability effects, incrementa `_generation` per invalidare timeout pendenti
- `resetHP()` — hp=100, isEliminated=false
- `syncMesh(dt, alpha)` — interpola mesh tra _prevPos e pos corrente

### Sistema di scoring (ScoreManager.js)
- Traccia per playerId: score, kills, deaths, streak, hits
- Kill streak multiplier: 2x a 3 KO, 3x a 5 KO
- Metodi: `registerPlayer(id, name)`, `removePlayer(id)`, `onKill(killerId, victimId)`, `onDamage(attackerId, amount)`, `onDeath(playerId)`
- `serialize()` per stato completo, `getLeaderboard()` per classifica ordinata

### Bot Manager (BotManager.js)
- `fillSlots()` — riempie fino a `PLAYERS.maxBots` (7) bot
- `adjustBotCount(humanCount)` — rimuove bot quando arrivano umani, ne aggiunge quando escono
- Bot usano BotBrain (state machine: ROAM→HUNT→CHARGE→EVADE→FLEE) con personalità diverse
- Bot update a 60 Hz come player normali, producono input → applyControls()

### Power-Up Manager (PowerUpManager.js)
- 6 pedestals sull'arena, respawn ogni 8 secondi
- Pickup per prossimità (raggio 2 unità)
- Tipi: MISSILE, HOMING_MISSILE, SHIELD, REPAIR_KIT, HOLO_EVADE, AUTO_TURRET, GLITCH_BOMB
- Ha proiettili attivi (missile) che servono sync

### Ability System (AbilitySystem.js)
- Per-car, stati: ready → active → cooldown
- 8 abilità uniche: NITRO, DASH, RAM, TRAIL, PULSE, DRIFT, LEAP, PHASE
- Alcune creano oggetti nella scena (trail di fuoco VIPER, shockwave MAMMOTH)

### Collision Handler (CollisionHandler.js)
- Velocity-based damage: `BASE × (approachSpeed / REF_SPEED) × sqrt(attackerMass) × angleFactor / (1 + victimMass × ARMOR_FACTOR)`
- Pair cooldown: 1 secondo tra stessa coppia
- Emette eventi: 'damage', 'eliminated', 'fell', 'trail-hit', 'obstacle-hit'

### Game State (GameState.js) — Endless Mode
- Solo 2 stati: LOADING → PLAYING (forever)
- Nessun round, nessun timer, respawn infinito
- Respawn: bot → auto random car dopo 2.5s. Umani → CarSelect overlay → scelgono auto → respawn

### Portal System (PortalSystem.js)
- Exit portal sopra la lava centrale (redirect a vibej.am)
- Return portal al bordo (se arrivato da ?portal=true&ref=...)
- Launch ramps con shader speed-pad
- Warp transition animata (vortice 2D + car spinning) prima del redirect

### Messaggi di rete previsti (da GAME_DESIGN.md)

**Client → Server:**
```
PLAYER_JOIN     { nickname, carType }
PLAYER_STATE    { pos: [x,y,z], vel: [x,y,z], yaw, speed, abilityActive }  // 20 Hz
COLLISION       { targetId, relativeVelocity }
PICKUP_POWERUP  { powerupId }
USE_POWERUP     { type, pos: [x,y,z] }
USE_ABILITY     { type, pos: [x,y,z] }
PLAYER_FELL     { }
CHANGE_CAR      { carType }
```

**Server → Client:**
```
ROOM_STATE      { players: [...], powerups: [...] }
PLAYER_JOINED   { id, nickname, carType }
PLAYER_LEFT     { id }
PLAYER_UPDATE   { id, pos, vel, yaw, speed, abilityActive }  // broadcast 20 Hz
DAMAGE_DEALT    { targetId, amount, sourceId, wasAbility }
PLAYER_ELIMINATED { playerId, killerId }
POWERUP_SPAWNED { id, type, position }
POWERUP_TAKEN   { id, playerId }
POWERUP_USED    { playerId, type, pos }
ABILITY_USED    { playerId, type, pos }
PLAYER_RESPAWN  { playerId, pos, carType }
```

### File principali (percorsi relativi a client/src/)
```
core/Game.js          — orchestratore principale (~1000 righe)
core/GameState.js     — state machine (LOADING→PLAYING)
core/Config.js        — tutte le costanti
core/ScoreManager.js  — scoring per playerId
core/PowerUpManager.js — spawn/pickup/proiettili power-up
core/PortalSystem.js  — portali + rampe + warp transition
physics/CarBody.js    — corpo fisico auto + stato
physics/PhysicsWorld.js — mondo cannon-es
physics/CollisionHandler.js — danno + eliminazione
physics/AbilitySystem.js — abilità per-car
physics/DynamicHazards.js — lava, eruzioni, geyser
ai/BotManager.js      — spawn/gestione bot
ai/BotBrain.js        — AI state machine
rendering/SceneManager.js — Three.js scene/camera/renderer
rendering/CarFactory.js — caricamento modelli GLB
ui/CarSelect.js       — selezione auto (anche in respawn mode)
main.js               — entry point, HUD, event wiring
```

## Decisioni architetturali da prendere

Il piano deve affrontare esplicitamente queste questioni:

### 1. Modello di autorità
- **Server-authoritative** per: HP, eliminazioni, power-up spawn/pickup (first-come-first-served), score
- **Client-authoritative** per: posizione/velocità propria (client-side prediction)
- Come gestire la validazione server-side del danno? Il server ricalcola o si fida del client?
- Come prevenire cheating senza physics server-side (che sarebbe troppo costoso)?

### 2. Interpolazione e prediction
- I remote player ricevono stato a 20 Hz — servono 50ms di buffer per interpolare
- Che tipo di interpolazione? (lerp lineare, hermite con velocity, dead reckoning?)
- Come gestire lo snap quando la predizione diverge troppo dal server state?

### 3. Gestione collisioni in multiplayer
- Le collisioni car-car avvengono localmente (cannon-es) — come riconciliare?
- Se il danno è server-authoritative, il client manda "ho colpito X a velocità Y" e il server decide?
- Come evitare double-damage (entrambi i client reportano la stessa collisione)?

### 4. Power-up contention
- Due player arrivano sullo stesso power-up — il server decide chi l'ha preso (primo messaggio ricevuto)
- Il client deve fare rollback visuale se il server nega il pickup?

### 5. Lobby e matchmaking
- Come funziona il join? URL con room ID? Auto-matchmaking?
- Cosa succede se un player arriva via portale (?portal=true)?
- Come gestire il disconnect/reconnect?

### 6. Bot hosting in multiplayer
- I bot girano solo sul client dell'host (primo player)?
- Oppure il server gestisce i bot? (più costoso ma più fair)
- Come si sincronizzano i bot con gli altri client?

### 7. Struttura del codice
- Dove va il NetworkManager.js? Come si interfaccia con Game.js?
- Il server PartyKit: una sola "party" o stanze separate?
- Come si struttura il server (partykit.json, server.ts)?
- Quali file client esistenti vanno modificati e come?

### 8. Bandwidth e performance
- Quanto pesa un PLAYER_STATE message? (target: <100 bytes)
- Con 16 player a 20 Hz: 16 × 20 × 100 = 32 KB/s per client — accettabile?
- Serve delta compression o bastano snapshot?

### 9. Deploy
- Setup PartyKit: come creare il progetto server, deploy, custom domain
- Come configurare il client per connettersi al server (dev vs production URL)
- Environment variables / config

## Formato del piano richiesto

Il piano deve includere:

1. **Architettura di rete** — diagramma testuale del flusso dati client↔server
2. **Protocollo messaggi** — formato esatto di ogni messaggio (binary o JSON), frequenza, dimensione stimata
3. **Server PartyKit** — struttura del codice server, gestione stato room, logica di validazione
4. **Client NetworkManager** — API pubblica, come si integra con Game.js
5. **Modifiche ai file esistenti** — lista precisa di cosa cambia in ogni file, con descrizione delle modifiche
6. **Nuovi file da creare** — con responsabilità e interfaccia
7. **Ordine di implementazione** — fasi incrementali (prima connessione base, poi sync posizioni, poi collisioni, etc.)
8. **Piano di test** — come verificare che ogni fase funziona

Non scrivere codice — scrivi solo il piano architetturale e le specifiche. Il codice verrà scritto dopo l'approvazione del piano.
