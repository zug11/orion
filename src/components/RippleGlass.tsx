import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original intersecting lens waves: two slow optical wavefronts refract the
// same light sheet, with analytic gradients and a bounded single draw pass.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  float t = uTime * 0.48;
  vec2 centreA = vec2(aspect.x * 0.22 + sin(t * 0.3) * 0.09, -0.16);
  vec2 centreB = vec2(-aspect.x * 0.38, 0.28 + cos(t * 0.22) * 0.08);
  vec2 a = p - centreA;
  vec2 b = p - centreB;
  float ra = max(length(a), 0.001);
  float rb = max(length(b), 0.001);
  float phaseA = ra * 28.0 - t;
  float phaseB = rb * 12.0 + t * 0.52;
  vec2 gradient = a / ra * cos(phaseA) * 0.66 + b / rb * cos(phaseB) * 0.28;
  vec2 reach = (uv - uPointer) * aspect;
  gradient += reach * exp(-dot(reach, reach) * 6.0) * uTouch * 0.8;
  vec3 normal = normalize(vec3(gradient, 1.1));
  vec2 refraction = p + gradient * 0.1;
  float sheet = refraction.x * 3.0 + refraction.y * 2.0 + t * 0.25;
  float beam = exp(-pow(sin(sheet), 2.0) * 30.0);
  float splitBeam = exp(-pow(sin(sheet + normal.x * 0.35), 2.0) * 36.0);
  float crest = 0.5 + 0.5 * sin(phaseA);
  float ridge = pow(crest, 6.0);
  float edgeWidth = 5.0 / uResolution.y;
  float lensMask = smoothstep(0.075 - edgeWidth, 0.075 + edgeWidth, crest);
  vec3 light = normalize(vec3(0.4 + sin(t * 0.2) * 0.18, 0.6, 1.0));
  float diffuse = max(dot(normal, light), 0.0);
  float reflection = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 80.0);
  float fresnel = pow(1.0 - normal.z, 2.0);
  vec3 dye = tint(ra * 1.9 - rb * 1.4 + normal.x * 2.5 + t * 0.13);
  vec3 fringe = tint(ra * 1.9 - rb * 1.4 + normal.x * 2.5 + t * 0.13 + 1.3);
  if (uLight > 0.5) {
    gl_FragColor = finishDaylightSurface(uv, mix(dye, fringe, ridge * 0.35),
      diffuse * 0.88 - ridge * 0.12, reflection + splitBeam * 0.24 + ridge * 0.12, lensMask * 0.9);
  } else {
    vec3 energy = dye * (0.03 + diffuse * 0.075 + beam * 0.32);
    energy += fringe * (splitBeam * 0.22 + reflection * 0.85 + fresnel * 0.8 + ridge * 0.08);
    gl_FragColor = finishAtmosphere(uv, energy * lensMask);
  }
}
`;

export default function RippleGlass(props: { palette: AtmospherePalette; motion: HomeAtmosphereMotion }) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="ripple-glass" />;
}
