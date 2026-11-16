// One smooth optical sphere for each worker; no internal geometry or textures.
float workerSoftbox(vec3 ray,vec3 direction,float width,float height,float blur){
 vec3 axis=normalize(direction);
 vec3 horizontal=normalize(cross(vec3(0.,1.,0.),axis));
 vec3 vertical=cross(axis,horizontal);
 float facing=dot(ray,axis);
 vec2 q=vec2(dot(ray,horizontal),dot(ray,vertical))/max(.12,facing);
 vec2 edge=abs(q)-vec2(width,height)+vec2(.18);
 float distance=length(max(edge,vec2(0.)))+min(max(edge.x,edge.y),0.)-.18;
 return (1.-smoothstep(-blur,blur,distance))*smoothstep(.05,.3,facing);
}
vec3 workerRoom(vec3 ray,float t,float roughness){
 ray=frame(normalize(ray),t);
 // One tall studio window and a broad coloured bounce. The curved sphere
 // supplies the reflection's shape, without painted stripes or sparkles.
 vec3 c=uBackground*.2+dye(.5)*.035;
 // Low-frequency rear illumination remains visible through the glass even
 // while the reflected window moves toward the silhouette.
 c+=mix(dye(.5),vec3(1.),.22)*(.13+.14*max(0.,-ray.z));
 float window=workerSoftbox(ray,vec3(-.6,.7,1.35),.24,.68,.16+roughness);
 float bounce=workerSoftbox(ray,vec3(.9,-.6,-.8),.9,.5,.24+roughness);
 c+=mix(uPrimary,vec3(1.),.82)*window*2.6;
 c+=mix(uSecondary,vec3(1.),.3)*bounce*.9;
 c+=dye(.65)*max(0.,-ray.y)*.12;
 return c;
}
vec4 workerMaterial(vec3 p,vec3 n,float t){
 float frosted=step(.5,uWorkerStyle)*(1.-step(1.5,uWorkerStyle));
 float luminous=step(1.5,uWorkerStyle);
 float softness=clamp(uWorkerSoftness,0.,1.);
 float sheen=clamp(uWorkerSheen,0.,1.);
 float metal=1.-step(6.,uMaterial);
 float hollow=step(8.5,uMaterial);
 float gel=1.-metal-hollow;
 float roughness=.04+softness*.09+frosted*.13;
 // Match the main orb's rotating studio, with only slight phase variation.
 float opticalTime=t-uSeed*2.7+uSeed*.12;
 p=normalize(p); // Also guard the anti-aliased fringe just outside the sphere.
 vec3 normal=p;
 float z=max(normal.z,0.);
 float ior=1.38+gel*.08+metal*.12;
 vec3 incident=vec3(0.,0.,-1.);
 vec3 internalRay=refract(incident,normal,1./ior);
 float pathLength=max(.001,-2.*dot(p,internalRay));
 vec3 exitPoint=p+internalRay*pathLength;
 vec3 exitNormal=normalize(exitPoint);
 vec3 outgoing=refract(internalRay,-exitNormal,ior);
 if(dot(outgoing,outgoing)<.0001)outgoing=reflect(internalRay,-exitNormal);
 vec3 interior=frame(exitPoint,opticalTime*.6);
 float tint=smoothstep(-.65,.65,interior.x*.65+interior.y*.35);
 vec3 pigment=mix(uPrimary,uSecondary,tint);
 // Cellular has a single thin shell; Jelly has a thicker coloured centre.
 float opticalDepth=pathLength*(.4+gel*.28-metal*.08);
 if(hollow>.5){
  float impact2=max(0.,1.-pow(dot(p,internalRay),2.));
  float cavity=2.*sqrt(max(0.,.76*.76-impact2));
  opticalDepth=max(.12,pathLength-cavity)*.72;
 }
 vec3 absorption=exp(-(vec3(1.)-pigment)*opticalDepth*1.5);
 vec3 transmission=workerRoom(outgoing,opticalTime,roughness+.12)*absorption;
 float centre=pow(z,.7);
 vec3 body=pigment*(.08+.13*centre+gel*.06*centre);
 body*=mix(vec3(1.),absorption,.45);
 vec3 inside=body+transmission*(.5+gel*.08);
 float f0=pow((ior-1.)/(ior+1.),2.);
 float fresnel=f0+(1.-f0)*pow(1.-z,4.5);
 vec3 reflected=workerRoom(reflect(incident,n),opticalTime,roughness);
 float reflectionGain=(.52+.48*sheen)*(1.+metal*.48);
 vec3 c=inside*(1.-fresnel*.75)+reflected*(.2+.65*fresnel)*reflectionGain;
 // A quiet refracted light pool behind the front reflection adds parallax.
 vec3 backLight=normalize(worldLight(vec3(.5,-.7,-1.),opticalTime));
 float pool=pow(max(0.,dot(exitNormal,backLight)),5.);
 c+=mix(pigment,uSecondary,.35)*pool*(.13+gel*.06)*absorption;
 if(frosted>.5)c=mix(c,c*.82+pigment*centre*.16,.35);
 if(luminous>.5)c+=pigment*centre*.1;
 // Transmission is already in RGB: retain the glass silhouette in all styles.
 return vec4(max(c,vec3(0.)),.97);
}
