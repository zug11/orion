// Original bounded volume studies. ES 1.00: fixed loop bounds, no textures.
// All positions live inside the actual refracted sphere chord. `frame` turns
// both the entry position and ray through depth; t is the only motion clock.

float volSat(float x) { return clamp(x, 0.0, 1.0); }

vec3 volRay(vec3 n, float eta) {
  return refract(vec3(0.0, 0.0, -1.0), n, eta);
}

vec3 volBack(vec3 p, vec3 ray, float span, float t, float tint) {
  vec3 end = p + ray * span;
  vec3 outgoing = refract(ray, -normalize(end), 1.22);
  if (dot(outgoing, outgoing) < 0.001) outgoing = reflect(ray, -normalize(end));
  return uBackground * 0.16 + dye(tint) * 0.028
       + env(normalize(outgoing), t) * 0.065;
}

float volCloud(vec3 q) {
  // Low-frequency billows, with holes separating the three broad masses.
  vec3 bend = q + 0.16 * vec3(sin(q.y * 3.2 + q.z),
                             sin(q.z * 3.7 - q.x),
                             sin(q.x * 2.8 + q.y));
  float clouds = fbm(bend * 3.5 + vec3(2.7, 8.1, 1.9));
  float envelope = 1.0 - smoothstep(0.56, 0.91, length(q * vec3(1.0, 1.12, 1.0)));
  float lobes = 0.045 * sin(q.x * 6.0 + q.y * 2.1) + 0.055 * q.y;
  return smoothstep(0.40, 0.72, clouds + lobes) * envelope;
}

// 06 / Cloud chamber: silver-blue cumulus illuminated through clear glass.
vec3 material6(vec3 p, vec3 n, float t) {
  vec3 ray = volRay(n, 0.84);
  float span = max(0.0, -2.0 * dot(p, ray));
  float count = mix(12.0, 24.0, step(0.5, uDetail));
  float ds = span / count;
  vec3 origin = frame(p, t * 0.74 + 1.2);
  vec3 direction = frame(ray, t * 0.74 + 1.2);
  vec3 lightDir = normalize(vec3(-0.55, 0.8, 0.5));
  vec3 col = vec3(0.0);
  float transmission = 1.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= count) break;
    vec3 q = origin + direction * ((float(i) + 0.5) * ds);
    float density = volCloud(q);
    float ahead = volCloud(q + lightDir * 0.14);
    float direct = volSat(0.42 + (density - ahead) * 1.85);
    float depth = volSat(0.48 + q.z * 0.45);
    vec3 cloudColour = dye(volSat(0.93 - direct * 0.62 + q.x * 0.13));
    // Keep scattering below display white after the shared tone curve; the
    // brightest billows retain their blue contour and internal density detail.
    vec3 glow = mix(cloudColour, uPrimary, direct * 0.10)
              * (0.24 + direct * 0.78 + depth * 0.12);
    float alpha = 1.0 - exp(-density * ds * (2.0 + 4.4 * uAmount));
    col += transmission * alpha * glow;
    transmission *= 1.0 - alpha;
  }
  col += transmission * volBack(p, ray, span, t, 0.78);
  col += skin(n, t) * (0.66 + uGloss * 0.35);
  return col;
}

vec3 volCellCentre(float k, float t) {
  // A tilted, irregular constellation. Each body changes its depth as the
  // coordinate frame turns, rather than sliding on a two-dimensional disk.
  float az = k * 2.399963;
  float y = -0.59 + k * 0.19;
  float ring = sqrt(max(0.08, 0.68 * 0.68 - y * y));
  vec3 c = vec3(cos(az) * ring, y, sin(az) * ring);
  c += 0.055 * vec3(sin(t * 0.23 + k * 1.8),
                    sin(t * 0.19 + k * 2.7),
                    cos(t * 0.21 + k * 1.3));
  return c;
}

