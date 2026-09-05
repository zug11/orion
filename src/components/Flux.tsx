import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Six currents share a bending channel, but their crests travel independently.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  vec2 reach = (uv - uPointer) * aspect;
  float touch = exp(-dot(reach, reach) * 4.0) * uTouch;
  float t = uTime * 1.3;
  p.y += touch * 0.1 * sin(p.x * 3.0 + t);
  p = turn(p, -0.18);
  vec3 energy = tint(p.x - p.y + t * 0.12) * 0.035;
  float through = 1.0;
  for (int strand = 0; strand < 6; strand++) {
    float k = float(strand);
    float spine = -0.56 + k * 0.22
      + sin(p.x * 3.1 + t * 0.7 + k * 1.6) * 0.17
      + sin(p.x * 6.4 - t * 1.1 + k * 0.9) * 0.06;
    float offset = p.y - spine;
    float width = 0.044 + 0.015 * sin(p.x * 2.4 + k - t * 0.4);
    float sheet = exp(-offset * offset / (width * width * 2.0));
    float filament = pow(0.5 + 0.5 * cos(offset * 260.0 + sin(p.x * 5.0 + t) * 3.0), 9.0);
    float crest = exp(-offset * offset / 0.00025);
    float pulse = pow(0.5 + 0.5 * cos(p.x * 7.5 - t * 3.3 + k * 2.1), 10.0);
    float haze = exp(-offset * offset / 0.022);
    vec3 dye = tint(k * 1.12 + p.x * 1.4 - t * 0.16);
    energy += through * dye * (sheet * (0.14 + filament * 0.66)
      + crest * (0.22 + pulse * 0.7) + haze * 0.055);
    through *= 1.0 - sheet * 0.12;
  }
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function Flux(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="flux" />;
}
