import vertex from './orb.vert?raw';
import common from './common.glsl?raw';
import surfaces from './surfaces.glsl?raw';
import volumes from './volumes.glsl?raw';
import workers from './workers.glsl?raw';
import main from './main.glsl?raw';
import type { AtmospherePalette } from '../../lib/homeAtmosphere';
import type { OrbCircle } from '../../lib/voiceOrbMotion';
const fragment = [common, 'uniform float uWorkerStyle,uWorkerSheen,uWorkerSoftness;', surfaces, volumes, workers, main].join('\n');
const rgb = (hex: string) => new Float32Array([1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255));
/** One bounded offscreen context per expanded scene. Canvas2D remains the fallback. */
export function createVoiceGlass() {
 const canvas=document.createElement('canvas');
 let gl: WebGLRenderingContext | null=null;
 try { gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,powerPreference:'low-power'}); } catch { return null; }
 if(!gl || typeof gl.createShader!=='function')return null;
 let available=true;
 const context=gl, shaders:WebGLShader[]=[];
 const program=context.createProgram(), buffer=context.createBuffer();
 function dispose(){shaders.forEach(s=>context.deleteShader(s));context.deleteBuffer(buffer);context.deleteProgram(program);context.getExtension('WEBGL_lose_context')?.loseContext();}
 if(!program||!buffer){dispose();return null;}
 for(const [type,code] of [[context.VERTEX_SHADER,vertex],[context.FRAGMENT_SHADER,fragment]] as const){
  const shader=context.createShader(type);if(!shader){dispose();return null;}shaders.push(shader);context.shaderSource(shader,code);context.compileShader(shader);
  if(!context.getShaderParameter(shader,context.COMPILE_STATUS)){dispose();return null;}context.attachShader(program,shader);
 }
 context.linkProgram(program);if(!context.getProgramParameter(program,context.LINK_STATUS)){dispose();return null;}
 const position=context.getAttribLocation(program,'aPosition');
 const names=['Resolution','Center','Radius','Stretch','Angle','Dpr','Time','RotationTime','Material','Detail','Seed','Level','Receiving','Working','Opacity','Amount','Gloss','WorkerStyle','WorkerSheen','WorkerSoftness','Light','Primary','Secondary','Tertiary','Background','Pointer'];
 const u=Object.fromEntries(names.map(n=>[n,context.getUniformLocation(program,'u'+n)]));
 context.bindBuffer(context.ARRAY_BUFFER,buffer);context.bufferData(context.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),context.STATIC_DRAW);
 context.enable(context.BLEND);context.blendFuncSeparate(context.SRC_ALPHA,context.ONE_MINUS_SRC_ALPHA,context.ONE,context.ONE_MINUS_SRC_ALPHA);
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();available=false;});
 return {dispose, draw(target:CanvasRenderingContext2D,point:OrbCircle,palette:AtmospherePalette,time:number,phase:number,isMain:boolean,stretch:number,opacity:number,level:number,angle:number){
  if(!available||context.isContextLost())return false;
  const size=Math.ceil(point.radius*3.2),dpr=Math.min(1.5,devicePixelRatio||1),pixels=Math.ceil(size*dpr);
  if(canvas.width!==pixels||canvas.height!==pixels){canvas.width=pixels;canvas.height=pixels;}
  context.viewport(0,0,pixels,pixels);context.clearColor(0,0,0,0);context.clear(context.COLOR_BUFFER_BIT);context.useProgram(program);
  context.bindBuffer(context.ARRAY_BUFFER,buffer);context.enableVertexAttribArray(position);context.vertexAttribPointer(position,2,context.FLOAT,false,0,0);
  const one=(name:string,value:number)=>context.uniform1f(u[name],value);
  context.uniform2f(u.Resolution,size,size);context.uniform2f(u.Center,size/2,size/2);context.uniform2f(u.Pointer,0,0);
  one('Radius',point.radius);one('Dpr',dpr);one('Stretch',stretch);one('Angle',angle);one('Time',time);one('RotationTime',time*.35+phase);one('Seed',isMain?0:point.slot+1);
  one('Material',isMain?8:9);one('Detail',isMain?1:0);one('Amount',.8);one('Gloss',.8);one('WorkerStyle',0);one('WorkerSheen',.4);one('WorkerSoftness',1);
  one('Level',level);one('Receiving',0);one('Working',0);one('Opacity',opacity);one('Light',palette.isLight?1:0);
  context.uniform3fv(u.Primary,rgb(palette.primary));context.uniform3fv(u.Secondary,rgb(palette.secondary));context.uniform3fv(u.Tertiary,rgb(palette.tertiary));context.uniform3fv(u.Background,rgb(palette.background));
  context.drawArrays(context.TRIANGLES,0,6);
  target.drawImage(canvas,point.x-size/2,point.y-size/2,size,size);return true;
 }};
}
