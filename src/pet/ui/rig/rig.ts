/* 分层木偶的绘制：每个图层是母版上切下来的一块，挂在一张网格上。每帧在 CPU 上按参数挪网格顶点
   （头发和发尾的摆、转头视差、歪头、呼吸、身体轻摆、小腿摆、蝴蝶扇翅），再用 WebGL2 按层序画出来。
   瞳孔用模板缓冲裁在眼白里；闭眼是「眼皮带着睫毛线从上往下合」，合到底换成画好的闭眼图；张嘴、笑眼是对齐的覆盖层。
   坐标一律是母版像素（左上为原点，y 向下）。数据由 design/pet/rig-sample/cut.py 生成（rig.json + public/pet/rig/*.webp）。 */

export interface PartDef {
  id: string;
  file: string;
  x: number; y: number; w: number; h: number;
  z: number;
  grid: [number, number];
  head?: boolean;
  depth?: number;
  sphere?: boolean;
  kind?: 'iris' | 'eyesClosed' | 'smile' | 'mouthOpen' | 'leg' | 'butterfly';
  phys?: { group: string; root: [number, number]; len: number; weight?: number };
  /** 瞳孔：这只眼在母版里的中心。 */
  eye?: [number, number];
  /** 张嘴：嘴的中心。 */
  mouth?: [number, number];
  /** 小腿：膝盖（转轴）。 */
  knee?: [number, number];
  /** 蝴蝶：身体中心。 */
  center?: [number, number];
  /** 闭眼：眼皮从哪合到哪（图层内 0..1）、睫毛颜色。 */
  lid?: { top: number; line: number; color: [number, number, number] };
  stencilWrite?: number;
  stencilTest?: number;
}

export interface RigData {
  canvas: { w: number; h: number };
  pivots: { neck: [number, number]; face: [number, number, number, number]; hip: [number, number]; top: number };
  limits: Record<string, number>;
  physics: Record<string, { k: number; c: number; gain: number; wind: number }>;
  parts: PartDef[];
}

export interface RigParams {
  angleX: number; angleY: number; angleZ: number;   // 头：左右转、抬低头、歪头，-1..1
  bodyX: number; bodyZ: number;                     // 身体：左右偏、侧倾，-1..1
  breath: number;                                   // 0..1
  eyeOpen: number;                                  // 0 闭 .. 1 睁
  eyeX: number; eyeY: number;                       // 瞳孔，-1..1
  mouth: number;                                    // 0..1
  smile: number;                                    // 笑眼覆盖层，0..1
  legL: number; legR: number;                       // 小腿摆，-1..1
  flap: number;                                     // 蝴蝶翅膀张开程度，0 合 .. 1 张
  flyX: number; flyY: number; flyTilt: number;      // 蝴蝶离开枝头的位移（母版像素）和倾角（弧度）
}

