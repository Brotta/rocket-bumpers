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
    this._maxSubSteps = 3;
  }

  step(dt) {
    this.world.step(this._fixedTimeStep, dt, this._maxSubSteps);
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
      this.world.addBody(body);
      this.obstacleBodies.push(body);
    }

    // Boulders — spheres
    for (const b of boulders) {
      const x = Math.cos(b.angle) * b.dist;
      const z = Math.sin(b.angle) * b.dist;

      const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Sphere(b.radius),
        material: this._arenaMaterial,
        collisionFilterGroup: COLLISION_GROUPS.ARENA,
        collisionFilterMask: COLLISION_GROUPS.CAR,
      });
      body.position.set(x, b.radius * 0.6, z);
      this.world.addBody(body);
      this.obstacleBodies.push(body);
    }
  }
}
