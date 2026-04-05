# 🎯 PROMPT GUIDE — Claude Code Prompts for Rocket Bumpers

Ogni prompt è pensato per essere copiato e incollato in Claude Code.
Segui l'ordine. Testa dopo ogni prompt.

---

## FASE 1 — Foundation (Giorni 1-3)

### Prompt 1.1 — Project Setup
```
Leggi il file GAME_DESIGN.md in questo progetto.
Inizializza il progetto client con Vite vanilla JS.
- package.json con dipendenze: three, cannon-es, howler, vite
- vite.config.js base
- index.html con canvas fullscreen, no scrollbar, sfondo nero
- src/main.js che importa Three.js e mostra un cubo rosso rotante come test
- src/core/Config.js con TUTTE le costanti dal GAME_DESIGN.md:
  * Stats di tutte le 8 auto (speed, mass, handling, ability con cooldown)
  * Dimensioni arena, scoring, timing round
  * Mapping stat points → valori reali
Il gioco NON deve usare React. Vanilla JS + classi ES6.
```

### Prompt 1.2 — Arena
```
Leggi GAME_DESIGN.md sezione Arena.
Crea src/rendering/ArenaBuilder.js:
- Piattaforma ottagonale (80 units diametro) con materiale scuro (MeshStandardMaterial)
- Bordi con linee neon luminose (cyan, emissive)
- 4 rampe alle direzioni cardinali (15° inclinazione, 10 units)
- 8 boost pad (strip arancioni emissive pulsanti)
- 6 piedistalli per power-up (cilindri bassi con glow)
- Skybox scuro con stelle
- Lighting: 1 ambient bassa + 1 directional dall'alto + point lights sui bordi
Crea src/rendering/SceneManager.js e integra in main.js.
```

### Prompt 1.3 — Car Factory (tutti gli 8 modelli)
```
Leggi GAME_DESIGN.md sezione Cars — tutti gli 8 modelli.
Crea src/rendering/CarFactory.js:
- Funzione buildCar(carType, playerColor) che ritorna un THREE.Group
- Ogni auto è costruita proceduralmente con Box, Cylinder, Cone geometry
- Tutte hanno: 4 ruote (cilindri scuri), razzo posteriore (cono + cilindro)
- Dettagli specifici per modello:

1. FANG (Muscle Car): corpo lungo e basso, rear rialzato, stance larga
2. HORNET (Go-Kart): minuscolo, bassissimo, ruote esposte, no tetto
3. RHINO (Armored Truck): alto, box rinforzato, paraurti spesso, ruote grosse
4. VIPER (Formula): ultra piatto, alettone anteriore largo, corpo stretto, pinna posteriore
5. TOAD (Van): alto e box, bordi arrotondati, chunky
6. LYNX (Cabrio): sleek, basso, no tetto, linee curve, spoiler
7. MAMMOTH (Monster Truck): ruote enormi, chassis rialzato, roll cage
8. GHOST (Cyber): angolare, sfaccettato, ruote che sembrano fluttuare, vents sci-fi

- Materiale MeshStandardMaterial con colore configurabile + emissive glow leggero
- Scala consistente: tutte le auto devono stare in un bounding box di ~2x1.2x1.2 units
- Aggiungi metodo getCarPreviewScene(carType) per la schermata di selezione

Testa: mostra tutte le 8 auto in fila nell'arena per verificare che siano visivamente distinte.
```

### Prompt 1.4 — Car Physics + Driving
```
Leggi GAME_DESIGN.md sezioni Cars (stat mapping) e Controls.
Crea src/physics/PhysicsWorld.js:
- Cannon-es world con gravità -9.82
- Piano fisico per l'arena + corpi per rampe
- Step a 60Hz

Crea src/physics/CarBody.js:
- Costruttore: CarBody(carType) — legge stats da Config.js per quel tipo di auto
- Rigid body Box con massa dal stat mapping (es. FANG mass=5 → 6kg)
- applyControls(input): W/A/S/D → forze basate su speed/handling dell'auto
- Max speed, acceleration, turn speed tutti letti dalle stats del carType
- Freno: 60 u/s² per tutte le auto
- Sync posizione/rotazione body fisico → mesh ThreeJS

Camera terza persona: 8 dietro, 5 sopra, lerp 0.08, guarda 3 avanti.
Testa: guida una FANG e una HORNET per sentire la differenza di stats.
```

