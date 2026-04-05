import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ArenaBuilder } from './ArenaBuilder.js';

export class SceneManager {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a0e08);
    this.scene.fog = new THREE.FogExp2(0x1a0e08, 0.0025);

    this._initRenderer();
    this._initCamera();

    this.arena = new ArenaBuilder(this.scene);
    this.arena.build();

    // Generate a procedural environment map for car reflections (volcanic glow)
    this._buildEnvironmentMap();

    // Post-processing pipeline (Bloom only — SSAO removed for performance)
    this._initPostProcessing();

    this._clock = new THREE.Clock();

    window.addEventListener('resize', () => this._onResize());
  }

  _initRenderer() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 1.5 });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.6;
    document.body.appendChild(this.renderer.domElement);
  }

  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    // Overview position to see the arena
    this.camera.position.set(0, 60, 60);
    this.camera.lookAt(0, 0, 0);
  }

  _initPostProcessing() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();

    this.composer = new EffectComposer(this.renderer);

    // 1. Render pass — renders the scene normally
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // 2. Bloom — cinematic glow on emissive surfaces (lava, edge tubes, geysers)
    //    Half resolution for performance; tuned for subtle volcanic glow
    const halfW = Math.floor(w * pixelRatio * 0.25);
    const halfH = Math.floor(h * pixelRatio * 0.25);
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(halfW, halfH),
      0.35,  // strength — subtle glow
      0.5,   // radius — medium spread
      0.8,   // threshold — only bright emissives bloom
    );
    this.composer.addPass(this._bloomPass);

    // 3. Output pass — applies tone mapping and color space conversion
    this.composer.addPass(new OutputPass());
  }

  _buildEnvironmentMap() {
    // Procedural env map: warm volcanic gradient for subtle reflections on car paint
    const pmremGen = new THREE.PMREMGenerator(this.renderer);
    pmremGen.compileEquirectangularShader();

    // Create a small scene with colored lights to bake into the env map
    const envScene = new THREE.Scene();
    // Warm volcanic ambient
    envScene.add(new THREE.AmbientLight(0x442211, 1.0));
    // Hot lava glow from below
    const lavaGlow = new THREE.PointLight(0xff4400, 2.0, 100);
    lavaGlow.position.set(0, -10, 0);
    envScene.add(lavaGlow);
    // Warm overhead
    const overhead = new THREE.DirectionalLight(0xffaa66, 0.8);
    overhead.position.set(0, 20, 0);
    envScene.add(overhead);
    // Cool fill
    const cool = new THREE.DirectionalLight(0x6688cc, 0.3);
    cool.position.set(-10, 5, -10);
    envScene.add(cool);
    // Dark backdrop sphere
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(50, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0x1a0a04, side: THREE.BackSide })
    ));

    const envMap = pmremGen.fromScene(envScene, 0, 0.1, 100).texture;
    this.scene.environment = envMap;
    pmremGen.dispose();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  update() {
    const elapsed = this._clock.getElapsedTime();
    this.arena.update(elapsed);
    this.composer.render();
  }
}
