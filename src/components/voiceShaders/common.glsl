precision highp float;
varying vec2 vLocal;
uniform float uTime,uRotationTime,uMaterial,uRadius,uDpr,uLevel,uReceiving,uSeed;
uniform float uLight,uWorking,uOpacity,uDetail,uAmount,uGloss;
uniform vec2 uPointer;
uniform vec3 uPrimary,uSecondary,uTertiary,uBackground;
mat2 turn(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}
float hash(vec3 p){p=fract(p*.3183099+vec3(.13,.27,.41));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){
 vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){return noise3(p)*.58+noise3(p*2.03+7.1)*.28+noise3(p*4.11+13.7)*.14;}
vec3 dye(float w){return mix(uPrimary,uSecondary,clamp(w,0.,1.));}
vec3 frame(vec3 v,float t){
 v.yz=turn(-t*.28+.3*sin(t*.22))*v.yz;
 v.xz=turn(t*.21+.35*sin(t*.15))*v.xz;
 v.xy=turn(.22*sin(t*.19))*v.xy;
 return v;
}
vec3 worldLight(vec3 v,float t){
 v.xy=turn(-.22*sin(t*.19))*v.xy;
 v.xz=turn(-t*.21-.35*sin(t*.15))*v.xz;
 v.yz=turn(t*.28-.3*sin(t*.22))*v.yz;
 return v;
}
float spec(vec3 n,vec3 l,float power){return pow(max(0.,dot(n,normalize(l+vec3(0,0,1)))),power);}
vec3 env(vec3 r,float t){
 r=frame(r,t);
 vec3 c=mix(uBackground*.35,uPrimary*.12,.4+.35*r.y);
 float arch=r.x*.73+r.y*.25+.12*sin(r.z*3.+t*.17);
 float strip=exp(-pow((arch+.48)*8.,2.))*smoothstep(-.65,-.2,r.z);
 float right=exp(-pow((r.x-.63)*15.,2.))*exp(-pow((r.y+.05)*1.3,2.));
 float cap=pow(max(0.,dot(r,normalize(vec3(-.5,.85,.6)))),30.);
 float under=exp(-pow((r.y+.72)*10.,2.));
 c+=mix(uPrimary,vec3(1.),.65)*strip*1.9;
 c+=mix(uSecondary,vec3(1.),.35)*right*1.65;
 c+=vec3(1.)*cap*2.;c+=dye(.6)*under*.65;
 return c;
}
vec3 skin(vec3 n,float t){
 float edge=pow(1.-max(n.z,0.),3.);
 vec3 c=env(reflect(vec3(0,0,-1),n),t)*(.07+edge*.6);
 c+=dye(.5+.3*n.y-.2*n.x)*edge*.25;
 c+=mix(uPrimary,vec3(1.),.7)*spec(n,worldLight(vec3(-.55,.7,1.4),t),180.)*.35;
 return c;
}
