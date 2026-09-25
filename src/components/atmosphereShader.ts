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

vec4 finishEdges(vec2 uv, vec3 color) {
  float edge = smoothstep(0.0, 0.025, uv.x)
    * (1.0 - smoothstep(0.975, 1.0, uv.x))
    * smoothstep(0.0, 0.035, uv.y)
    * (1.0 - smoothstep(0.965, 1.0, uv.y));
  return vec4(mix(roomAt(uv), color, edge), 1.0);
}

vec4 finishAtmosphere(vec2 uv, vec3 energy) {
  vec3 room = roomAt(uv);
  energy = max(energy, vec3(0.0));
  vec3 radiance = 1.0 - exp(-energy * 1.5);
  float strength = length(energy);
  float coverage = 1.0 - exp(-strength * 3.8);
  vec3 hue = energy / max(max(energy.r, max(energy.g, energy.b)), 0.001);
  // Daylight emission reads as coloured ink in the room, with controlled
  // midtones instead of inverse glow or an additive white wash.
  vec3 pigment = mix(room * 0.7, hue * 0.66, 0.68);
  vec3 lightRoom = mix(room, pigment, coverage * 0.88);
  vec3 color = mix(room + radiance, lightRoom, uLight);
  return finishEdges(uv, color);
}

// Surface shaders have real normals: keep diffuse shadows and specular light
// separate. A highlight must brighten a lens/fold, never turn into dark ink.
vec4 finishDaylightSurface(vec2 uv, vec3 dye, float diffuse, float specular, float coverage) {
  vec3 room = roomAt(uv);
  vec3 pigment = mix(room, dye, 0.58);
  vec3 surface = pigment * (0.7 + clamp(diffuse, 0.0, 1.0) * 0.28);
  surface = mix(surface, mix(room, vec3(1.0), 0.16), clamp(specular, 0.0, 1.0) * 0.28);
  return finishEdges(uv, mix(room, surface, clamp(coverage, 0.0, 1.0)));
}
`;
