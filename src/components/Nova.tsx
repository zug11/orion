import ProceduralAtmosphere from "./ProceduralAtmosphere";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original Orion volume: a breathing stellar core feeds a rotating, corrugated
// plasma mantle. Light is integrated through that field, with polar spark
// streams outside it. Every shape is generated here from elementary functions.
const fragmentSource = `
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

const float TAU = 6.2831853;

vec2 turn(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

vec3 spectrum(float phase) {
  vec3 dye = mix(uPrimary, uSecondary, 0.5 + 0.5 * sin(phase));
  dye = mix(dye, uTertiary, pow(0.5 + 0.5 * sin(phase + 2.1), 3.0) * 0.8);
  return mix(dye * dye, dye, uLight);
}

float sparks(vec2 p, float time) {
  float r = length(p);
  float angle = atan(p.y, p.x) / TAU + 0.5;
  // Integer cell arithmetic distributes sparks without a noise texture or hash library.
  float lane = floor(angle * 96.0);
  float seed = mod(mod(lane * lane, 101.0) * 13.0 + lane * 7.0, 101.0) / 101.0;
  float radius = 0.38 + fract(seed + time * (0.12 + seed * 0.1)) * 1.75;
  float angular = (fract(angle * 96.0) - 0.5) * r * TAU / 96.0;
  float radial = r - radius;
  float spark = exp(-angular * angular * 240000.0 - radial * radial * 1200.0);
  float tail = exp(-angular * angular * 320000.0 - radial * radial * 95.0)
    * step(radial, 0.0) * 0.22;
  return (spark + tail) * smoothstep(0.48, 0.8, r)
    * (1.0 - smoothstep(1.4, 2.1, r)) * (0.35 + seed * 0.65);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (uv - vec2(0.73, 0.54)) * vec2(aspect, 1.0) * 3.3;
  vec2 pointer = (uPointer - vec2(0.73, 0.54)) * vec2(aspect, 1.0);
  p -= pointer * uTouch * 0.16;
  float t = uTime * 1.8;
  float pulse = 0.5 + 0.5 * sin(t * 1.7);
  vec3 room = mix(uBackgroundSecondary, uBackground, uv.y);
  float r = length(p);
  vec3 energy = spectrum(r * 2.3 - t * 0.24) * exp(-r * r * 0.9) * 0.11;

  vec3 origin = vec3(0.0, 0.0, 3.8);
  vec3 ray = normalize(vec3(p, -3.5));
  float projection = dot(origin, ray);
  float discriminant = projection * projection - dot(origin, origin) + 1.48 * 1.48;
  if (discriminant > 0.0) {
    float entry = -projection - sqrt(discriminant);
    float path = 2.0 * sqrt(discriminant);
    float stepLength = path / 48.0;
    float transmission = 1.0;
    for (int sampleIndex = 0; sampleIndex < 48; sampleIndex++) {
      vec3 q = origin + ray * (entry + (float(sampleIndex) + 0.5) * stepLength);
      q.yz = turn(q.yz, 0.46 + sin(t * 0.17) * 0.16);
      q.xz = turn(q.xz, t * 0.18 + pointer.x * uTouch * 0.3);
      q.xy = turn(q.xy, t * 0.08);
      float radius = length(q);
      float latitude = q.y / max(radius, 0.01);
      float angle = atan(q.z, q.x);

      // Broad folds and small traveling crests evolve at different rates.
      float fold = sin(angle * 5.0 + latitude * 5.0 - t * 1.2)
        + 0.45 * sin(angle * 9.0 - latitude * 8.0 + t * 0.7);
      float mantle = 0.78 + 0.14 * fold + 0.045 * sin(t * 1.7);
      float shell = exp(-pow((radius - mantle) * 10.0, 2.0));
      float current = angle * 8.0 + radius * 19.0 + latitude * 8.0 - t * 2.5;
      current += sin(latitude * 11.0 + angle * 3.0 + t) * 1.4;
      float filament = pow(0.5 + 0.5 * sin(current), 10.0);
      float lace = pow(0.5 + 0.5 * sin(angle * 17.0 - latitude * 13.0 + t * 1.5), 5.0);
      float density = shell * (0.16 + filament * 1.8 + lace * 0.25);
      float core = exp(-radius * radius * (24.0 - pulse * 4.0));
      vec3 dye = spectrum(angle * 0.8 + latitude * 1.6 + radius * 2.0 - t * 0.2);
      vec3 hot = mix(uTertiary, vec3(1.0, 0.97, 0.91), 0.65);
      energy += transmission * (dye * density * 2.8 + hot * core * 5.0) * stepLength;
      transmission *= exp(-density * stepLength * 1.7);
    }
  }

  vec2 orbit = turn(p, t * 0.07 + r * 0.65);
  float stars = sparks(orbit, t);
  energy += mix(uPrimary, vec3(1.0), 0.6) * stars * 0.95;
  // A soft corona and a thin drifting equatorial flare connect the volume to the room.
  vec2 flare = turn(p, -0.28 + sin(t * 0.18) * 0.06);
  float rayGlow = exp(-abs(flare.y) * 24.0) * exp(-abs(flare.x) * 1.7);
  energy += spectrum(t * 0.12) * rayGlow * (0.18 + pulse * 0.1);
  vec3 radiance = 1.0 - exp(-energy * 1.6);
  float ink = 1.0 - exp(-length(energy) * 0.65);
  vec3 lightRoom = mix(room, spectrum(r - t * 0.12), ink * 0.84);
  vec3 color = mix(room + radiance, lightRoom, uLight);
  float edge = smoothstep(0.0, 0.12, uv.x)
    * (1.0 - smoothstep(0.93, 1.0, uv.x))
    * smoothstep(0.0, 0.08, uv.y)
    * (1.0 - smoothstep(0.92, 1.0, uv.y));
  gl_FragColor = vec4(mix(room, color, edge), 1.0);
}
`;

export default function Nova(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="nova" />;
}