export const DEFAULT_PARAMS: RigParams = {
  angleX: 0, angleY: 0, angleZ: 0, bodyX: 0, bodyZ: 0, breath: 0, eyeOpen: 1, eyeX: 0, eyeY: 0,
  mouth: 0, smile: 0, legL: 0, legR: 0, flap: 1, flyX: 0, flyY: 0, flyTilt: 0,
};

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform vec2 uView; uniform vec2 uOrigin;
out vec2 vUv;
void main() {
  vec2 p = (aPos - uOrigin) * uView;
  gl_Position = vec4(p.x - 1.0, 1.0 - p.y, 0.0, 1.0);
  vUv = aUv;
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; uniform float uAlpha; uniform float uCut;
uniform float uWipe;   // 眼皮边缘在图层里的纵坐标（0..1），<0 表示不用
uniform float uPhase2; // 合到底之后，闭眼图其余部分淡入的程度
uniform float uBand;   // 1 = 只画睫毛线（配合模板，只落在眼睛开口里）
uniform vec3 uLash;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);
  if (c.a < uCut) discard;
  if (uWipe >= 0.0) {
    float edge = exp(-pow((vUv.y - uWipe) / 0.03, 2.0)) * (1.0 - uPhase2);
    if (uBand > 0.5) { o = vec4(uLash, 1.0) * edge * 0.95 * uAlpha; return; }
    // smoothstep 的两个边界必须由小到大，反过来结果未定义（D3D 上会得到半透明）
    float above = 1.0 - smoothstep(uWipe - 0.01, uWipe + 0.03, vUv.y);
    c *= max(above, uPhase2);
  }
  o = c * uAlpha;   // 纹理已预乘
}`;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** 一组头发 / 发尾的阻尼摆。驱动 = 头和身体的角速度 + 拖动 + 风。 */
class Pendulum {
  theta = 0; v = 0; t = Math.random() * 100;
  constructor(public k: number, public c: number, public gain: number, public wind: number) {}
  step(dt: number, drive: number) {
    this.t += dt;
    const wind = this.wind * (Math.sin(this.t * 1.3) * 0.6 + Math.sin(this.t * 2.9 + 1.7) * 0.4);
    const a = -this.k * (this.theta - wind) - this.c * this.v + drive * this.gain;
    this.v += a * dt;
    this.theta = clamp(this.theta + this.v * dt, -0.6, 0.6);
  }
}

interface Part extends PartDef {
  rest: Float32Array;
  cur: Float32Array;
  pos: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  tex: WebGLTexture;
  count: number;
}

export class Puppet {
  readonly gl: WebGL2RenderingContext;
  p: RigParams = { ...DEFAULT_PARAMS };
  private prev: RigParams = { ...DEFAULT_PARAMS };
  private phys = new Map<string, Pendulum>();
  /** 窗口被拖动的速度（页面像素 / 秒）。 */
  drag = { vx: 0, vy: 0 };
  /** 母版里要画进画布的区域。 */
  view = { x: 0, y: 0, w: 1, h: 1 };
  private parts: Part[] = [];
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null>;
  private aPos: number;
  private aUv: number;

  constructor(readonly canvas: HTMLCanvasElement, readonly rig: RigData, images: Record<string, TexImageSource>) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, stencil: true, antialias: true });
    if (!gl) throw new Error('no-webgl2');
    this.gl = gl;
    for (const [g, o] of Object.entries(rig.physics || {})) this.phys.set(g, new Pendulum(o.k, o.c, o.gain, o.wind));
    this.prog = this.program();
    const u = (n: string) => gl.getUniformLocation(this.prog, n);
    this.loc = { uView: u('uView'), uOrigin: u('uOrigin'), uTex: u('uTex'), uAlpha: u('uAlpha'), uCut: u('uCut'), uWipe: u('uWipe'), uPhase2: u('uPhase2'), uBand: u('uBand'), uLash: u('uLash') };
    this.aPos = gl.getAttribLocation(this.prog, 'aPos');
    this.aUv = gl.getAttribLocation(this.prog, 'aUv');
    this.parts = rig.parts.slice().sort((a, b) => a.z - b.z).map((d) => this.part(d, images[d.id]));
    this.view = { x: 0, y: 0, w: rig.canvas.w, h: rig.canvas.h };
  }

  private program(): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return p;
  }

  private part(d: PartDef, img: TexImageSource | undefined): Part {
    const gl = this.gl;
    const [nx, ny] = d.grid || [6, 6];
    const n = (nx + 1) * (ny + 1);
    const rest = new Float32Array(n * 2), uv = new Float32Array(n * 2);
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      rest[k * 2] = d.x + (d.w * i) / nx; rest[k * 2 + 1] = d.y + (d.h * j) / ny;
      uv[k * 2] = i / nx; uv[k * 2 + 1] = j / ny;
    }
    const idx: number[] = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1;
      idx.push(a, b, c, b, e, c);
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, rest, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    const uvb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvb); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.aUv); gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    // 她平时只显示到源图的三四成：用 mipmap 三线性缩小，免得锯齿和闪烁
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { ...d, rest, cur: new Float32Array(rest.length), pos, vao, tex, count: idx.length };
  }

  /** 推进物理，再算每个图层的顶点。 */
  update(dt: number) {
    dt = clamp(dt, 0, 1 / 20);
    const p = this.p, q = this.prev;
    const inv = 1 / Math.max(dt, 1e-3);
    const headV = ((p.angleX - q.angleX) + (p.angleZ - q.angleZ) * 1.6 + (p.bodyZ - q.bodyZ) * 1.2) * inv;
    const bodyV = ((p.bodyZ - q.bodyZ) * 1.5 + (p.bodyX - q.bodyX)) * inv;
    const dragA = -this.drag.vx * 0.0009;
    for (const [g, pd] of this.phys) {
      const onHead = g === 'bangs' || g.startsWith('side');
      pd.step(dt, (onHead ? headV * 0.9 : bodyV * 0.8 + headV * 0.2) + dragA);
    }
    this.prev = { ...p };
    for (const part of this.parts) this.deform(part);
  }

  private deform(part: Part) {
    const p = this.p, r = this.rig, L = r.limits, rest = part.rest, cur = part.cur;
    const neck = r.pivots.neck, hip = r.pivots.hip, face = r.pivots.face;
    const roll = (p.angleZ * (L.roll ?? 7) * Math.PI) / 180;
    const bodyRoll = (p.bodyZ * (L.bodyRoll ?? 1.5) * Math.PI) / 180;
    const shiftX = L.turnX ?? 18, shiftY = L.turnY ?? 10;
    const ph = part.phys ? this.phys.get(part.phys.group) : undefined;
    const cr = Math.cos(roll), sr = Math.sin(roll), cb = Math.cos(bodyRoll), sb = Math.sin(bodyRoll);
    let legC = 1, legS = 0;
    if (part.kind === 'leg' && part.knee) {
      const a = ((part.id === 'legL' ? p.legL : p.legR) * (L.legSwing ?? 7) * Math.PI) / 180;
      legC = Math.cos(a); legS = Math.sin(a);
    }
    for (let k = 0; k < rest.length; k += 2) {
      let x = rest[k], y = rest[k + 1];
      // 1. 头发 / 发尾：绕根部弯，越往梢越弯
      if (ph && part.phys) {
        const [rx, ry] = part.phys.root;
        const t = clamp((y - ry) / part.phys.len, 0, 1);
        const a = ph.theta * smooth(t) * (part.phys.weight ?? 1);
        const dx = x - rx, dy = y - ry, c = Math.cos(a), s = Math.sin(a);
        x = rx + dx * c - dy * s; y = ry + dx * s + dy * c;
      }
      // 2. 小腿：绕膝盖转
      if (legS !== 0 && part.knee) {
        const [kx, ky] = part.knee;
        const dx = x - kx, dy = y - ky;
        x = kx + dx * legC - dy * legS; y = ky + dx * legS + dy * legC;
      }
      // 3. 头：视差（越靠前的层挪得越多）+ 脸的球面错位 + 绕脖子歪头
      if (part.head) {
        const d = part.depth ?? 0;
        let sx = p.angleX * shiftX * d, sy = -p.angleY * shiftY * d;
        if (part.sphere) {
          const u = clamp((x - face[0]) / face[2], -1.2, 1.2), v = clamp((y - face[1]) / face[3], -1.2, 1.2);
          const prof = Math.max(0, 1 - u * u * 0.8) * Math.max(0, 1 - v * v * 0.5);
          sx = p.angleX * shiftX * (0.25 + 0.75 * prof) * d;
          sy = -p.angleY * shiftY * (0.25 + 0.75 * Math.max(0, 1 - u * u)) * d;
        }
        x += sx; y += sy;
        const dx = x - neck[0], dy = y - neck[1];
        x = neck[0] + dx * cr - dy * sr; y = neck[1] + dx * sr + dy * cr;
      }
      // 4. 身体：呼吸（髋以上往上抬，越往上越多）+ 左右偏
      if (y < hip[1]) {
        const t = clamp((hip[1] - y) / (hip[1] - r.pivots.top), 0, 1);
        y -= p.breath * (L.breath ?? 5) * smooth(t);
        x += p.bodyX * (L.bodyX ?? 3) * smooth(t);
      }
      // 5. 整个人随树枝轻轻侧倾（绕髋）
      const dx = x - hip[0], dy = y - hip[1];
      cur[k] = hip[0] + dx * cb - dy * sb; cur[k + 1] = hip[1] + dx * sb + dy * cb;
    }
    if (part.kind === 'iris' && part.eye) {
      const mx = p.eyeX * (L.irisX ?? 8), my = -p.eyeY * (L.irisY ?? 4);
      const cy = this.moved(part, part.eye[0], part.eye[1])[1];
      const squash = 0.35 + 0.65 * p.eyeOpen;
      for (let k = 0; k < cur.length; k += 2) { cur[k] += mx; cur[k + 1] = cy + (cur[k + 1] - cy) * squash + my; }
    }
    if (part.kind === 'mouthOpen' && part.mouth) {
      const cy = this.moved(part, part.mouth[0], part.mouth[1])[1];
      const s = 0.35 + 0.65 * p.mouth;
      for (let k = 0; k < cur.length; k += 2) cur[k + 1] = cy + (cur[k + 1] - cy) * s;
    }
    if (part.kind === 'butterfly' && part.center) {
      // 扇翅：沿身体中线横向压扁；飞：整体平移加一点倾角
      const [cx0, cy0] = this.moved(part, part.center[0], part.center[1]);
      const sx = 0.22 + 0.78 * clamp(p.flap, 0, 1);
      const ct = Math.cos(p.flyTilt), st = Math.sin(p.flyTilt);
      for (let k = 0; k < cur.length; k += 2) {
        const dx = (cur[k] - cx0) * sx, dy = cur[k + 1] - cy0;
        cur[k] = cx0 + dx * ct - dy * st + p.flyX;
        cur[k + 1] = cy0 + dx * st + dy * ct + p.flyY;
      }
    }
  }

  /** 一个母版点经过同一图层变形后的位置（取最近的网格点的位移）。 */
  private moved(part: Part, x: number, y: number): [number, number] {
    let best = 0, bd = Infinity;
    for (let k = 0; k < part.rest.length; k += 2) {
      const d = (part.rest[k] - x) ** 2 + (part.rest[k + 1] - y) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return [x + part.cur[best] - part.rest[best], y + part.cur[best + 1] - part.rest[best + 1]];
  }

  private alpha(part: Part): number {
    const p = this.p;
    switch (part.kind) {
      case 'eyesClosed': return part.lid ? (p.eyeOpen < 0.998 ? 1 : 0) : clamp(1 - p.eyeOpen, 0, 1);
      case 'mouthOpen': return clamp(p.mouth * 1.6, 0, 1);
      case 'smile': return clamp(p.smile, 0, 1);
      default: return 1;
    }
  }

  /** 画进画布（画布的设备像素尺寸由调用方定好，见 index.ts 的 fit：页面用了 CSS zoom，clientWidth 不含缩放）。 */
  render() {
    const gl = this.gl, c = this.canvas;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const v = this.view, L = this.loc;
    gl.uniform2f(L.uView, 2 / v.w, 2 / v.h);
    gl.uniform2f(L.uOrigin, v.x, v.y);
    gl.uniform1i(L.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const part of this.parts) {
      const a = this.alpha(part);
      if (a <= 0.002) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, part.pos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, part.cur);
      gl.bindVertexArray(part.vao);
      gl.bindTexture(gl.TEXTURE_2D, part.tex);
      gl.uniform1f(L.uAlpha, a);
      gl.uniform1f(L.uWipe, -1); gl.uniform1f(L.uBand, 0); gl.uniform1f(L.uCut, 0);
      if (part.kind === 'eyesClosed' && part.lid) {
        // 眼皮：前七成时间从睁眼上沿合到闭眼线下一点，边缘带睫毛线；后三成把画好的闭眼图淡入
        const q = clamp(1 - this.p.eyeOpen, 0, 1), lid = part.lid;
        const ph1 = smooth(clamp(q / 0.7, 0, 1)), ph2 = clamp((q - 0.7) / 0.3, 0, 1);
        gl.uniform1f(L.uWipe, lid.top + (lid.line + 0.06 - lid.top) * ph1);
        gl.uniform1f(L.uPhase2, ph2);
        gl.uniform3f(L.uLash, lid.color[0], lid.color[1], lid.color[2]);
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
        gl.enable(gl.STENCIL_TEST);                 // 睫毛线只画在眼睛开口里
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.uniform1f(L.uBand, 1);
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.STENCIL_TEST);
        continue;
      }
      if (part.stencilWrite) {         // 眼白：画出来，同时在模板里记下「这里是眼睛」
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, part.stencilWrite, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.uniform1f(L.uCut, 0.5);
        gl.colorMask(false, false, false, false);
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
        gl.colorMask(true, true, true, true);
        gl.disable(gl.STENCIL_TEST);
        gl.uniform1f(L.uCut, 0);
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
      } else if (part.stencilTest) {   // 瞳孔：只画在眼白里
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.EQUAL, part.stencilTest, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
        gl.disable(gl.STENCIL_TEST);
      } else {
        gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.gl;
    for (const p of this.parts) { gl.deleteTexture(p.tex); gl.deleteBuffer(p.pos); gl.deleteVertexArray(p.vao); }
    gl.deleteProgram(this.prog);
    this.parts = [];
  }
}
