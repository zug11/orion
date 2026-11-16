// Original ES 1.00 surface studies. These return linear-ish HDR colour; the
// shared renderer owns the highlight shoulder and final display transform.
// All motion uses the integrated rotation time t, including slow deformation.

float surfAmount() { return clamp(uAmount, 0.0, 1.5) / 1.5; }
float surfGloss() { return clamp(uGloss, 0.0, 1.5) / 1.5; }

// Porcelain: two flowing glaze pools over an opaque, softly lit ceramic body.
// The coating has its own white specular response; pigment is below the coat.
vec3 material3(vec3 p, vec3 n, float t) {
  float amount = surfAmount();
  float polish = surfGloss();
  vec3 q = frame(p, t * .82 + 1.7);
  q.xz = turn(.45 * q.y + .23 * sin(q.z * 2.1)) * q.xz;
  float poolNoise = noise3(q * 2.15 + vec3(4.2, 1.3, 7.7));
  float pool = q.y * .68 + q.x * .27 + q.z * .18
    + .25 * sin(q.x * 3.7 - q.z * 2.2)
    + .43 * (poolNoise - .5);
  float glazeWeight = smoothstep(-.15 - amount * .08, .16, pool);
  vec3 glaze = dye(glazeWeight);
  // Milky suspended particles soften the glaze interior while the pool's
  // meniscus retains concentrated pigment. No transparent glass core.
  float meniscus = exp(-abs(pool) * 17.0);
  float milk = .10 + .19 * (1.0 - amount) + .12 * (1.0 - meniscus);
  vec3 ceramic = mix(glaze, vec3(.94, .95, .97), milk);
  ceramic *= 1.0 - meniscus * .105;
  float key = max(0.0, dot(n, normalize(vec3(-.55, .72, 1.25))));
  float fill = max(0.0, dot(n, normalize(vec3(.8, -.2, .35))));
  vec3 c = ceramic * (.20 + .70 * key + .14 * fill);
  c += ceramic * .065 * pow(max(n.z, 0.0), 1.5);

  vec3 reflected = env(reflect(vec3(0.0, 0.0, -1.0), n), t * .48);
  float fresnel = .045 + .36 * pow(1.0 - max(n.z, 0.0), 4.5);
  c += reflected * fresnel * (.55 + .55 * polish);
  vec3 light = normalize(frame(vec3(-.48, .72, 1.6), t * .19));
  c += vec3(1.0) * spec(n, light, 55.0 + 95.0 * polish)
    * (.65 + .85 * polish);
  c += mix(vec3(1.0), uPrimary, .15)
    * spec(n, normalize(vec3(.7, -.45, .65)), 48.0) * .13;
  return max(c, vec3(0.0));
}

// A broad, asymmetric studio for the metal: curved horizon, oval softboxes,
// and a dark floor. This is deliberately not a stack of parallel light bars.
vec3 surfMetalRoom(vec3 r, float t) {
  r = frame(r, t * .31 + .4);
  float horizon = smoothstep(-.21, .24,
    r.y + .22 * sin(r.x * 2.2 + r.z * 1.7));
  float colourSweep = smoothstep(-.65, .7, r.x * .8 - r.z * .45);
  vec3 tint = dye(colourSweep);
  vec3 c = mix(vec3(.027), vec3(.30), horizon);
  c *= mix(vec3(1.0), tint, .24 + surfAmount() * .47);
  float ceiling = pow(max(0.0,
    dot(r, normalize(vec3(-.32, .88, .35)))), 3.8);
  float window = pow(max(0.0,
    dot(r, normalize(vec3(.83, .13, .54)))), 8.0);
  float blueRoom = pow(max(0.0,
    dot(r, normalize(vec3(-.75, -.28, -.28)))), 2.5);
  c += mix(uPrimary, vec3(1.0), .73) * ceiling * 1.55;
  c += mix(uSecondary, vec3(1.0), .12) * window * 1.25;
  c += dye(.7) * blueRoom * .41;
  return c;
}

