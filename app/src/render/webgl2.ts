import { BACKGROUND, FLOATS_PER_INSTANCE, MAX_ARRAY_LAYERS, slotOrigin, type Frame, type Renderer } from './renderer.ts';

const VS = `#version 300 es
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 uvr;
layout(location = 2) in float slot;
uniform vec3 r0;
uniform vec3 r1;
out vec2 uv;
flat out int vslot;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec3 d = vec3(mix(rect.xy, rect.zw, c), 1.0);
  gl_Position = vec4(dot(r0, d), dot(r1, d), 0.0, 1.0);
  uv = mix(uvr.xy, uvr.zw, c);
  vslot = int(slot);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray tex;
uniform float checker;
in vec2 uv;
flat in int vslot;
out vec4 color;
void main() {
  vec2 cell = floor(gl_FragCoord.xy / checker);
  float chk = ((int(cell.x + cell.y) & 1) == 1) ? 0.8 : 1.0;
  vec4 col = vec4(0.0);
  if (vslot >= 0) {
    vec2 t = clamp(uv, vec2(0.5 / 256.0), vec2(1.0 - 0.5 / 256.0));
    vec2 off = vec2(float(vslot & 1), float((vslot >> 1) & 1)) * 0.5;
    col = textureLod(tex, vec3(off + t * 0.5, float(vslot >> 2)), 0.0);
  }
  color = vec4(col.rgb + chk * (1.0 - col.a), 1.0);
}`;

export class WebGl2Renderer implements Renderer {
  readonly kind = 'webgl2';
  readonly gpu = null;
  readonly slots: number;
  #gl: WebGL2RenderingContext;
  #tex: WebGLTexture;
  #buf: WebGLBuffer;
  #u: { r0: WebGLUniformLocation; r1: WebGLUniformLocation; checker: WebGLUniformLocation };

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) throw new Error('Neither WebGPU nor WebGL2 is available');
    this.#gl = gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
      gl.attachShader(prog, s);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    gl.useProgram(prog);
    this.#u = {
      r0: gl.getUniformLocation(prog, 'r0')!,
      r1: gl.getUniformLocation(prog, 'r1')!,
      checker: gl.getUniformLocation(prog, 'checker')!,
    };
    const layers = Math.min(MAX_ARRAY_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    this.slots = layers * 4;
    this.#tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 512, 512, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.#buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buf);
    const stride = FLOATS_PER_INSTANCE * 4;
    for (const [loc, size, off] of [[0, 4, 0], [1, 4, 16], [2, 1, 32]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      gl.vertexAttribDivisor(loc, 1);
    }
  }

  upload(slot: number, data: Uint8Array) {
    const gl = this.#gl;
    const [x, y, z] = slotOrigin(slot);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, z, 256, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  draw(f: Frame) {
    const gl = this.#gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (f.count === 0) return;
    const filter = f.nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
    const m = f.matrix;
    gl.uniform3f(this.#u.r0, m[0], m[1], m[2]);
    gl.uniform3f(this.#u.r1, m[3], m[4], m[5]);
    gl.uniform1f(this.#u.checker, f.checker);
    gl.bufferData(gl.ARRAY_BUFFER, f.instances.subarray(0, f.count * FLOATS_PER_INSTANCE), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.count);
  }
}