// 07 / Biolume: seven luminous living cells, with membranes and bright nuclei.
// Analytic ellipsoid integration avoids a nested seven-cell ray march.
vec3 material7(vec3 p, vec3 n, float t) {
  vec3 ray = volRay(n, 0.79);
  float span = max(0.0, -2.0 * dot(p, ray));
  vec3 origin = frame(p, t * 0.82 + 2.1);
  vec3 direction = frame(ray, t * 0.82 + 2.1);
  vec3 emitted = vec3(0.0);
  float haze = 0.0;
  for (int i = 0; i < 7; i++) {
    float k = float(i);
    vec3 centre = volCellCentre(k, t);
    float radius = (0.117 + 0.026 * sin(k * 2.7 + 1.0)) * (0.78 + uAmount * 0.64);
    vec3 aspect = vec3(0.85 + 0.11 * sin(k), 1.12, 0.93);
    vec3 ro = (origin - centre) / aspect;
    vec3 rd = direction / aspect;
    float at = clamp(-dot(ro, rd) / dot(rd, rd), 0.0, span);
    vec3 closest = ro + rd * at;
    float d = length(closest) / radius;
    float core = exp(-d * d * 5.1);
    float body = 1.0 - smoothstep(0.32, 1.02, d);
    float membrane = exp(-pow((d - 0.85) * 9.0, 2.0));
    float halo = exp(-d * d * 0.64);
    float pulse = 0.86 + 0.14 * sin(t * 0.41 + k * 2.2);
    float distanceFade = exp(-at * 0.47);
    vec3 pigment = dye(0.12 + 0.83 * (0.5 + 0.5 * sin(k * 2.1)));
    vec3 nucleus = mix(pigment, uPrimary, 0.76);
    // Cool coloured bodies, broad auras, and small sharply resolved nuclei.
    emitted += distanceFade * pulse * (pigment * (halo * 0.12 + body * 0.48)
                + mix(pigment, uPrimary, 0.43) * membrane * 0.70
                + nucleus * core * 2.1);
    haze += halo * 0.065;
  }
  vec3 col = volBack(p, ray, span, t, 0.85) * exp(-haze);
  col += dye(0.87) * (0.035 + span * 0.035);
  col += emitted * (0.76 + uLevel * 0.25);
  col += skin(n, t) * (0.73 + uGloss * 0.38);
  return col;
}

float volUnion(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float volJellyShape(vec3 q) {
  // Three smoothly merged, asymmetrical lobes. No striped texture or shells.
  vec3 warp = q + 0.055 * vec3(sin(q.z * 5.0 + q.y * 2.0),
                              sin(q.x * 4.0 - q.z * 2.0),
                              sin(q.y * 4.0 + q.x));
  float a = length((warp - vec3(-0.13, 0.12, 0.05)) * vec3(1.02, 0.94, 1.03)) - 0.49;
  float b = length((warp - vec3(0.27, -0.19, -0.12)) * vec3(1.12, 0.90, 1.1)) - 0.30;
  float c = length((warp - vec3(-0.29, -0.26, 0.20)) * vec3(0.9, 1.1, 1.15)) - 0.23;
  return volUnion(volUnion(a, b, 0.22), c, 0.17);
}

// 08 / Jelly: thick clear gelatin around one soft, folded organic core.
vec3 material8(vec3 p, vec3 n, float t) {
  vec3 ray = volRay(n, 0.77);
  float span = max(0.0, -2.0 * dot(p, ray));
  float count = mix(12.0, 24.0, step(0.5, uDetail));
  float ds = span / count;
  vec3 origin = coreFrame(p);
  vec3 direction = coreFrame(ray);
  vec3 lightDir = normalize(vec3(-0.6, 0.75, 0.8));
  vec3 col = vec3(0.0);
  float transmission = 1.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= count) break;
    vec3 q = origin + direction * ((float(i) + 0.5) * ds);
    float d = volJellyShape(q / (0.85 + uAmount * 0.25));
    float flesh = 1.0 - smoothstep(-0.07, 0.07, d);
    float membrane = exp(-abs(d) * 31.0);
    vec3 organicNormal = normalize(q * vec3(1.05, 0.88, 1.0) + vec3(0.12, -0.06, 0.02));
    float diffuse = 0.5 + 0.5 * dot(organicNormal, lightDir);
    float glint = pow(max(0.0, dot(organicNormal, normalize(lightDir - direction))), 22.0);
    float colourDepth = volSat(0.20 + 0.58 * (1.0 - diffuse) + 0.16 * q.y);
    vec3 gelColour = dye(colourDepth) * (0.42 + 0.85 * diffuse);
    float density = 0.13 + flesh * 2.6 + membrane * 0.55;
    float alpha = 1.0 - exp(-density * ds * (0.7 + uAmount * 1.15));
    vec3 scatter = mix(dye(0.87) * 0.24, gelColour, flesh);
    scatter += uPrimary * membrane * (0.18 + glint * 1.4);
    col += transmission * alpha * scatter;
    transmission *= 1.0 - alpha;
  }
  col += transmission * volBack(p, ray, span, t, 0.71);
  // A broad damp highlight distinguishes gelatin from the clear cell glass.
  vec3 lamp = frame(normalize(vec3(-0.6, 0.8, 1.2)), -t * 0.35);
  col += uPrimary * spec(n, lamp, 42.0) * (0.10 + uGloss * 0.16);
  col += skin(n, t) * (0.48 + uGloss * 0.29);
  return col;
}

