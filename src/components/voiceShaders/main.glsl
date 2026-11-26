const vec3 lumaWeights=vec3(.2126,.7152,.0722);

// Set the lightness and keep as much pigment as the display can represent.
// Fitting chroma to the gamut keeps pale yellow and deep blue equally legible.
vec3 tintedGlass(vec3 pigment,float lightness,float saturation){
 vec3 chroma=(pigment-dot(pigment,lumaWeights))*saturation;
 vec3 limits=max(chroma/(1.-lightness),-chroma/lightness);
 return vec3(lightness)+chroma/max(1.,max(limits.r,max(limits.g,limits.b)));
}
void main(){
 vec2 xy=vLocal;
 float radius=length(xy),aa=1.25/(uRadius*uDpr);
 float mask=1.-smoothstep(1.-aa,1.+aa,radius);
 if(radius>1.+aa){
  // Research motion carries activity; no circling progress outline.
  float glow=exp(-(radius-1.)*24.)*.035*(1.-smoothstep(1.08,1.22,radius));
  vec3 halo=dye(.4);
  if(uLight>.5)halo=mix(vec3(1.),halo,.15);
  gl_FragColor=vec4(halo,glow*uOpacity);return;
 }
 float z=sqrt(max(0.,1.-dot(xy,xy)));
 vec3 p=vec3(xy,z),n=normalize(p);
 float t=uRotationTime+uSeed*2.7;
 vec3 c;
 float opacity=1.;
 if(uRadius<8.){
  c=dye(.3)*(.45+.25*z);
  opacity=.75;
 }else if(uDetail<.5){
  vec4 worker=workerMaterial(p,n,t);
  c=worker.rgb;opacity=worker.a;
  c*=1.+uWorking*.035*sin(uTime*1.7+uSeed);
 }else if(uMaterial<.5)c=mirage_glass(p,n,t);
 else if(uMaterial<5.)c=material4(p,n,t);
 else if(uMaterial<9.)c=material8(p,n,t);
 else c=material9(p,n,t);
 c*=1.+uLevel*.12;c+=uSecondary*uReceiving*.18*pow(1.-z,1.5);
 c=max(c,vec3(0.));c=c/(vec3(1.)+c*.32);c=pow(c,vec3(.89));
 if(uLight>.5){
  // Moving pigment supplies the cloud relief. The curved silhouette has its
  // own lightness so a bright patch cannot erase the rim against paper.
  float relief=smoothstep(.06,.72,dot(c,lumaWeights));
  float rim=smoothstep(.79,.985,radius);
  float glint=pow(max(0.,dot(n,normalize(vec3(-.43,.54,.72)))),46.);
  float lightness=mix(.77+.18*relief,.739,rim)+.065*glint;
  vec3 pigment=mix(uPrimary,uSecondary,.18*relief);
  c=tintedGlass(pigment,min(.985,lightness),.96-.45*relief+.14*rim);
 }
 gl_FragColor=vec4(c,mask*uOpacity*opacity*(1.-.12*uLight));
}
