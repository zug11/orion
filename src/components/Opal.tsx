import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original smooth optical ribbons. Analytic derivatives provide a continuous
// surface normal without textures, raymarching, or additional render passes.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = turn((uv - 0.5) * aspect, -0.34);
  vec2 reach = (uv - uPointer) * aspect;
  float touch = exp(-dot(reach, reach) * 3.5) * uTouch;
  p += reach * touch * 0.09;
  float t = uTime * 0.55;
  float curve = sin(p.y * 3.0 + t * 0.34);
  float phase = p.x * 18.0 + curve * 1.1 + sin(p.y * 1.4 - t * 0.18) * 0.6 - t * 0.33;
  float crest = 0.5 + 0.5 * cos(phase);
  float slope = -sin(phase) * 0.7;
  float dy = cos(p.y * 3.0 + t * 0.34) * 0.38 + cos(p.y * 1.4 - t * 0.18) * 0.1;
  vec3 normal = normalize(vec3(slope, slope * dy, 0.65 + crest * 0.6));
  vec3 light = normalize(vec3(-0.35 + sin(t * 0.32) * 0.2, 0.62, 1.0));
  float diffuse = max(dot(normal, light), 0.0);
  float reflection = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 60.0);
  float fresnel = pow(1.0 - normal.z, 2.0);
  float sheet = p.y * 2.0 + normal.x * 1.5 + t * 0.22;
  float caustic = exp(-pow(sin(sheet + phase * 0.11), 2.0) * 28.0);
  vec3 dye = tint(phase * 0.13 + normal.x * 2.7 + p.y * 0.75 + t * 0.17);
  vec3 edgeDye = tint(phase * 0.13 + normal.x * 2.7 + p.y * 0.75 + t * 0.17 + 1.4);
  float seam = pow(1.0 - crest, 5.0);
  float edgeWidth = 5.0 / uResolution.y;
  float ribbonMask = smoothstep(0.065 - edgeWidth, 0.065 + edgeWidth, crest);
  if (uLight > 0.5) {
    gl_FragColor = finishDaylightSurface(uv, mix(dye, edgeDye, fresnel),
      diffuse * 0.88 - seam * 0.2, reflection * 0.95 + caustic * 0.3, ribbonMask * (0.78 + crest * 0.16));
  } else {
    vec3 energy = dye * (0.045 + diffuse * 0.14 + crest * 0.07);
    energy += mix(dye, edgeDye, 0.65) * (reflection * 0.95 + fresnel * 0.6 + caustic * 0.18);
    energy *= ribbonMask * (1.0 - seam * 0.45);
    gl_FragColor = finishAtmosphere(uv, energy);
  }
}
`;

export default function Opal(props: { palette: AtmospherePalette; motion: HomeAtmosphereMotion }) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="opal" />;
}
