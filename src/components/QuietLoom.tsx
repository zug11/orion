import ProceduralAtmosphere from "./ProceduralAtmosphere";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original Orion shader: a three-ribbon orbital weave with a turning half-twist.
// Analytic geometry and lighting, with no textures or downloaded shader code.
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

const float PI = 3.14159265;

vec2 turn(vec2 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

vec3 localPoint(vec3 p) {
  p.xz = turn(p.xz, 0.42 + sin(uTime * 0.13) * 0.22
    + (uPointer.x - 0.5) * uTouch * 0.32);
  p.yz = turn(p.yz, -0.4 + cos(uTime * 0.17) * 0.12
    + (uPointer.y - 0.5) * uTouch * 0.28);
  p.xy = turn(p.xy, -0.32 + uTime * 0.055);
  return p;
}

// A closed band makes three half-turns around an undulating orbital spine.
// The sign-invariant cross section closes at +/- PI, including while turning.
// Two narrow seams divide it into three ribbons without breaking the fold.
vec3 loomCoordinates(vec3 p) {
  float azimuth = atan(p.y, p.x);
  float phase = 3.0 * azimuth;
  float radius = 0.83 + 0.07 * cos(phase);
  float lift = 0.14 * sin(phase + uTime * 0.16);
  vec2 ribbon = turn(vec2(length(p.xy) - radius, p.z - lift),
    azimuth * 1.5 + 0.22 * sin(phase) + uTime * 0.12);
  return vec3(ribbon, azimuth);
}

float loomDistance(vec3 p) {
  vec3 weave = loomCoordinates(p);
  float width = 0.28 + 0.045 * cos(weave.z * 6.0);
  vec2 edge = abs(weave.xy) - vec2(width, 0.008);
  float band = length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0);
  float seam = 0.012 - abs(abs(weave.x) - width * 0.48);
  return max(band, seam);
}

vec3 loomNormal(vec3 p, float epsilon) {
  vec2 e = vec2(epsilon, 0.0);
  return normalize(vec3(
    loomDistance(p + e.xyy) - loomDistance(p - e.xyy),
    loomDistance(p + e.yxy) - loomDistance(p - e.yxy),
    loomDistance(p + e.yyx) - loomDistance(p - e.yyx)
  ));
}

float thread(float coordinate, float footprint) {
  float distanceToThread = abs(fract(coordinate + 0.5) - 0.5);
  return 1.0 - smoothstep(0.045, 0.045 + footprint, distanceToThread);
}

vec3 silkColor(float phase) {
  vec3 dye = mix(uPrimary, uSecondary, 0.5 + 0.5 * sin(phase));
  return mix(dye, uTertiary, pow(0.5 + 0.5 * cos(phase * 0.7 + 1.3), 3.0) * 0.65);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  vec2 screen = (uv - vec2(0.73, 0.52)) * vec2(aspect, 1.0) * 2.85;
  vec3 room = mix(uBackgroundSecondary, uBackground, uv.y);
  float halo = exp(-dot(screen, screen) * 1.2);
  vec3 color = mix(room, silkColor(screen.x + uTime * 0.06), halo * mix(0.095, 0.035, uLight));

  vec3 origin = localPoint(vec3(0.0, 0.0, 4.0));
  vec3 ray = localPoint(normalize(vec3(screen, -3.6)));
  // Intersect a bounding sphere first: most of the reading area does no marching.
  float projection = dot(origin, ray);
  float discriminant = projection * projection - dot(origin, origin) + 1.52 * 1.52;
  if (discriminant > 0.0) {
    float near = max(0.0, -projection - sqrt(discriminant));
    float far = -projection + sqrt(discriminant);
    float travel = near;
    float glow = 0.0;
    float hit = 0.0;
    float epsilon = max(0.0012, 0.65 / uResolution.y);
    vec3 point = origin + ray * travel;
    for (int step = 0; step < 96; step++) {
      point = origin + ray * travel;
      float distanceToLoom = loomDistance(point);
      glow += exp(-abs(distanceToLoom) * 34.0) * 0.012;
      if (distanceToLoom < epsilon) { hit = 1.0; break; }
      // Domain bending means this is a conservative distance estimate.
      travel += max(distanceToLoom * 0.56, epsilon * 0.5);
      if (travel > far) break;
    }

    if (hit > 0.5) {
      vec3 normal = loomNormal(point, epsilon);
      if (dot(normal, ray) > 0.0) normal = -normal;
      vec3 weave = loomCoordinates(point);
      vec3 keyLight = normalize(vec3(-0.5, 0.8, 1.4));
      vec3 fillLight = normalize(vec3(0.9, -0.4, 0.3));
      float facing = max(dot(normal, -ray), 0.0);
      float rim = pow(1.0 - facing, 2.4);
      float diffuse = max(dot(normal, keyLight), 0.0);
      float fill = max(dot(normal, fillLight), 0.0);
      float specular = pow(max(dot(normal, normalize(keyLight - ray)), 0.0), 42.0);
      float shadow = clamp(loomDistance(point + keyLight * 0.12) / 0.12, 0.55, 1.0);
      float phase = weave.z * 1.7 + weave.x * 4.0 + rim * 2.8 - uTime * 0.15;
      vec3 dye = silkColor(phase);
      // Screen-sized coverage keeps the fine weave stable on smaller canvases.
      float footprint = clamp(70.0 / (uResolution.y * max(facing, 0.22)), 0.06, 0.46);
      float warp = thread(weave.x * 78.0 + sin(weave.z * 6.0) * 0.16, footprint);
      float weft = thread(weave.z * 95.0 / PI, footprint);
      float crossing = warp * (0.78 + 0.22 * weft);
      float shuttle = pow(0.5 + 0.5 * sin(weave.z * 3.0 - uTime * 0.8), 18.0);
      float light = (0.48 + diffuse * 0.6 + fill * 0.28) * shadow;
      vec3 silk = dye * (light * (0.64 + crossing * 0.64) + rim * 0.85);
      silk += mix(dye, vec3(1.0), 0.65) * (specular * 0.8 + shuttle * crossing * 0.32);
      silk = mix(silk, dye * (0.42 + light * 0.36) + specular * 0.16, uLight * 0.6);
      float mist = smoothstep(4.0, 5.2, travel) * 0.45;
      color = mix(silk, room, mist);
    }
    vec3 glowColor = silkColor(atan(screen.y, screen.x) + uTime * 0.1);
    color = mix(color, glowColor, min(glow, 0.36) * mix(0.32, 0.08, uLight));
  }

  float edge = smoothstep(0.0, 0.12, uv.x)
    * (1.0 - smoothstep(0.94, 1.0, uv.x))
    * smoothstep(0.0, 0.08, uv.y)
    * (1.0 - smoothstep(0.92, 1.0, uv.y));
  gl_FragColor = vec4(mix(room, color, edge), 1.0);
}
`;

export default function QuietLoom(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="quiet-loom" />;
}