### Prompt 1.5 — Car Select Screen
```
Leggi GAME_DESIGN.md sezione Car Select UI.
Crea src/ui/CarSelect.js:
- Overlay fullscreen DOPO aver inserito il nickname
- Scena ThreeJS separata (o sovrapposta): modello auto che ruota lentamente su piedistallo neon
- Nome auto grande in alto (es. "FANG — MUSCLE CAR")
- 3 stat bars orizzontali animate:
  * SPEED: barra rossa/arancione
  * MASS: barra blu
  * HANDLING: barra verde
  * Ogni barra ha label + valore numerico (es. "6/8")
- Sotto le stats: nome ability + descrizione one-line
  Es. "ABILITY: NITRO — Burst of speed (1.8× for 1.5s)"
- Frecce ←/→ per scorrere (keyboard + click/tap)
- Swipe su mobile per scorrere
- Pulsante "SELECT" grande al centro-basso
- Animazione transizione tra auto (slide o fade)
- Stile: sfondo scuro, font monospace/arcade, colori neon, glow CSS

Flow completo: Lobby (nickname) → CarSelect → Game
```

---

## FASE 2 — Gameplay Loop (Giorni 4-6)

### Prompt 2.1 — Ability System
```
Leggi GAME_DESIGN.md — tutte le 8 abilities.
Crea src/physics/AbilitySystem.js:
- Classe AbilitySystem(carType, carBody) — una per giocatore/bot
- Ogni ability ha: cooldown, durata (se applicabile), stato (ready/active/cooldown)
- Metodo use() → attiva l'ability se ready, avvia cooldown
- Metodo update(dt) → gestisce timer attivo e cooldown

Implementa tutte e 8:

1. NITRO (FANG): applica forza extra per 1.5s (1.8× velocità). Cooldown 6s
2. DASH (HORNET): teletrasporta 5 units avanti istantaneamente. Cooldown 4s
   - Effetto visivo: scia ghost nella posizione originale
3. RAM (RHINO): massa → 999 per 2s + leggero speed boost. Cooldown 8s
   - Effetto visivo: auto diventa rosso brillante
4. TRAIL (VIPER): 1.5× speed per 3s + spawna oggetti fuoco dietro che danneggiano. Cooldown 7s
   - Trail: piccoli box infuocati ogni 0.3s che persistono 2s e danno knockback
5. PULSE (TOAD): impulso radiale istantaneo, raggio 8 units, forza 300. Cooldown 6s
   - Effetto visivo: anello che si espande
6. DRIFT (LYNX): 2s di zero friction laterale + mantieni velocità in curva. Cooldown 5s
   - Effetto visivo: particelle laterali dalle ruote
7. LEAP (MAMMOTH): impulso Y verso l'alto (forza 12), al landing shockwave (raggio 6, forza 200). Cooldown 7s
   - Traccia flag `isLeaping = true` quando attivato
   - Rileva landing: collision con pavimento + isLeaping → trigger shockwave → isLeaping = false
   - Shockwave aggiorna `lastHitBy` su tutte le auto nel raggio (per attribuzione KO)
8. PHASE (GHOST): 0.8s di intangibilità. Usa collision filter groups di cannon-es:
   - Imposta collision mask a ARENA only (group 1) — il pavimento regge ancora
   - Disabilita collisioni con CAR, PICKUP, TRAIL (rimuovi gruppi 2,4,8)
   - Effetto visivo: auto semi-trasparente + effetto glitch
   - Stessa logica per invincibilità respawn

Input: Space (keyboard), Ability button (mobile)
Mostra cooldown nell'HUD come cerchio che si riempie.
```

### Prompt 2.2 — Collision Scoring + Round Loop
```
Leggi GAME_DESIGN.md sezioni Scoring e Round Structure.

Crea src/physics/CollisionHandler.js:
- Leggi GAME_DESIGN.md sezione "Collision & Damage Rules" per TUTTE le regole
- Ascolta collisioni cannon-es tra corpi auto
- Calcola velocità relativa: >5=+10, >15=+25, >25=+50
- Caduta (Y < -5): controlla lastHitBy

KO Attribution (FONDAMENTALE):
- Ogni auto traccia `lastHitBy: { playerId, timestamp, wasAbility }`
- Su OGNI collisione o forza (PULSE, LEAP shockwave, TRAIL fire), aggiorna lastHitBy sulla vittima
- Se `wasAbility` è true sull'attaccante → segna `wasAbility = true`
- Quando auto cade (Y < -5):
  * Se lastHitBy.timestamp entro 3s → attaccante riceve KO (+100)
  * Se lastHitBy.wasAbility → Ability KO (+75) invece di +100
  * Se nessun lastHitBy recente → self-KO, vittima -50, nessun +100

Max Velocity Cap:
- Ogni frame fisico: se velocity.length() > 70 → normalizza e scala a 70
- Applica DOPO tutti i moltiplicatori (ability + power-up + boost pad)

Shield vs RAM:
- Shield: knockback → 0 (immune)
- RAM colpisce Shield: knockback ridotto al 50% (RAM sovrascrive parzialmente Shield)

Collision Filter Groups (da Config.PHYSICS.COLLISION_GROUPS):
- ARENA=1, CAR=2, PICKUP=4, TRAIL=8
- Auto normali: mask 15 (collide con tutto)
- PHASE / invincibilità respawn: mask 1 (solo arena)

- Emetti eventi: 'collision-small', 'collision-big', 'collision-mega', 'player-fell', 'player-ko', 'ability-ko'

Crea src/core/GameState.js:
- State machine: LOBBY → COUNTDOWN → PLAYING → RESULTS → LOBBY/COUNTDOWN
- COUNTDOWN: 3s, auto bloccate, testo "3... 2... 1... SMASH!"
- PLAYING: 90s timer
- RESULTS: 8s, mostra scoreboard

Crea src/core/Game.js:
- Main loop con requestAnimationFrame
- Delta time cap a 1/30
- Gestisce GameState, PhysicsWorld, AbilitySystem, tutti i sistemi
```