// 09 / Cellular: connected, hollow glass bubbles. Exact inner/outer ellipsoid
// intersections integrate each membrane's thickness without marching layers.
vec3 material9(vec3 p, vec3 n, float t) {
  vec3 ray = volRay(n, 0.82);
  float span = max(0.0, -2.0 * dot(p, ray));
  vec3 origin = frame(p, t * 0.77 + 3.5);
  vec3 direction = frame(ray, t * 0.77 + 3.5);
  vec3 membraneLight = vec3(0.0);
  float weight = 0.0;
  float opticalDepth = 0.0;
  for (int i = 0; i < 9; i++) {
    if (uDetail < 0.5 && i >= 7) break;
    float k = float(i);
    float y = -0.53 + k * 0.1325;
    float orbit = sqrt(max(0.035, 0.58 * 0.58 - y * y));
    vec3 centre = vec3(cos(k * 2.39996) * orbit, y, sin(k * 2.39996) * orbit);
    centre += 0.035 * vec3(sin(k * 1.7 + t * 0.16),
                           cos(k * 2.1 + t * 0.18),
                           sin(k * 2.9 - t * 0.14));
    vec3 aspect = vec3(0.94 + 0.07 * sin(k * 2.0), 1.06, 0.96);
    float radius = 0.315 + 0.025 * sin(k * 1.9) + uAmount * 0.045;
    vec3 ro = (origin - centre) / aspect;
    vec3 rd = direction / aspect;
    float aa = dot(rd, rd);
    float bb = dot(ro, rd);
    float cc = dot(ro, ro) - radius * radius;
    float discriminant = bb * bb - aa * cc;
    if (discriminant <= 0.0) continue;
    float root = sqrt(discriminant);
    float entry = max(0.0, (-bb - root) / aa);
    float exitDistance = min(span, (-bb + root) / aa);
    float outerLength = max(0.0, exitDistance - entry);
    // A generous continuous membrane gives stable curved contours even on
    // smaller worker orbs. Exact subtraction preserves the empty cell centre.
    float innerRadius = radius * 0.88;
    float innerDisc = bb * bb - aa * (dot(ro, ro) - innerRadius * innerRadius);
    float innerLength = 0.0;
    if (innerDisc > 0.0) {
      float innerRoot = sqrt(innerDisc);
      innerLength = max(0.0, min(span, (-bb + innerRoot) / aa)
                              - max(0.0, (-bb - innerRoot) / aa));
    }
    float membrane = max(0.0, outerLength - innerLength);
    vec3 cellNormal = normalize((ro + rd * entry) / aspect);
    vec3 lamp = normalize(vec3(-0.55, 0.8, 0.7));
    float diffuse = 0.5 + 0.5 * dot(cellNormal, lamp);
    float grazing = pow(1.0 - abs(dot(cellNormal, direction)), 2.0);
    float glint = pow(max(0.0, dot(cellNormal, normalize(lamp - direction))), 36.0);
    float nearFade = exp(-entry * 0.62);
    float alpha = (1.0 - exp(-membrane * (3.0 + uAmount * 2.3))) * nearFade;
    vec3 pigment = dye(volSat(0.82 - diffuse * 0.46 + centre.z * 0.12));
    vec3 lit = pigment * (0.32 + diffuse * 0.54)
             + mix(uPrimary, uSecondary, 0.15) * (grazing * 0.42 + glint * 0.72);
    membraneLight += lit * alpha;
    weight += alpha;
    opticalDepth += membrane * 1.2;
  }
  float coverage = 1.0 - exp(-weight * 1.45);
  vec3 col = volBack(p, ray, span, t, 0.91) * exp(-opticalDepth);
  col += membraneLight / max(weight, 0.001) * coverage;
  col += dye(0.90) * 0.025;
  col += skin(n, t) * (0.60 + uGloss * 0.30);
  return col;
}
