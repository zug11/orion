import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original continuous fabric surface. Differentiating the moving folds gives
// their normals, so broad satin highlights follow the billow rather than a mask.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = turn((uv - 0.5) * aspect, -0.42) * 4.5;
  vec2 reach = (uv - uPointer) * aspect;
  float touch = exp(-dot(reach, reach) * 5.0) * uTouch;
  float t = uTime * 1.15;
  p += reach * touch * 0.65;
  float phase = p.x * 1.7 + sin(p.y * 1.3 + t * 0.55) * 1.2
    + sin(p.y * 3.1 - t * 0.3) * 0.36 + t * 0.5;
  float crossPhase = p.y * 2.8 - p.x * 0.65 - t * 0.7;
  float dy = cos(p.y * 1.3 + t * 0.55) * 1.56
    + cos(p.y * 3.1 - t * 0.3) * 1.116;
  float slope = cos(phase) * 0.48 + cos(phase * 3.0) * 0.18;
  vec2 gradient = vec2(slope * 1.7, slope * dy)
    + cos(crossPhase) * vec2(-0.052, 0.224);
  vec3 normal = normalize(vec3(-gradient, 1.0));
  vec3 light = normalize(vec3(-0.6, 0.8, 1.3));
  float diffuse = max(dot(normal, light), 0.0);
  float sheen = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 48.0);
  float rim = pow(1.0 - normal.z, 2.4);
  float height = sin(phase) * 0.48 + sin(phase * 3.0) * 0.06 + sin(crossPhase) * 0.08;
  float threads = pow(0.5 + 0.5 * cos(phase * 65.0 + crossPhase * 0.4), 10.0);
  // Fade subpixel fibres on grazing folds while keeping the satin highlights.
  float threadDetail = 1.0 - smoothstep(0.22, 0.65, 150.0 / uResolution.y);
  vec3 dye = tint(phase * 0.5 + height * 2.0 + p.y * 0.18);
  vec3 energy = dye * (0.07 + diffuse * 0.32 + rim * 1.25
    + threads * threadDetail * (0.04 + sheen * 0.12));
  energy += mix(dye, uTertiary, 0.4) * sheen * 0.85;
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function GravitySilk(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return (
    <ProceduralAtmosphere
      {...props}
      fragmentSource={fragmentSource}
      className="gravity-silk"
    />
  );
}
