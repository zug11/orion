precision highp float;
attribute vec2 aPosition;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStretch;
uniform float uAngle;
varying vec2 vLocal;
void main() {
  vec2 local = aPosition * 1.24;
  float stretch = sqrt(uStretch);
  vec2 p = local * vec2(1.0 / stretch, stretch);
  float c = cos(uAngle), s = sin(uAngle);
  p = mat2(c, -s, s, c) * p;
  vec2 pixel = uCenter + p * uRadius;
  gl_Position = vec4(pixel.x / uResolution.x * 2.0 - 1.0, 1.0 - pixel.y / uResolution.y * 2.0, 0.0, 1.0);
  vLocal = vec2(local.x, -local.y);
}
