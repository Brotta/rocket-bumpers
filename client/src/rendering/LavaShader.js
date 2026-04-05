/**
 * LavaShader — custom ShaderMaterial for animated lava surface.
 *
 * Features:
 *   - Procedural FBM noise distortion on UV coordinates (flowing lava)
 *   - Two-layer noise for turbulent surface detail
 *   - Color gradient from dark crust → hot orange → bright yellow
 *   - Animated emissive glow with pulsing intensity
 *   - All computation in the fragment shader (no JS per-frame texture updates)
 *
 * Performance: single draw call, no texture uploads per frame — just one
 * uniform float (uTime) updated each frame.
 */

import * as THREE from 'three';

const lavaVertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const lavaFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uEmissiveBoost;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  // ── Simplex-style noise (hash-based, GPU-friendly) ──
  vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)),
             dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = dot(hash22(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // ── Fractal Brownian Motion (3 octaves — balanced quality/performance) ──
  float fbm(vec2 p) {
    float value = 0.0;
    float amp = 0.5;
    value += amp * noise2(p);       amp *= 0.5;
    value += amp * noise2(p * 2.0); amp *= 0.5;
    value += amp * noise2(p * 4.0);
    return value;
  }

  void main() {
    // Use world XZ for scale-independent coordinates
    vec2 uv = vWorldPos.xz * 0.12;

    // ── Layer 1: slow large-scale flow ──
    vec2 flow1 = vec2(uTime * 0.04, uTime * 0.03);
    float n1 = fbm(uv * 1.5 + flow1);

    // ── Layer 2: faster turbulent detail (distorted by layer 1) ──
    vec2 flow2 = vec2(-uTime * 0.06, uTime * 0.05);
    vec2 distorted = uv * 3.0 + vec2(n1 * 0.8) + flow2;
    float n2 = fbm(distorted);

    // ── Combined heat value (0 = cool crust, 1 = hot vein) ──
    float heat = n1 * 0.45 + n2 * 0.55;
    heat = heat * 0.5 + 0.5; // remap from [-0.5,0.5] to [0,1]
    heat = clamp(heat, 0.0, 1.0);

    // ── Sharpen: push toward extremes for more visible crust/vein contrast ──
    heat = smoothstep(0.25, 0.75, heat);

    // ── Color ramp: dark crust → orange → bright yellow ──
    vec3 coolColor  = vec3(0.22, 0.04, 0.0);   // dark volcanic crust
    vec3 warmColor  = vec3(0.85, 0.25, 0.02);   // hot orange
    vec3 hotColor   = vec3(1.0, 0.75, 0.15);     // bright yellow-white

    vec3 color;
    if (heat < 0.5) {
      color = mix(coolColor, warmColor, heat * 2.0);
    } else {
      color = mix(warmColor, hotColor, (heat - 0.5) * 2.0);
    }

    // ── Emissive glow: hot areas glow, cool areas are dim ──
    float emissive = heat * heat * (1.5 + uEmissiveBoost);

    // ── Subtle pulse on the hottest veins ──
    float pulse = 0.9 + 0.1 * sin(uTime * 2.5 + n1 * 6.28);
    emissive *= pulse;

    // Output: color * emissive (pre-multiplied for bloom pickup)
    gl_FragColor = vec4(color * emissive, 1.0);
  }
`;

/**
 * Create the lava ShaderMaterial.
 * Call material.uniforms.uTime.value = elapsed each frame to animate.
 */
export function createLavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEmissiveBoost: { value: 0 }, // extra glow during eruption warning
    },
    vertexShader: lavaVertexShader,
    fragmentShader: lavaFragmentShader,
    side: THREE.FrontSide,
    depthWrite: true,
  });
}
