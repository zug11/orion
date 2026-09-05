import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// A continuous height field is folded into exact triangular planes. Lighting
// follows each plane's normal as the whole crystalline surface rolls past.
const fragmentSource = atmosphereShader + `
float heightAt(vec2 p, float t) {
  return sin(p.x * 0.74 + p.y * 0.49 + t * 0.8) * 0.65
    + cos(p.y * 1.11 - p.x * 0.38 - t * 0.7) * 0.38
    + sin(p.x * 1.7 + p.y * 1.5 + t * 0.45) * 0.16;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  float t = uTime * 1.1;
  vec2 p = turn((uv - 0.5) * aspect, -0.32) * 8.0;
  p += vec2(t * 0.22, -t * 0.13) + (uPointer - 0.5) * uTouch * 0.4;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float upper = step(1.0, f.x + f.y);
  vec2 a = cell + vec2(upper);
  vec2 b = cell + vec2(1.0 - upper, upper);
  vec2 c = cell + vec2(upper, 1.0 - upper);
  vec3 heights = vec3(heightAt(a, t), heightAt(b, t), heightAt(c, t));
  vec3 barycentric = mix(vec3(1.0 - f.x - f.y, f.x, f.y),
    vec3(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y), upper);
  float height = dot(heights, barycentric);
  vec2 slope = (heights.yz - heights.xx) * (1.0 - upper * 2.0);
  vec3 normal = normalize(vec3(-slope * 1.5, 1.0));
  vec3 light = normalize(vec3(sin(t * 0.3) * 0.5, 0.7, 1.0));
  float diffuse = max(dot(normal, light), 0.0);
  float reflection = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);
  float edgeDistance = min(barycentric.x, min(barycentric.y, barycentric.z));
  float edge = 1.0 - smoothstep(0.0, max(0.008, 5.0 / uResolution.y), edgeDistance);
  float glint = pow(0.5 + 0.5 * sin(height * 3.0 + p.x * 0.65 - t * 1.5), 12.0);
  vec3 dye = tint(height * 2.3 + cell.x * 0.25 + cell.y * 0.18);
  vec3 energy = dye * (0.06 + diffuse * 0.31 + reflection * 0.64);
  energy += mix(dye, uTertiary, 0.5) * edge * (0.12 + glint * 0.7);
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function PrismDrift(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return <ProceduralAtmosphere {...props} fragmentSource={fragmentSource} className="prism-drift" />;
}
