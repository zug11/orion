import ProceduralAtmosphere from "./ProceduralAtmosphere";
import { atmosphereShader } from "./atmosphereShader";
import type { AtmospherePalette } from "../lib/homeAtmosphere";
import type { HomeAtmosphereMotion } from "../types";

// Original particle advection: three depth planes share a curved wind field.
// Bounded cell arithmetic places each spark; its wake is an analytic light trail.
const fragmentSource = atmosphereShader + `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  vec2 reach = (uv - uPointer) * aspect;
  float touch = exp(-dot(reach, reach) * 4.0) * uTouch;
  float t = uTime * 1.5;
  p = turn(p, -0.17);
  p.y += sin(p.x * 2.5 - t * 0.25) * 0.16
    + sin(p.x * 5.0 + t * 0.4) * 0.055 + touch * reach.x * 0.16;
  vec3 energy = tint(p.x - t * 0.12) * 0.024;

  for (int plane = 0; plane < 3; plane++) {
    float k = float(plane);
    vec2 grid = p * vec2(6.0 + k * 2.0, 24.0 + k * 9.0);
    grid.y += k * 0.37;
    float row = mod(floor(grid.y), 97.0);
    float rowSeed = mod(mod(row * row, 97.0) * 7.0 + row * 13.0, 97.0) / 97.0;
    grid.x -= t * (0.9 + rowSeed * 1.5 + k * 0.3);
    float column = mod(floor(grid.x), 89.0);
    float seed = mod(column * 23.0 + row * 17.0 + k * 11.0, 89.0) / 89.0;
    vec2 d = fract(grid) - vec2(0.74, 0.18 + seed * 0.64);
    float head = exp(-d.x * d.x * 1300.0 - d.y * d.y * 155.0);
    float trail = exp(-d.y * d.y * 220.0) * exp(-abs(d.x) * 5.0)
      * (1.0 - smoothstep(-0.02, 0.025, d.x));
    float halo = exp(-d.x * d.x * 42.0 - d.y * d.y * 34.0);
    float presence = smoothstep(0.25, 0.65, seed);
    float flicker = 0.72 + 0.28 * sin(t * 2.0 + seed * 21.0);
    vec3 dye = tint(seed * 5.0 + rowSeed * 2.0 + p.x * 0.5);
    vec3 hot = mix(dye, mix(uTertiary, vec3(1.0), 0.55), 0.6);
    energy += (hot * head * 0.95 + dye * (trail * 0.62 + halo * 0.075))
      * presence * flicker / (1.0 + k * 0.42);
  }

  float wake = exp(-pow(sin(p.y * 8.0 + sin(p.x * 1.8 + t * 0.2)), 2.0) * 45.0);
  energy += tint(p.x * 0.7 + p.y * 3.0) * wake * 0.075;
  gl_FragColor = finishAtmosphere(uv, energy);
}
`;

export default function Emberwake(props: {
  palette: AtmospherePalette;
  motion: HomeAtmosphereMotion;
}) {
  return (
    <ProceduralAtmosphere
      {...props}
      fragmentSource={fragmentSource}
      className="emberwake"
    />
  );
}
