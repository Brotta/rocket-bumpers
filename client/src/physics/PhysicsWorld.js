import * as CANNON from 'cannon-es';
import { ARENA, COLLISION_GROUPS } from '../core/Config.js';

export class PhysicsWorld {
  constructor() {
    this.world = new CANNON.World();
    this.world.gravity.set(0, -9.82, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;

    this.world.defaultContactMaterial.friction = 0.05;
    this.world.defaultContactMaterial.restitution = 0.3;

    this._carMaterial = new CANNON.Material('car');
    this._arenaMaterial = new CANNON.Material('arena');
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this._carMaterial,
      this._arenaMaterial,
      { friction: 0.0, restitution: 0.0 },
    ));

    this.floorBody = null;
    this.lavaBody = null;
    this.obstacleBodies = [];

    this._buildFloor();
    this._buildLavaFloor();
    this._buildRockObstacles();

    this._fixedTimeStep = 1 / 60;
  }

  step(dt) {
    // Single fixed step — the game loop already runs at fixed 1/60 intervals,
    // so no internal accumulator or substeps are needed.
    this.world.step(dt);
  }

  // ── Octagonal floor (diameter 120, surface Y=0) ─────────────────────
  // Thin slab so side faces are negligible — cars slide off the edge and fall.
  _buildFloor() {
    const radius = ARENA.diameter / 2;
    const sides = 8;
    const halfThick = 0.05; // very thin — no effective side walls

    const verts = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 8;
      verts.push(new CANNON.Vec3(Math.cos(a) * radius,  halfThick, Math.sin(a) * radius));
    }
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 - Math.PI / 8;
      verts.push(new CANNON.Vec3(Math.cos(a) * radius, -halfThick, Math.sin(a) * radius));
    }

    const faces = [];
    faces.push([0, 1, 2, 3, 4, 5, 6, 7]);
    faces.push([15, 14, 13, 12, 11, 10, 9, 8]);
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      faces.push([i, next, next + sides, i + sides]);
    }

    const shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces });
    const body = new CANNON.Body({
      mass: 0,
      shape,
      material: this._arenaMaterial,
      collisionFilterGroup: COLLISION_GROUPS.ARENA,
      collisionFilterMask: COLLISION_GROUPS.CAR | COLLISION_GROUPS.PICKUP | COLLISION_GROUPS.TRAIL,
    });
    body.position.set(0, -halfThick, 0);
    this.world.addBody(body);
    this.floorBody = body;
  }

  // ── Central lava floor (slightly recessed) ──────────────────────────
  _buildLavaFloor() {
    const { radius } = ARENA.lava;
    const halfThick = 0.25;
    const sides = 16;

    const verts = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push(new CANNON.Vec3(Math.cos(a) * radius,  halfThick, Math.sin(a) * radius));
    }
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push(new CANNON.Vec3(Math.cos(a) * radius, -halfThick, Math.sin(a) * radius));
    }

    const faces = [];
    faces.push(Array.from({ length: sides }, (_, i) => i));
    faces.push(Array.from({ length: sides }, (_, i) => sides * 2 - 1 - i));
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      faces.push([i, next, next + sides, i + sides]);
    }

    const shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces });
    const body = new CANNON.Body({
      mass: 0,
      shape,
      material: this._arenaMaterial,
      collisionFilterGroup: COLLISION_GROUPS.ARENA,
      collisionFilterMask: COLLISION_GROUPS.CAR | COLLISION_GROUPS.PICKUP | COLLISION_GROUPS.TRAIL,
    });
    // Slightly recessed so cars dip into lava visually
    body.position.set(0, -0.6, 0);
    body._isLava = true;
    this.world.addBody(body);
    this.lavaBody = body;
  }

  // ── Static rock obstacles (pillars + boulders) ──────────────────────
  _buildRockObstacles() {
    const { pillars, boulders } = ARENA.rockObstacles;

    // Pillars — approximate as cylinders (using 8-sided ConvexPolyhedron)
    for (const p of pillars) {
      const x = Math.cos(p.angle) * p.dist;
      const z = Math.sin(p.angle) * p.dist;
      const r = p.baseRadius;
      const halfH = p.height / 2;
      const sides = 8;

      const verts = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        // Taper top to 70% of base
        verts.push(new CANNON.Vec3(Math.cos(a) * r * 0.7, halfH, Math.sin(a) * r * 0.7));
      }
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        verts.push(new CANNON.Vec3(Math.cos(a) * r, -halfH, Math.sin(a) * r));
      }

      const faces = [];
      faces.push(Array.from({ length: sides }, (_, i) => i));
      faces.push(Array.from({ length: sides }, (_, i) => sides * 2 - 1 - i));
      for (let i = 0; i < sides; i++) {
        const next = (i + 1) % sides;
        faces.push([i, next, next + sides, i + sides]);
      }

      const shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces });
      const body = new CANNON.Body({
        mass: 0,
        shape,
        material: this._arenaMaterial,
        collisionFilterGroup: COLLISION_GROUPS.ARENA,
        collisionFilterMask: COLLISION_GROUPS.CAR,
      });
      body.position.set(x, halfH, z);
      // Store collision radius for per-frame overlap enforcement
      body._obstacleRadius = r;
      body._obstacleType = 'pillar';
      this.world.addBody(body);
      this.obstacleBodies.push(body);
    }

    // Boulders — squashed polyhedron (matches visual Y-scale 0.65)
    for (const b of boulders) {
      const x = Math.cos(b.angle) * b.dist;
      const z = Math.sin(b.angle) * b.dist;

      // Build a 12-sided squashed sphere approximation
      const bSides = 12;
      const bRows = 3; // top, equator, bottom
      const bVerts = [];
      // Top cap
      bVerts.push(new CANNON.Vec3(0, b.radius * 0.65, 0));
      // Equator ring
      for (let i = 0; i < bSides; i++) {
        const a = (i / bSides) * Math.PI * 2;
        bVerts.push(new CANNON.Vec3(
          Math.cos(a) * b.radius,
          0,
          Math.sin(a) * b.radius,
        ));
      }
      // Bottom cap
      bVerts.push(new CANNON.Vec3(0, -b.radius * 0.4, 0));

      const bFaces = [];
      // Top fan
      for (let i = 0; i < bSides; i++) {
        const next = (i + 1) % bSides;
        bFaces.push([0, 1 + i, 1 + next]);
      }
      // Bottom fan
      const bottomIdx = 1 + bSides;
      for (let i = 0; i < bSides; i++) {
        const next = (i + 1) % bSides;
        bFaces.push([bottomIdx, 1 + next, 1 + i]);
      }

      const bShape = new CANNON.ConvexPolyhedron({ vertices: bVerts, faces: bFaces });
      const body = new CANNON.Body({
        mass: 0,
        shape: bShape,
        material: this._arenaMaterial,
        collisionFilterGroup: COLLISION_GROUPS.ARENA,
        collisionFilterMask: COLLISION_GROUPS.CAR,
      });
      body.position.set(x, b.radius * 0.6, z);
      body._obstacleRadius = b.radius;
      body._obstacleType = 'boulder';
      this.world.addBody(body);
      this.obstacleBodies.push(body);
    }
  }

  /**
   * Per-frame overlap enforcement: pushes any car body that overlaps
   * an obstacle out of it. This is a safety net — the physics engine
   * should handle most collisions, but the kinematic driving model
   * can override velocities and push cars through obstacles.
   *
   * Call AFTER applyControls() and AFTER world.step().
   * Returns array of { carBody, obstacleBody, speed } for hits that
   * need stun processing (car was newly pushed into an obstacle).
   */
  enforceObstacleOverlaps(carBodies) {
    const newHits = [];
    const carHalfWidth = 1.0; // car box half-extent X

    for (const cb of carBodies) {
      const cx = cb.body.position.x;
      const cz = cb.body.position.z;

      for (const ob of this.obstacleBodies) {
        const ox = ob.position.x;
        const oz = ob.position.z;
        const dx = cx - ox;
        const dz = cz - oz;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Minimum allowed distance: obstacle radius + car half-width + margin
        const minDist = ob._obstacleRadius + carHalfWidth + 0.15;

        if (dist < minDist && dist > 0.01) {
          // Car is overlapping — push it out
          const nx = dx / dist;
          const nz = dz / dist;
          const penetration = minDist - dist;

          cb.body.position.x += nx * penetration;
          cb.body.position.z += nz * penetration;

          // Also correct the smooth visual position
          cb._smoothPosX += nx * penetration;
          cb._smoothPosZ += nz * penetration;

          // Redirect velocity outward (remove inward component)
          const velDot = cb.body.velocity.x * nx + cb.body.velocity.z * nz;
          if (velDot < 0) {
            cb.body.velocity.x -= velDot * nx;
            cb.body.velocity.z -= velDot * nz;
            cb._internalVelX = cb.body.velocity.x;
            cb._internalVelZ = cb.body.velocity.z;
            cb._lastSetVelX = cb.body.velocity.x;
            cb._lastSetVelZ = cb.body.velocity.z;
          }

          // If car is not already stunned/immune, report as a new hit
          if (!cb._isStunned && cb._stunImmunityTimer <= 0) {
            const speed = Math.sqrt(
              cb.body.velocity.x * cb.body.velocity.x +
              cb.body.velocity.z * cb.body.velocity.z,
            ) + Math.abs(cb._currentSpeed) * 0.5;
            if (speed > 2) { // ignore trivial contacts
              newHits.push({ carBody: cb, obstacleBody: ob, speed, nx, nz });
            }
          }
        }
      }
    }
    return newHits;
  }
}