### Prompt 2.3 — HUD + Mobile Controls
```
Leggi GAME_DESIGN.md sezioni Controls e Mobile Controls Layout.

Crea src/ui/HUD.js (overlay DOM):
- Timer in alto centro (MM:SS, rosso sotto 10s, pulsa sotto 5s)
- Score in alto sinistra (flash verde quando sale)
- Ability indicator in basso centro-destra:
  * Cerchio con icona/lettera dell'ability
  * Bordo che si riempie clockwise durante cooldown
  * Glow quando ready
  * Nome ability sotto (es. "NITRO")
- Power-up slot: quadrato con bordo colorato + icona, grigio se vuoto
- Kill feed in alto destra: "[PLAYER] → [VICTIM] +50", scompare dopo 3s

Crea src/ui/MobileControls.js:
- Rileva touch: 'ontouchstart' in window
- Joystick virtuale (cerchio semitrasparente, appare dove tocchi metà sinistra schermo)
  * X = sterzo, Y = accelera/frena
  * Thumb segue il dito dentro il cerchio
- Ability button (grande, basso-destra): cerchio con cooldown overlay circolare
- Power-up button (più piccolo, sopra ability): mostra colore power-up attivo
- Multitouch: joystick + bottone contemporaneo
- preventDefault su tutti i touch (no scroll/zoom)
- Nascondi su desktop
- Stile: cerchi semitrasparenti con bordo neon
```

### Prompt 2.4 — Power-ups
```
Leggi GAME_DESIGN.md sezione Power-ups.
Crea src/core/PowerUpManager.js:
- 6 posizioni fisse sull'arena, mesh rotante + glow
- 4 tipi: ROCKET_BOOST, SHOCKWAVE, SHIELD, MAGNET (vedi GAME_DESIGN per dettagli)
- Pickup con collisione fisica
- Max 1 power-up per giocatore (separato dall'ability dell'auto)
- Respawn dopo 8s
- Tasto E/Shift (keyboard), Power-up button (mobile)
```

### Prompt 2.5 — Respawn System
```
Leggi GAME_DESIGN.md sezione Respawn.
Quando auto cade (Y < -5):
1. Rimuovi controllo, camera segue auto che cade per 2s
2. Teletrasporta a posizione random sull'arena
3. 1.5s invincibilità (auto lampeggia/semi-trasparente)
4. Restituisci controllo
- No respawn ultimi 10s del round
- Flash visivo al respawn
```

---

## FASE 3 — AI Bots (Giorni 7-8)

### Prompt 3.1 — Bot System
```
Leggi GAME_DESIGN.md sezione AI Bots.
Crea src/ai/BotManager.js:
- Riempie posti vuoti fino a 8 con bot
- Ogni bot sceglie un tipo di auto random → usa quelle stats + ability
- Nomi: TURBO, BLAZE, NITRO, CRASH, FURY, BOLT, HAVOC, STORM

Crea src/ai/BotBrain.js:
- State machine: ROAM → TARGET → CHARGE → EVADE → ROAM (+ POWERUP_SEEK)
- Usa ability del proprio tipo di auto quando ha senso:
  * NITRO/TRAIL: usa quando sta caricando un target
  * DASH: usa per evadere dal bordo
  * RAM: usa quando sta per colpire qualcuno
  * PULSE: usa quando circondato
  * DRIFT: usa in curva durante inseguimento
  * LEAP: usa per saltare sopra nemici o evitare caduta
  * PHASE: usa quando sta per essere colpito

Crea src/ai/BotPersonalities.js:
- 4 personalità con pesi diversi (Aggressive, Defensive, Kamikaze, Hunter)
- Assegnazione random a ogni bot
```

