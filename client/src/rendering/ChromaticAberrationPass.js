import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * ChromaticAberrationPass — RGB channel split for impact effects.
 *
 * Usage:
 *   const pass = createChromaticAberrationPass();
 *   composer.insertPass(pass, composerPassIndex);
 *   // Trigger pulse:
 *   pass.uniforms.strength.value = 0.008;
 *   // Decay in update loop:
 *   pass.uniforms.strength.value *= 0.9;
 */

const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - vec2(0.5);
      float dist = length(dir);
      vec2 offset = dir * strength * dist;
      float r = texture2D(tDiffuse, vUv + offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - offset).b;
      float a = texture2D(tDiffuse, vUv).a;
      gl_FragColor = vec4(r, g, b, a);
    }
  `,
};

export function createChromaticAberrationPass() {
  return new ShaderPass(ChromaticAberrationShader);
}