// Quicksilver: analytic low-frequency slopes give smooth liquid bulges.
// Transforming the gradient back to world coordinates keeps those bulges
// attached to the 3D surface as it pitches backwards and rolls diagonally.
vec3 material4(vec3 p, vec3 n, float t) {
  float amount = surfAmount();
  float polish = surfGloss();
  float rotation = t * .73 + 2.3;
  vec3 q = frame(p, rotation);
  vec3 a = vec3(2.35, 1.15, -1.45);
  vec3 b = vec3(-1.05, 2.7, 1.65);
  vec3 d = vec3(1.6, -1.4, 2.5);
  vec3 slope = a * cos(dot(q, a) + t * .13) * .39
    + b * cos(dot(q, b) - t * .11 + 1.7) * .26
    + d * cos(dot(q, d) + t * .08 - 1.2) * .20;
  vec3 worldSlope = vec3(
    dot(slope, frame(vec3(1.0, 0.0, 0.0), rotation)),
    dot(slope, frame(vec3(0.0, 1.0, 0.0), rotation)),
    dot(slope, frame(vec3(0.0, 0.0, 1.0), rotation)));
  worldSlope -= n * dot(worldSlope, n);
  // Preserve the circular silhouette, including at the grazing edge.
  float deformation = (.11 + .18 * amount) * smoothstep(0.0, .44, n.z);
  vec3 metalNormal = normalize(n + worldSlope * deformation);
  vec3 ray = reflect(vec3(0.0, 0.0, -1.0), metalNormal);
  vec3 room = surfMetalRoom(ray, t);
  vec3 commonRoom = env(ray, t * .42);
  vec3 c = room * (.93 + .18 * polish) + commonRoom * .17;
  float grazing = pow(1.0 - max(n.z, 0.0), 3.0);
  c += mix(uPrimary, uSecondary, .52) * grazing * .16;
  vec3 light = normalize(frame(vec3(-.5, .7, 1.4), t * .22));
  c += vec3(1.0) * spec(metalNormal, light, 80.0 + 120.0 * polish)
    * (.18 + .5 * polish);
  // A low value floor keeps the sphere readable for two very dark colours.
  c += vec3(.018) * max(n.z, 0.0);
  return max(c, vec3(0.0));
}

// Marble: broad folded 3D mineral veins, opaque diffuse stone and a separate
// clearcoat. Low-frequency pigment clouds stay soft at worker-orb sizes.
vec3 material5(vec3 p, vec3 n, float t) {
  float amount = surfAmount();
  float polish = surfGloss();
  float detail = clamp(uDetail, 0.0, 1.0) * smoothstep(10.0, 55.0, uRadius);
  vec3 q = frame(p, t * .66 + 3.4);
  q.xy = turn(q.z * 1.8 + .35 * sin(q.y * 1.7)) * q.xy;
  q.yz = turn(q.x * .65) * q.yz;
  // Three-octave low-frequency domain warp folds the strata through the
  // sphere. Domain displacement supplies the detail, rather than multiplying
  // a high-frequency scalar by a large phase and generating contour tangles.
  vec3 warp = vec3(
    fbm(q * 1.35 + vec3(1.7, 4.1, .3)),
    fbm(q * 1.35 + vec3(6.2, 2.7, 3.5)),
    fbm(q * 1.35 + vec3(2.4, 7.3, 5.2))) - .5;
  vec3 stonePoint = q * 1.35 + warp * (1.7 + amount * 1.1);
  float folding = fbm(stonePoint * 1.1 + vec3(3.3, 5.4, 1.2));
  float strata = stonePoint.y * 3.8 + stonePoint.x * 2.15
    + stonePoint.z * 1.65
    + sin(stonePoint.x * 2.0 - stonePoint.z * 1.6) * 1.25
    + (folding - .5) * 2.7;
  float folded = .5 + .5 * sin(strata);
  float edgeSoftness = mix(.12, .035, smoothstep(14.0, 70.0, uRadius));
  float pigment = smoothstep(.27 - edgeSoftness, .73 + edgeSoftness, folded);
  vec3 stone = dye(pigment);
  float mineralCloud = noise3(stonePoint * 2.4 + vec3(3.2, 7.1, 2.3));
  // One soft quartz vein within each folded stratum, not paired contour
  // outlines. Approximate the phase footprint to soften these at small radii.
  float veinDistance = abs(sin(strata + .52 + (mineralCloud - .5) * .7));
  float veinAA = clamp(8.0 / max(uRadius, 8.0), .035, .28);
  float quartz = 1.0 - smoothstep(.075, .17 + veinAA, veinDistance);
  stone = mix(stone, vec3(.94), .035 + .045 * (1.0 - amount));
  stone = mix(stone, mix(dye(.28), vec3(.98), .52), quartz * (.12 + .10 * detail));
  stone *= .965 + mineralCloud * .055 * detail;

  float key = max(0.0, dot(n, normalize(vec3(-.58, .78, 1.2))));
  float bounce = max(0.0, dot(n, normalize(vec3(.7, -.5, .7))));
  vec3 c = stone * (.20 + .75 * key + .12 * bounce);
  vec3 reflected = env(reflect(vec3(0.0, 0.0, -1.0), n), t * .45);
  float fresnel = .035 + .40 * pow(1.0 - max(n.z, 0.0), 4.2);
  c += reflected * fresnel * (.48 + .5 * polish);
  vec3 light = normalize(frame(vec3(-.45, .7, 1.5), t * .17));
  c += vec3(1.0) * spec(n, light, 75.0 + 115.0 * polish)
    * (.4 + .8 * polish);
  return max(c, vec3(0.0));
}
