void main(){
 vec2 xy=vLocal;
 float radius=length(xy),aa=1.25/(uRadius*uDpr);
 float mask=1.-smoothstep(1.-aa,1.+aa,radius);
 if(radius>1.+aa){
  // Research motion carries activity; no circling progress outline.
  float glow=exp(-(radius-1.)*24.)*.035*(1.-smoothstep(1.08,1.22,radius));
  gl_FragColor=vec4(dye(.4),glow*uOpacity);return;
 }
 float z=sqrt(max(0.,1.-dot(xy,xy)));
 vec3 p=vec3(xy,z),n=normalize(p);
 n.xy+=uPointer*vec2(.025,.018)*z;n=normalize(n);
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
 gl_FragColor=vec4(mix(c,vec3(1.),.07*uLight),mask*uOpacity*opacity*(1.-.12*uLight));
}
