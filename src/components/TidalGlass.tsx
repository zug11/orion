import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Moving wave curvature defines a lens Jacobian. Its near-zero determinant
// draws the caustic network; three nearby focus planes split its coloured edges.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect * 5.5;
  vec2 reach = (uv - uPointer) * aspect;
  float t = uTime * 1.2;
  p += reach * exp(-dot(reach, reach) * 5.0) * uTouch * 1.7;
  p += vec2(sin(p.y * 0.9 + t * 0.5), cos(p.x * 0.8 - t * 0.4)) * 0.44;
  vec3 curvature = vec3(0.0);
  float depth = 0.0;
  for (int wave = 0; wave < 6; wave++) {
    float k = float(wave);
    float angle = k * 2.17 + 0.3;
    vec2 direction = vec2(cos(angle), sin(angle));
    float phase = dot(p, direction) * (1.55 + k * 0.22)
      + t * (0.5 + k * 0.13) + k * 1.4;
    float bend = cos(phase) * (0.54 + k * 0.025);
    curvature += bend * vec3(direction.x * direction.x,
      direction.x * direction.y, direction.y * direction.y);
    depth += sin(phase) * 0.16;
  }
  float lens = (1.0 + curvature.x) * (1.0 + curvature.z)
    - curvature.y * curvature.y;
  vec3 focus = exp(-abs(vec3(lens - 0.085, lens, lens + 0.085)) * 26.0);
  float penumbra = exp(-abs(lens) * 3.2);
  vec3 energy = tint(depth * 2.0 + p.x * 0.12) * (0.055 + penumbra * 0.15);
  energy += uPrimary * uPrimary * focus.x * 0.62
    + uSecondary * uSecondary * focus.y * 0.55
    + uTertiary * uTertiary * focus.z * 0.32;
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function TidalGlass(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="tidal-glass" />;
}
