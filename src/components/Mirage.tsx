import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original optical field: drifting soft-square lenses bend a travelling light
// sheet. Lens thickness separates its colours and catches a moving reflection.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  vec2 reach = (uv - uPointer) * aspect;
  float t = uTime * 1.25;
  float touch = exp(-dot(reach, reach) * 5.0) * uTouch;
  p += reach * touch * 0.12;
  vec2 grid = turn(p, -0.32) * vec2(3.5, 2.7);
  grid += vec2(t * 0.16, sin(t * 0.25) * 0.18);
  vec2 cell = floor(grid);
  vec2 local = fract(grid) - 0.5;
  vec2 square = local * local;
  float radius = pow(square.x * square.x + square.y * square.y, 0.25);
  float mask = 1.0 - smoothstep(0.43, 0.5, radius);
  float cap = sqrt(max(0.0, 1.0 - pow(radius * 2.0, 2.0)));
  vec3 normal = normalize(vec3(local * square * 9.0, cap + 0.14));
  vec2 refracted = p + normal.xy * mask * 0.28;
  float phase = refracted.x * 5.5 + refracted.y * 3.0
    + sin(refracted.x * 2.4 - t * 0.35) * 0.9 - t * 0.8;
  float beam = exp(-pow(sin(phase), 2.0) * 14.0);
  float afterimage = exp(-pow(sin(phase + cap * 0.65), 2.0) * 18.0);
  float rim = pow(1.0 - cap, 3.0) * mask;
  vec3 light = normalize(vec3(sin(t * 0.4) * 0.45, 0.6, 1.0));
  float reflection = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 64.0);
  vec3 dye = tint(phase * 0.45 + cap * 2.2 + cell.x * 0.12 + cell.y * 0.4);
  vec3 energy = dye * (0.04 + mask * 0.09 + beam * (0.12 + mask * 0.4));
  energy += tint(phase * 0.45 + cap * 3.1 + 1.0) * afterimage * mask * 0.22;
  energy += mix(dye, uTertiary, 0.6) * (rim * 0.55 + reflection * mask * 0.5);
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function Mirage(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return (
    <ProceduralAtmosphere
      {...props}
      fragmentSource={fragmentSource}
      className="mirage"
    />
  );
}
