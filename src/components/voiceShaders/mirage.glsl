const float mirage_PI = 3.14159265359;

mat2 mirage_turn(float a) { float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
float mirage_hash(vec3 p) { p=fract(p*.3183099+vec3(.13,.27,.41)); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float mirage_noise3(vec3 p) {
  vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(mirage_hash(i),mirage_hash(i+vec3(1,0,0)),f.x),mix(mirage_hash(i+vec3(0,1,0)),mirage_hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(mirage_hash(i+vec3(0,0,1)),mirage_hash(i+vec3(1,0,1)),f.x),mix(mirage_hash(i+vec3(0,1,1)),mirage_hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float mirage_fbm(vec3 p) { return mirage_noise3(p)*.57+mirage_noise3(p*2.03+7.1)*.28+mirage_noise3(p*4.11+13.7)*.15; }
vec3 mirage_dye(float v) {
  vec3 c=mix(uPrimary,uSecondary,.5+.5*sin(v));
  return mix(c,uTertiary,pow(.5+.5*cos(v*.73+1.2),3.)*.55);
}
vec3 mirage_lightFrame(vec3 v,float t) {
  // Backward pitch and diagonal yaw both cross the depth axis. A slow,
  // alternating roll changes the sweep without turning it into a flat spin.
  float pitch=-t*.28+.3*sin(t*.22);
  float yaw=t*.21+.35*sin(t*.15);
  float roll=.22*sin(t*.19);
  v.yz=mirage_turn(pitch)*v.yz;
  v.xz=mirage_turn(yaw)*v.xz;
  v.xy=mirage_turn(roll)*v.xy;
  return v;
}
vec3 mirage_movingLight(vec3 v,float t) {
  // Inverse of mirage_lightFrame: highlights and environment reflections share one
  // three-dimensional studio rig, so they travel coherently across the mirage_glass.
  float pitch=-t*.28+.3*sin(t*.22);
  float yaw=t*.21+.35*sin(t*.15);
  float roll=.22*sin(t*.19);
  v.xy=mirage_turn(-roll)*v.xy;
  v.xz=mirage_turn(-yaw)*v.xz;
  v.yz=mirage_turn(-pitch)*v.yz;
  return v;
}
vec3 mirage_room(vec3 r, float t) {
  // Analytic studio illumination. Moving luminous sheets are reflected in the
  // material; no textures, remote assets or rainbow colour substitutions.
  r=mirage_lightFrame(r,t);
  vec3 c=mix(uBackground*.4, uPrimary*.16, .4+.35*r.y);
  float arch=r.x*.73+r.y*.25+.12*sin(r.z*3.+t*.17);
  float strip=exp(-pow((arch+.48)*7.,2.))*smoothstep(-.65,-.2,r.z);
  float right=exp(-pow((r.x-.63)*13.,2.))*exp(-pow((r.y+.05)*1.3,2.));
  float cap=pow(max(0.,dot(r,normalize(vec3(-.5,.85,.6)))),24.);
  float under=exp(-pow((r.y+.72)*8.,2.));
  c+=mix(uPrimary,vec3(1.),.68)*strip*1.9;
  c+=mix(uSecondary,vec3(1.),.3)*right*1.65;
  c+=vec3(1.)*cap*2.5;
  c+=mix(uTertiary,uSecondary,.45)*under*.8;
  c+=uSecondary*.15*max(r.x,0.);
  return c;
}
vec3 mirage_film(vec3 n,float phase) {
  float k=(1.-n.z)*5.+phase;
  return mix(mirage_dye(k),mirage_dye(k+2.1),.25+.2*sin(k*1.4));
}
float mirage_softLight(vec3 n,vec3 l,float power) { return pow(max(0.,dot(n,normalize(l+vec3(0,0,1)))),power); }

vec3 mirage_workerBead(vec3 n,float t) {
  // Workers share the palette and moving light, not Mirage's internal optics.
  // A broad pigment gradient and a single soft reflection remain legible small.
  float blend=clamp(.5+.22*n.x-.18*n.y,0.,1.);
  vec3 pigment=mix(uPrimary,uSecondary,blend);
  vec3 rig=mirage_movingLight(vec3(-.6,.7,1.),t*.72);
  vec3 key=normalize(vec3(rig.xy*.8,.9+abs(rig.z)*.4));
  float diffuse=max(0.,dot(n,key));
  vec3 c=pigment*(.3+.58*diffuse);
  float reflection=mirage_softLight(n,key,32.);
  c+=mix(pigment,vec3(1.),.78)*reflection*.7;
  float edge=pow(1.-max(n.z,0.),3.);
  c+=mix(pigment,vec3(1.),.25)*edge*(.035+.12*diffuse);
  return c;
}

vec3 mirage_glass(vec3 p,vec3 n,float t) {
  // Original Mirage refraction, studio reflections and surface lighting.
  // The repeated interior light beams and their afterimages are removed.
  float eta=1./(1.18+.42*uAmount);
  vec3 ray=refract(vec3(0,0,-1),n,eta);
  vec3 exitPoint=p+ray*(-2.*dot(p,ray));
  vec3 exitRay=refract(ray,-normalize(exitPoint),1./eta);
  vec2 q=p.xy*.85+exitPoint.xy*.45+exitRay.xy*.18;
  q=mirage_turn(-.38+uPointer.x*.06)*q;
  // The refracted interior turns in 3D at a slower rate than the front skin.
  // Retaining its depth coordinate creates parallax across the sphere.
  vec3 interior=mirage_lightFrame(vec3(q,exitPoint.z*.6),-uInnerTime*.14-uInnerMouse*.35+1.3);
  float phase=interior.x*5.4+interior.y*3.1+interior.z*1.35+sin(interior.x*2.4-uInnerTime*.05)*.86;
  float thickness=2.*n.z;
  vec3 pigment=mirage_dye(phase*.39+n.z*2.2+uSeed*.8);
  vec3 absorb=exp(-(vec3(1.)-pigment)*thickness*1.3);
  vec3 inside=mix(uBackground*.7,pigment*.2,.8)*absorb;
  vec3 transmitted=dot(exitRay,exitRay)>.0001?normalize(exitRay):reflect(ray,-normalize(exitPoint));
  inside+=mirage_room(transmitted,-uInnerTime*.14-uInnerMouse*.35)*.12;
  float edge=pow(1.-n.z,2.8);
  float fresnel=.065+.935*pow(1.-n.z,4.8);
  vec3 reflection=mirage_room(reflect(vec3(0,0,-1),n),t);
  vec3 c=mix(inside,reflection,clamp(fresnel*.88+.12,0.,1.));
  c+=mirage_film(n,phase*.12)*edge*.5;
  c+=vec3(1.)*mirage_softLight(n,mirage_movingLight(vec3(-.55,.7,1.4),t),180.)*(.3+.55*uGloss);
  c+=uPrimary*mirage_softLight(n,mirage_movingLight(vec3(.7,-.55,.5),t),72.)*.8;
  if(uLight>.5) c=mix(c,uBackground*.7+pigment*.23,.22)+reflection*.08;
  return c;
}
