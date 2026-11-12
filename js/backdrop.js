// Live wallpaper behind the dash.
//   PEARL: neon pearl balls drifting on black. Each ball has a thin-film sheen that shifts pink /
//          cyan / violet as it turns, a bright rim in the accent colour and a soft glow around it.
//   BLACK: pure black (#000), nothing drawn: on an OLED iPhone the panels and numbers float on true black.
// Drawn in a WebGL fragment shader at reduced resolution and ~30 fps (it is soft, so that looks the
// same and saves battery). Stops when the page is hidden; draws one still frame with reduced motion.

const VS = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `precision mediump float;
uniform vec2 res; uniform float t; uniform vec3 accent; uniform float bright;

// iridescent thin-film colour: cosine palette over the film "thickness"
vec3 film(float x) { return 0.55 + 0.45 * cos(6.2831 * (x + vec3(0.0, 0.33, 0.67))); }

vec3 ball(vec2 uv, vec2 c, float r, float seed, inout float glow) {
  vec2 d = (uv - c) / r;
  float q = dot(d, d);
  glow += exp(-max(0.0, sqrt(q) - 1.0) * 3.2) * r * 1.4;           // halo outside the ball
  if (q > 1.0) return vec3(0.0);
  vec3 n = vec3(d, sqrt(1.0 - q));                                   // sphere normal
  float spin = t * 0.07 + seed;
  vec3 l = normalize(vec3(cos(spin) * 0.6 - 0.4, sin(spin * 0.8) * 0.5 + 0.55, 0.8));
  float diff = max(dot(n, l), 0.0);
  float fres = pow(1.0 - n.z, 2.6);
  // pearl body: soft milky base, film colour sliding with the angle and slowly with time
  float th = n.x * 0.35 + n.y * 0.55 + fres * 0.9 + t * 0.025 + seed;
  vec3 pearl = mix(vec3(0.92, 0.88, 0.95), film(th), 0.55 + 0.35 * fres);
  vec3 col = pearl * (0.22 + 0.78 * diff);
  col += pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 38.0) * 0.9;   // highlight
  col = mix(col, accent * 1.6, fres * 0.75);                                     // neon rim
  col *= smoothstep(1.0, 0.94, q);                                               // soft edge
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
  float glow = 0.0;
  vec3 col = vec3(0.0);
  // three pearls on slow, different orbits (big hero ball low right, two smaller ones)
  col += ball(uv, vec2(0.28 + 0.06 * sin(t * 0.11), -0.30 + 0.05 * cos(t * 0.09)), 0.42, 0.0, glow);
  col += ball(uv, vec2(-0.36 + 0.07 * cos(t * 0.07), 0.38 + 0.06 * sin(t * 0.13)), 0.20, 2.1, glow);
  col += ball(uv, vec2(-0.05 + 0.12 * sin(t * 0.05 + 1.0), 0.02 + 0.10 * cos(t * 0.06)), 0.09, 4.3, glow);
  col += accent * glow * 0.10;
  // faint coloured haze so the black isn't flat, and a vignette
  col += film(uv.x * 0.4 + uv.y * 0.3 + t * 0.01) * 0.025;
  col *= 1.0 - 0.45 * dot(uv * 0.9, uv * 0.9);
  gl_FragColor = vec4(col * bright, 1.0);
}`;

export class Backdrop {
  constructor(canvas) {
    this.c = canvas; this.mode = 'BLACK'; this.accent = '#ff263e'; this.bright = 1; this.gl = null; this.last = 0;
    this.still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    addEventListener('resize', () => this._size());
  }
  setMode(mode) {
    this.mode = mode;
    document.body.classList.toggle('bg-pearl', mode === 'PEARL');
    this.c.style.display = mode === 'PEARL' ? 'block' : 'none';
    if (mode === 'PEARL' && !this.gl) this._init();
    this.last = 0;
  }
  _init() {
    const gl = this.c.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) { this.setMode('BLACK'); return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try {
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      gl.useProgram(pr);
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      this.u = { res: gl.getUniformLocation(pr, 'res'), t: gl.getUniformLocation(pr, 't'), accent: gl.getUniformLocation(pr, 'accent'), bright: gl.getUniformLocation(pr, 'bright') };
      this.gl = gl;
      this.c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
      this.c.addEventListener('webglcontextrestored', () => this._init());
      this._size();
    } catch (e) { console.warn('backdrop off:', e.message); this.setMode('BLACK'); }
  }
  _size() {
    const s = 0.5 * Math.min(2, devicePixelRatio || 1);   // half resolution: it's all soft gradients
    const w = Math.round(innerWidth * s), h = Math.round(innerHeight * s);
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; this.last = 0; }
  }
  /** Call every frame; draws at most ~30 times a second. */
  frame(now) {
    if (this.mode !== 'PEARL' || !this.gl || document.hidden) return;
    if (this.last && (this.still || now - this.last < 33)) return;
    this.last = now;
    const gl = this.gl, n = parseInt(this.accent.slice(1), 16);
    gl.viewport(0, 0, this.c.width, this.c.height);
    gl.uniform2f(this.u.res, this.c.width, this.c.height);
    gl.uniform1f(this.u.t, this.still ? 20 : now / 1000);
    gl.uniform3f(this.u.accent, (n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
    gl.uniform1f(this.u.bright, this.bright);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
