// Red wireframe Z from the CAD-derived model (data/z-model.json, millimetres, x forward / y left / z up).
// The camera eases toward the chosen view, so switching views glides instead of jumping, and AUTO
// orbits continuously. While the camera moves the car is drawn live (one path, ~9k segments);
// once a fixed view has settled, that frame is cached and reused.
const ORBIT_DEG_S = 9;
const VIEWS = { AUTO: null, '3/4': [35, 16, 7], SIDE: [90, 4, 7.5], TOP: [90, 75, 7.5], CHASE: [180, 14, 6.5] };
export const VIEW_NAMES = Object.keys(VIEWS);
export const ANCHORS = { front: [1.9, 0, 0.8], rear: [-2.2, -0.35, 0.35], cabin: [-0.2, 0, 1.28] };
const TAU = 0.28; // seconds: how quickly the camera catches up with its target

export class Wire {
  constructor() {
    this.view = 'AUTO'; this.model = null; this.color = '#ff263e';
    this.cam = null; this.lastT = null; this.cache = null; this.cacheKey = ''; this._locked = false;
    this.lines = document.createElement('canvas'); this.small = document.createElement('canvas');
  }
  async load(url) {
    const m = await (await fetch(url)).json();
    const pts = Float32Array.from(m.mm, (v) => v / 1000);
    this.model = { credit: m.credit, starts: m.starts, pts, n: pts.length / 3 };
    this.sx = new Float32Array(this.model.n); this.sy = new Float32Array(this.model.n);
  }
  target(t) { return this.view === 'AUTO' ? [30 + t * ORBIT_DEG_S, 15, 7.2] : VIEWS[this.view]; }
  setView(v) { if (v !== this.view) { this.view = v; this._locked = false; } }
  // Moves the camera one frame toward its target. Returns true while the picture is changing.
  step(t) {
    const tg = this.target(t);
    if (!this.cam) { this.cam = tg.slice(); this.lastT = t; this._locked = true; return this.view === 'AUTO'; }
    const dt = Math.min(0.1, Math.max(0, t - this.lastT)); this.lastT = t;
    if (this._locked) { this.cam = tg.slice(); return this.view === 'AUTO'; }   // on target: follow it exactly
    const k = 1 - Math.exp(-dt / TAU);
    const dy = ((tg[0] - this.cam[0]) % 360 + 540) % 360 - 180;                    // shortest way round
    this.cam[0] += dy * k; this.cam[1] += (tg[1] - this.cam[1]) * k; this.cam[2] += (tg[2] - this.cam[2]) * k;
    if (Math.abs(dy) < 0.05 && Math.abs(tg[1] - this.cam[1]) < 0.05 && Math.abs(tg[2] - this.cam[2]) < 0.005) {
      this.cam = tg.slice(); this._locked = true;
    }
    return true;
  }
  _basis(cam, w, h) {
    const ry = cam[0] * Math.PI / 180, rp = cam[1] * Math.PI / 180;
    return { cy: Math.cos(ry), sy: Math.sin(ry), cp: Math.cos(rp), sp: Math.sin(rp), dist: cam[2], f: Math.min(w * 0.7, h * 0.78) * 2.1, w, h };
  }
  _p(x, y, z, b) {
    z -= 0.6;
    const xr = x * b.cy - y * b.sy, yr = x * b.sy + y * b.cy, d = b.dist - (xr * b.cp + z * b.sp);
    return [b.w / 2 + b.f * yr / d, b.h * 0.5 - b.f * (z * b.cp - xr * b.sp) / d];
  }
  anchors(w, h) { const b = this._basis(this.cam, w, h), o = {}; for (const k in ANCHORS) o[k] = this._p(...ANCHORS[k], b); return o; }
  _paint(ctx, w, h) {
    const { pts, starts, n } = this.model, b = this._basis(this.cam, w, h), sx = this.sx, sy = this.sy;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2] - 0.6;
      const xr = x * b.cy - y * b.sy, yr = x * b.sy + y * b.cy, d = b.dist - (xr * b.cp + z * b.sp);
      sx[i] = b.w / 2 + b.f * yr / d; sy[i] = b.h * 0.5 - b.f * (z * b.cp - xr * b.sp) / d;
    }
    const L = this.lines; if (L.width !== w || L.height !== h) { L.width = w; L.height = h; }
    const lc = L.getContext('2d'); lc.clearRect(0, 0, w, h);
    lc.strokeStyle = this.color; lc.lineWidth = Math.max(1, w / 560); lc.globalAlpha = 0.8; lc.lineJoin = 'round'; lc.beginPath();
    for (let s = 0; s + 1 < starts.length; s++) {
      const a = starts[s], e = starts[s + 1];
      lc.moveTo(sx[a], sy[a]); for (let i = a + 1; i < e; i++) lc.lineTo(sx[i], sy[i]);
    }
    lc.stroke();
    // bloom: shrink, then stretch back with smoothing (a blur that works everywhere, Safari included)
    const S = this.small, sw = Math.max(1, w >> 3), sh = Math.max(1, h >> 3);
    if (S.width !== sw || S.height !== sh) { S.width = sw; S.height = sh; }
    const sc = S.getContext('2d'); sc.clearRect(0, 0, sw, sh); sc.drawImage(L, 0, 0, sw, sh);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5;
    ctx.drawImage(S, 0, 0, w, h);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(L, 0, 0);
  }
  // ---- WebGL path: the same projection in a vertex shader; ~9k line segments cost well under 1 ms.
  _initGL(canvas) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = (vs, fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; };
    const lines = prog(`attribute vec3 p; uniform vec4 rot; uniform vec4 cam;  // rot: cy sy cp sp, cam: dist f w h
      void main() { vec3 q = p; q.z -= 0.6;
        float xr = q.x * rot.x - q.y * rot.y, yr = q.x * rot.y + q.y * rot.x, d = cam.x - (xr * rot.z + q.z * rot.w);
        vec2 s = vec2(cam.z * 0.5 + cam.y * yr / d, cam.w * 0.5 - cam.y * (q.z * rot.z - xr * rot.w) / d);
        gl_Position = vec4(s.x / cam.z * 2.0 - 1.0, 1.0 - s.y / cam.w * 2.0, 0.0, 1.0); }`,
      `precision mediump float; uniform vec4 col; void main() { gl_FragColor = vec4(col.rgb * col.a, col.a); }`);
    const quad = prog(`attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`,
      `precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform float k; void main() { gl_FragColor = texture2D(tex, uv) * k; }`);
    const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, this.model.pts, gl.STATIC_DRAW);
    const idx = []; const st = this.model.starts;
    for (let s = 0; s + 1 < st.length; s++) for (let i = st[s]; i + 1 < st[s + 1]; i++) idx.push(i, i + 1);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = gl.createTexture(), fb = gl.createFramebuffer();
    return { gl, lines, quad, pos, ib, qb, tex, fb, count: idx.length, fbw: 0, fbh: 0 };
  }
  _paintGL(w, h) {
    const G = this.G, gl = G.gl, b = this._basis(this.cam, w, h);
    const c = this.color.match(/\w\w/g).map((x) => parseInt(x, 16) / 255);
    const lw = Math.max(1, w >> 2), lh = Math.max(1, h >> 2);
    if (G.fbw !== lw || G.fbh !== lh) {   // quarter-size target for the glow
      gl.bindTexture(gl.TEXTURE_2D, G.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lw, lh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
      gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, G.tex, 0);
      G.fbw = lw; G.fbh = lh;
    }
    const drawLines = (alpha) => {
      gl.useProgram(G.lines);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.pos); const a = gl.getAttribLocation(G.lines, 'p'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(gl.getUniformLocation(G.lines, 'rot'), b.cy, b.sy, b.cp, b.sp);
      gl.uniform4f(gl.getUniformLocation(G.lines, 'cam'), b.dist, b.f, w, h);
      gl.uniform4f(gl.getUniformLocation(G.lines, 'col'), c[0], c[1], c[2], alpha);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, G.ib); gl.drawElements(gl.LINES, G.count, gl.UNSIGNED_SHORT, 0);
      gl.disableVertexAttribArray(a);
    };
    // Normal "over" blending everywhere the lines are drawn, so dense areas stay the accent colour
    // instead of adding up to white. Only the soft glow is added on top.
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb); gl.viewport(0, 0, lw, lh); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    drawLines(0.9);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(G.quad); gl.bindBuffer(gl.ARRAY_BUFFER, G.qb);
    const qa = gl.getAttribLocation(G.quad, 'p'); gl.enableVertexAttribArray(qa); gl.vertexAttribPointer(qa, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, G.tex); gl.uniform1f(gl.getUniformLocation(G.quad, 'k'), 0.45);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(qa);
    drawLines(0.85);
  }
  // canvas: the <canvas> to draw into. Uses WebGL when available, else the 2D path above.
  draw(canvas, w, h, t) {
    if (!this.model) return null;
    if (this.G === undefined) { try { this.G = this._initGL(canvas); } catch (e) { console.warn('WebGL off:', e.message); this.G = null; } }
    const moving = this.step(t);
    const key = `${this.view}|${w}x${h}|${this.color}`;
    if (this.G) {
      if (moving || key !== this.cacheKey) { this._paintGL(w, h); this.cacheKey = moving ? '' : key; }
      return this.anchors(w, h);
    }
    const ctx = this.ctx2d || (this.ctx2d = canvas.getContext('2d'));
    if (moving || key !== this.cacheKey) {
      this._paint(ctx, w, h);
      if (!moving) {   // settled on a fixed view: keep this frame and reuse it
        if (!this.cache) this.cache = document.createElement('canvas');
        this.cache.width = w; this.cache.height = h; this.cache.getContext('2d').drawImage(ctx.canvas, 0, 0);
        this.cacheKey = key;
      } else this.cacheKey = '';
    } else { ctx.clearRect(0, 0, w, h); ctx.drawImage(this.cache, 0, 0); }
    return this.anchors(w, h);
  }
}