---

## FASE 4 — Multiplayer (Giorni 9-12)

### Prompt 4.1 — PartyKit Server
```
Leggi GAME_DESIGN.md sezione Multiplayer Architecture.
Crea server/src/GameRoom.ts:
- Gestisci WebSocket: onConnect, onMessage, onClose
- Room state: giocatori (id, nickname, carType, colore, score), round, power-ups
- PLAYER_JOIN include carType, CHANGE_CAR per cambio tra round
- Round management server-side
- Valida collisioni e power-up pickup
- Broadcast updates a tutti i client
- Max 8 per room
```

### Prompt 4.2 — Network Client
```
Leggi GAME_DESIGN.md sezione Network Messages.
Crea src/network/NetworkManager.js:
- PartySocket connection
- Join con nickname + carType
- Invia PLAYER_STATE a 20Hz (includi abilityActive)
- Ricevi e applica PLAYER_UPDATE per auto remote
- Gestisci ABILITY_USED per effetti visivi delle ability degli altri
- Fallback: se server non disponibile → offline mode con solo bot

Crea src/network/Interpolation.js:
- Buffer 3 frame, lerp posizioni, slerp rotazioni

Crea src/ui/Lobby.js:
- Titolo "ROCKET BUMPERS" neon con glow animation
- Input nickname → conferma → CarSelect → Play
- Se offline: mostra "OFFLINE MODE" e vai diretti a CarSelect
```

---

## FASE 5 — Juice & Polish (Giorni 13-16)

### Prompt 5.1 — Particle Effects
```
Leggi GAME_DESIGN.md sezione Visual Effects.
Crea src/rendering/Effects.js:
1. RocketFlame: emitter sul retro, scala con velocità, arancio→giallo→trasparente
2. CollisionSparks: 20 particelle burst bianco→giallo al punto di impatto
3. AbilityVFX per tipo:
   - NITRO: fiamma più intensa + scia
   - DASH: ghost trail nella posizione originale (mesh semitrasparente che sfuma in 0.5s)
   - RAM: aura rossa attorno all'auto
   - TRAIL: box infuocati lasciati a terra
   - PULSE: anello che si espande da 0 a 8 units
   - DRIFT: particelle laterali dalle ruote
   - LEAP: dust cloud al lancio, shockwave ring al landing
   - PHASE: auto semitrasparente con effetto glitch/scan lines
4. PowerUpPickup: ring che si espande + particelle verso l'alto

ObjectPool per tutte le particelle. Billboard behavior.
```

### Prompt 5.2 — Screen Shake + Post Processing
```
Crea src/rendering/PostProcessing.js:
- Screen shake su impatti (intensity scala con velocità: 0.1 / 0.3 / 0.5)
- Decay 0.3s, stack su impatti multipli
- Bloom opzionale (UnrealBloomPass, threshold 0.8, strength 0.4)
- Hit flash: overlay bianco 1 frame su mega hit
```

### Prompt 5.3 — Audio
```
Crea src/audio/AudioManager.js:
- Placeholder Web Audio API synth:
  * Engine hum (oscillatore basso, pitch scala con speed)
  * Hit small/big/mega (noise burst + sub bass)
  * Ability sounds (unici per tipo): NITRO=whoosh, DASH=zap, RAM=clank, ecc.
  * Pickup chime, countdown beeps, round end fanfare
- Volume master/SFX/music (localStorage)
- Mute button in UI
```

### Prompt 5.4 — Scoreboard + Polish
```
Crea src/ui/Scoreboard.js:
- Overlay dopo RESULTS
- Lista giocatori ordinata per score
- Per ogni giocatore: posizione, nickname, icona auto, score, best hit
- Primo posto evidenziato con glow oro
- Due pulsanti: "PLAY AGAIN" (stessa auto) e "CHANGE CAR" (torna a CarSelect)
- Auto-restart timer (8s)
```

---

## FASE 6 — Ship (Giorni 17-18)

### Prompt 6.1 — Performance
```
Ottimizza:
- Object pooling per particelle
- Riduci particelle su mobile (detecta con isMobile, usa 0.5× count)
- Lazy load audio
- Verifica 60 FPS desktop, 30+ mobile
- Profila con Chrome DevTools
```

### Prompt 6.2 — Deploy
```
Deploy finale:
- vite build ottimizzato
- Deploy client su Vercel (o custom domain)
- Deploy server PartyKit
- Test cross-browser: Chrome, Firefox, Safari, mobile
- Fallback offline graceful (no WS → bot mode)
- README.md con screenshot, link live, istruzioni
```
