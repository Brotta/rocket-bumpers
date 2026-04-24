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

    // Lookup: `${edgeIdx}:${segIdx}` → { config } used by respawn path.
    // Config-only (not the live body) so we can always rebuild after
    // destruction regardless of array ordering.
    this._barrierRegistry = new Map();

    this._buildFloor();
    this._buildLavaFloor();
    this._buildRockObstacles();
    this._buildEdgeBarriers();

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

    // Vertices [0..sides) lie on the XZ ring at y=+halfThick with angle
    // increasing, which traces CW when viewed from +Y in right-handed Y-up.
    // Cannon-es wants CCW-from-outside, so the top cap is reversed and the
    // bottom cap (indices [sides..2·sides)) is kept ascending (CCW from -Y).
    const faces = [];
    faces.push([7, 6, 5, 4, 3, 2, 1, 0]);
    faces.push([8, 9, 10, 11, 12, 13, 14, 15]);
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

    // Top cap reversed (CCW viewed from +Y), bottom cap ascending (CCW viewed
    // from -Y). Side quads wound [top_i, top_next, bot_next, bot_i].
    const faces = [];
    faces.push(Array.from({ length: sides }, (_, i) => sides - 1 - i));
    faces.push(Array.from({ length: sides }, (_, i) => sides + i));
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
      faces.push(Array.from({ length: sides }, (_, i) => sides - 1 - i));
      faces.push(Array.from({ length: sides }, (_, i) => sides + i));
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

      // Equator ring is wound CW viewed from +Y (cos/sin with ascending
      // angle in right-handed Y-up), so top fan reverses (next, i) to put
      // the normal outward/upward; bottom fan keeps (i, next) so its
      // normal faces outward/downward.
      const bFaces = [];
      for (let i = 0; i < bSides; i++) {
        const next = (i + 1) % bSides;
        bFaces.push([0, 1 + next, 1 + i]);
      }
      const bottomIdx = 1 + bSides;
      for (let i = 0; i < bSides; i++) {
        const next = (i + 1) % bSides;
        bFaces.push([bottomIdx, 1 + i, 1 + next]);
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

  // ── Destructible edge barriers (8 edges × N segments) ───────────────
  // Volcanic-rock walls lining the octagon perimeter. Added to
  // obstacleBodies so the existing pipeline (missile sweep, obstacle
  // damage, debug overlay) handles them for free.
  _buildEdgeBarriers() {
    const cfg = ARENA.edgeBarriers;
    if (!cfg) return;

    const R = ARENA.diameter / 2;
    const sides = 8;
    // Width is derived from the octagon edge length so N segments tile
    // the edge with no gaps. cfg.width is ignored for sizing/placement.
    const edgeLen = 2 * R * Math.sin(Math.PI / sides);
    const segmentWidth = edgeLen / cfg.segmentsPerEdge;
    for (let edgeIdx = 0; edgeIdx < sides; edgeIdx++) {
      const a0 = (edgeIdx / sides) * Math.PI * 2 - Math.PI / 8;
      const a1 = ((edgeIdx + 1) / sides) * Math.PI * 2 - Math.PI / 8;
      const p1x = Math.cos(a0) * R, p1z = Math.sin(a0) * R;
      const p2x = Math.cos(a1) * R, p2z = Math.sin(a1) * R;

      // Edge midpoint + tangent + inward normal
      const mx = (p1x + p2x) / 2;
      const mz = (p1z + p2z) / 2;
      const ex = p2x - p1x, ez = p2z - p1z;
      const elen = Math.hypot(ex, ez);
      const tx = ex / elen, tz = ez / elen;     // unit tangent
      const mR = Math.hypot(mx, mz);
      const nx = -mx / mR, nz = -mz / mR;       // unit inward normal
      // Three.js/CANNON right-handed Y-up: R_y(yaw) maps local X to
      // (cos yaw, 0, -sin yaw). To align the box's width axis with the
      // tangent (tx, tz) we need sin(yaw) = -tz, hence atan2(-tz, tx).
      // Using atan2(tz, tx) produced 90° perpendicular orientation on
      // the diagonal edges (1,3,5,7) — the axis-aligned edges looked
      // fine only because a box is symmetric under a 180° Y rotation.
      const yaw = Math.atan2(-tz, tx);

      for (let segIdx = 0; segIdx < cfg.segmentsPerEdge; segIdx++) {
        // Segment center along the edge, inset inward from the face line.
        const frac = (segIdx + 0.5) / cfg.segmentsPerEdge - 0.5; // -0.33, 0, 0.33
        const cx = mx + tx * elen * frac + nx * cfg.inset;
        const cz = mz + tz * elen * frac + nz * cfg.inset;
        const config = {
          edgeIdx, segIdx,
          x: cx, z: cz, yaw,
          width: segmentWidth, height: cfg.height, thickness: cfg.thickness,
        };
        this._barrierRegistry.set(`${edgeIdx}:${segIdx}`, config);
        this._spawnBarrierBody(config);
      }
    }
  }

  _spawnBarrierBody(config) {
    const cfg = ARENA.edgeBarriers;
    const shape = new CANNON.Box(new CANNON.Vec3(
      config.width / 2, config.height / 2, config.thickness / 2,
    ));
    const body = new CANNON.Body({
      mass: 0,
      shape,
      material: this._arenaMaterial,
      collisionFilterGroup: COLLISION_GROUPS.ARENA,
      collisionFilterMask: COLLISION_GROUPS.CAR,
    });
    body.position.set(config.x, config.height / 2, config.z);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), config.yaw);
    // For the circle-phase filter in enforceObstacleOverlaps (coarse pass
    // that rejects far-away pairs) use the half-diagonal; the real test
    // is done in the box branch below so no false-negative risk.
    body._obstacleRadius = Math.hypot(config.width, config.thickness) / 2 + 0.3;
    body._obstacleType = 'barrier';
    body._barrierEdgeIdx = config.edgeIdx;
    body._barrierSegIdx = config.segIdx;
    body._barrierHalfW = config.width / 2;
    body._barrierHalfT = config.thickness / 2;
    body._barrierYaw = config.yaw;
    body._barrierConfig = config;
    this.world.addBody(body);
    this.obstacleBodies.push(body);
    return body;
  }

  /** Rebuild a previously destroyed barrier. Returns body or null. */
  respawnBarrier(edgeIdx, segIdx) {
    const key = `${edgeIdx}:${segIdx}`;
    const config = this._barrierRegistry.get(key);
    if (!config) return null;
    // Already live? Skip.
    for (const b of this.obstacleBodies) {
      if (b._obstacleType === 'barrier'
        && b._barrierEdgeIdx === edgeIdx
        && b._barrierSegIdx === segIdx) {
        return b;
      }
    }
    return this._spawnBarrierBody(config);
  }

  /** Lookup barrier body by (edgeIdx, segIdx), or null if destroyed. */
  findBarrierBody(edgeIdx, segIdx) {
    for (const b of this.obstacleBodies) {
      if (b._obstacleType === 'barrier'
        && b._barrierEdgeIdx === edgeIdx
        && b._barrierSegIdx === segIdx) return b;
    }
    return null;
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

        let nx, nz, penetration;

        if (ob._obstacleType === 'barrier') {
          // Rotated-box test: rotate (dx,dz) into the barrier local frame,
          // clamp to [±halfW+carHalf, ±halfT+carHalf]. The axis with
          // smallest |delta - clamp| determines the push-out direction.
          const cosY = Math.cos(-ob._barrierYaw);
          const sinY = Math.sin(-ob._barrierYaw);
          const lx = dx * cosY - dz * sinY;     // local-X (along wall)
          const lz = dx * sinY + dz * cosY;     // local-Z (through wall)
          const halfXExp = ob._barrierHalfW + carHalfWidth;
          const halfZExp = ob._barrierHalfT + carHalfWidth + 0.15;
          const penX = halfXExp - Math.abs(lx);
          const penZ = halfZExp - Math.abs(lz);
          if (penX <= 0 || penZ <= 0) continue;   // no overlap
          // Resolve on axis with smallest penetration (shortest push-out)
          let localNx, localNz;
          if (penZ <= penX) {
            localNx = 0;
            localNz = lz >= 0 ? 1 : -1;
            penetration = penZ;
          } else {
            localNx = lx >= 0 ? 1 : -1;
            localNz = 0;
            penetration = penX;
          }
          // Rotate local normal back to world frame
          const cosY2 = Math.cos(ob._barrierYaw);
          const sinY2 = Math.sin(ob._barrierYaw);
          nx = localNx * cosY2 - localNz * sinY2;
          nz = localNx * sinY2 + localNz * cosY2;
        } else {
          // Circular obstacle (pillar/boulder)
          const dist = Math.sqrt(dx * dx + dz * dz);
          const minDist = ob._obstacleRadius + carHalfWidth + 0.15;
          if (!(dist < minDist && dist > 0.01)) continue;
          nx = dx / dist;
          nz = dz / dist;
          penetration = minDist - dist;
        }

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
    return newHits;
  }
}
