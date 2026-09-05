import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Seven translucent depth slices bend through one evolving, trigonometric
// cloud field. Stars follow a separate slow parallax plane behind the clouds.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  float t = uTime * 0.95;
  vec3 energy = tint(p.x * 0.8 + p.y) * 0.04;
  float through = 1.0;
  for (int layer = 0; layer < 7; layer++) {
    float z = float(layer) / 3.0 - 1.0;
    vec3 q = vec3(p * (2.4 + z * 0.24), z);
    q.xy += (uPointer - 0.5) * uTouch * (0.13 + z * 0.05);
    q.xy = turn(q.xy, z * 0.18 + t * 0.06);
    q += sin(q.yzx * 1.75 + vec3(t * 0.4, -t * 0.32, t * 0.28)) * 0.44;
    q += sin(q.zxy * 3.3 - t * 0.55) * 0.17;
    float field = sin(q.x * 1.4 + sin(q.z * 2.0))
      + cos(q.y * 1.85 - q.z * 0.7) + sin(q.z * 1.7 + q.x * 0.65);
    float cloud = exp(-field * field * 3.8);
    float detail = pow(0.5 + 0.5 * sin(q.x * 7.0 + q.y * 9.0 + sin(q.z * 4.0) + t), 3.0);
    float density = cloud * (0.36 + detail * 0.64);
    vec3 dye = tint(q.x * 0.7 + q.y * 0.9 + z * 1.8 - t * 0.18);
    energy += through * dye * density * 0.34;
    through *= 1.0 - density * 0.2;
  }
  vec2 sky = (uv * aspect + vec2(t * 0.002, -t * 0.001)) * 62.0;
  vec2 cell = mod(floor(sky), 103.0);
  float seed = mod(mod(cell.x * cell.x, 103.0) * 3.0 + cell.y * 19.0
    + mod(cell.x * cell.y, 103.0) * 7.0, 103.0) / 103.0;
  vec2 starPosition = vec2(0.2 + seed * 0.6, 0.25 + fract(seed * 7.0) * 0.5);
  vec2 starDistance = fract(sky) - starPosition;
  float star = exp(-dot(starDistance, starDistance) * 180.0) * step(0.9, seed);
  star *= 0.5 + 0.5 * pow(0.5 + 0.5 * sin(t * 1.6 + seed * 17.0), 3.0);
  energy += mix(uPrimary, vec3(1.0), 0.6) * star * (0.15 + through * 0.65);
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function Nebula(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="nebula" />;
}
