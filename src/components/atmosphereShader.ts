// Shared plumbing for Orion's original procedural atmospheres. These shaders
// use only local mathematics and the active room palette, with no image inputs.
export const atmosphereShader = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uPointer;
uniform float uTouch;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uTertiary;
uniform vec3 uBackground;
uniform vec3 uBackgroundSecondary;
uniform float uLight;

vec2 turn(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

vec3 tint(float phase) {
  vec3 dye = mix(uPrimary, uSecondary, 0.5 + 0.5 * sin(phase));
  dye = mix(dye, uTertiary, pow(0.5 + 0.5 * cos(phase * 0.73 + 1.2), 3.0) * 0.65);
  return mix(dye * dye, dye, uLight);
}

vec3 roomAt(vec2 uv) {
  return mix(uBackgroundSecondary, uBackground, uv.y);
}

vec4 finishAtmosphere(vec2 uv, vec3 energy) {
  vec3 room = roomAt(uv);
  energy = max(energy, vec3(0.0));
  vec3 radiance = 1.0 - exp(-energy * 1.5);
  float ink = 1.0 - exp(-length(energy) * 1.4);
  vec3 pigment = energy / (0.6 + length(energy));
  vec3 lightRoom = mix(room, pigment, ink * 0.76);
  vec3 color = mix(room + radiance, lightRoom, uLight);
  // Only the outer few pixels soften; the artwork fills the entire backdrop.
  float edge = smoothstep(0.0, 0.025, uv.x)
    * (1.0 - smoothstep(0.975, 1.0, uv.x))
    * smoothstep(0.0, 0.035, uv.y)
    * (1.0 - smoothstep(0.965, 1.0, uv.y));
  return vec4(mix(room, color, edge), 1.0);
}
`;
