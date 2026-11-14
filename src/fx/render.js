/* =====================================================================
 * Alev Laboratuvarı — Yangın ve patlama efektleri: çizim
 * ---------------------------------------------------------------------
 * Kare hızını koruyan düzen (ignition-fx'ten):
 *   - Bütün alev, duman ve kıvılcımlar 3 çizim çağrısıdır (örneklenmiş panolar).
 *   - Alev ve duman yarım çözünürlüklü ayrı bir HDR tampona çizilir, sahne
 *     derinliğiyle yumuşak kesişir ve kareye bindirilir: doldurma maliyeti
 *     dörtte bire iner; yumuşak biçimler olduklarından fark görünmez.
 *   - Şok dalgası kırılması ve ısı titreşimi aynı bindirme geçişindedir.
 *   - Enkaz tek bir örneklenmiş çizimdir.
 *   - Arabelleğin yalnız yeni yazılan aralığı GPU'ya yüklenir.
 * Sahne derinliği ışın yürütücünün aux.a kanalından okunur; efektler TAA'dan
 * sonra, obtüratör / alan derinliği / parlama zincirinden önce eklenir:
 * fiziksel kamera onları sahnenin parçası olarak görür.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const STRIDE = 20;
/** Alevin görüntüdeki ışıklılık ölçeği [cd/m²]: kurumlu difüzyon alevi ~10⁴ cd/m² mertebesinde */
const FLAME_NIT = 4200;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function periodicFbm(size, basePeriod, octaves, seed) {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amplitude = 1, total = 0, period = basePeriod;
  for (let o = 0; o < octaves && period <= size; o++) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const scale = period / size;
    for (let y = 0; y < size; y++) {
      const fy = y * scale;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % period) * period, yb = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = x * scale;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % period, xb = (x0 + 1) % period;
        const top = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * sx;
        const bottom = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * sx;
        out[y * size + x] += (top + (bottom - top) * sy) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
    period *= 2;
  }
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < out.length; i++) { out[i] /= total; if (out[i] < min) min = out[i]; if (out[i] > max) max = out[i]; }
  const range = max - min || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / range;
  return out;
}

/** Yırtılmış plaka: biraz kalınlığı olan düzensiz çokgen */
function shardGeometry() {
  const rand = mulberry32(2024);
  const sides = 6;
  const top = [], bottom = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    const radius = 0.55 + rand() * 0.75;
    const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
    top.push([x, 0.07 + rand() * 0.1, z]);
    bottom.push([x * 0.9, -0.07 - rand() * 0.1, z * 0.9]);
  }
  const pos = [], nor = [];
  const tri = (a, b, c) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / l);
    pos.push(...a, ...b, ...c);
    nor.push(...n, ...n, ...n);
  };
  const ct = [0, 0.16, 0], cb = [0, -0.16, 0];
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(ct, top[j], top[i]);
    tri(cb, bottom[i], bottom[j]);
    tri(top[i], top[j], bottom[j]);
    tri(top[i], bottom[j], bottom[i]);
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), count: pos.length / 3 };
}

class FxRenderer {
  constructor(glc) {
    this.glc = glc;
    this.gl = glc.gl;
    const gl = this.gl;
    const S = FL.FX_SHADERS;
    this.P = {
      fire: glc.program('fxFire', S.fireFS(), S.particleVS(false)),
      smoke: glc.program('fxSmoke', S.smokeFS(), S.particleVS(false)),
      spark: glc.program('fxSpark', S.sparkFS(), S.particleVS(true)),
      comp: glc.program('fxComposite', S.compositeFS()),
      debris: glc.program('fxDebris', S.debrisFS(), S.debrisVS()),
    };
    this.particleScale = 0.5;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this._noise();
    this.channels = new Map();
    this._shock = new Float32Array(S.MAX_SHOCK * 4);
    this._shockW = new Float32Array(S.MAX_SHOCK);
    this.burnTex = null;
    this.burnGrid = null;
    this._burnVer = -1;
    this.dummyBurn = this._tex3D(1, 1, 1, new Uint8Array([0, 0]));
  }

  /** Döşenebilir fBm gürültüsü, kanal başına ayrı alan: gölgelendiriciler hesap yerine doku okur */
  _noise() {
    const gl = this.gl;
    const size = 256;
    const ch = [periodicFbm(size, 4, 6, 1337), periodicFbm(size, 8, 5, 7331), periodicFbm(size, 16, 4, 4242), periodicFbm(size, 32, 3, 9001)];
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(ch[c][i] * 255);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.noise = { handle: t, w: size, h: size };
  }

  _tex3D(nx, ny, nz, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, nx, ny, nz, 0, gl.RG, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return { handle: t, is3D: true, w: nx, h: ny, d: nz };
  }

  /* -------------------------------------------------------------- */
  /* Yanık izi hacim dokusu                                          */
  /* -------------------------------------------------------------- */
  /** Model uzayındaki SDF ızgarasından türetilen, hücre aralığına uygun kaba ızgara */
  syncBurn(sys, ms) {
    if (!sys || !sys.scene || !ms || !ms.ready || !ms.sdfGrid) { this.burnOn = false; return; }
    const sg = ms.sdfGrid;
    const key = ms.version + '|' + sg.n.join(',') + '|' + sys.spacing.toFixed(4) + '|' + sys.stats.cells;
    if (key !== this._burnKey) {
      this._burnKey = key;
      const d = Math.max(2 * sg.d, sys.spacing * 0.7);
      const ext = sg.n.map((n) => (n - 1) * sg.d);
      const n = ext.map((e) => Math.max(2, Math.min(160, Math.ceil(e / d) + 1)));
      this.burnGrid = { o: sg.o.slice(), d, n };
      if (this.burnTex) this.gl.deleteTexture(this.burnTex.handle);
      this.burnTex = this._tex3D(n[0], n[1], n[2], new Uint8Array(n[0] * n[1] * n[2] * 2));
      this._burnVer = -1;
    }
    if (this._burnVer !== sys.burnVersion) {
      this._burnVer = sys.burnVersion;
      const gl = this.gl;
      const g = this.burnGrid;
      const data = sys.burnVolume(g);
      gl.bindTexture(gl.TEXTURE_3D, this.burnTex.handle);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, g.n[0], g.n[1], g.n[2], gl.RG, gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    this.burnOn = true;
  }

  /** Model G-tamponu geçişinin yanık izi uniform'ları */
  burnUniforms(sys) {
    if (!this.burnOn || !this.burnTex) return { uFxOn: 0, uFxBurn: this.dummyBurn, uFxNoise: this.noise, uFxBGo: [0, 0, 0], uFxBGd: 1, uFxBGn: [1, 1, 1], uFxNoiseK: 1, uFxTime: 0 };
    const g = this.burnGrid;
    return {
      uFxOn: 1, uFxBurn: this.burnTex, uFxNoise: this.noise, uFxBGo: g.o, uFxBGd: g.d, uFxBGn: g.n,
      // Gürültü dokusu bir hücre aralığında ~0,2 kez döner: yanık kenarı hücre ızgarasını ele vermez
      uFxNoiseK: 0.2 / Math.max(sys.spacing, 0.005), uFxTime: sys.time,
    };
  }

  /* -------------------------------------------------------------- */
  /* Parçacık tamponları                                              */
  /* -------------------------------------------------------------- */
  _channel(ch) {
    let c = this.channels.get(ch);
    if (c) return c;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, ch.data.byteLength, gl.DYNAMIC_DRAW);
    for (let k = 0; k < 5; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, STRIDE * 4, 16 * k);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.bindVertexArray(null);
    c = { vao, buf };
    this.channels.set(ch, c);
    ch.cleared = true;
    return c;
  }

  /** Yalnız son kareden beri yazılan yuvaları yükle */
  _flush(ch) {
    const c = this._channel(ch);
    const gl = this.gl;
    if (ch.cleared) {
      ch.cleared = false;
      gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ch.data);
      ch.dirtyFrom = -1;
      ch.wrapped = false;
      return c;
    }
    if (ch.dirtyFrom < 0) return c;
    gl.bindBuffer(gl.ARRAY_BUFFER, c.buf);
    const sub = (from, to) => { if (to > from) gl.bufferSubData(gl.ARRAY_BUFFER, from * STRIDE * 4, ch.data, from * STRIDE, (to - from) * STRIDE); };
    if (ch.wrapped) {
      if (ch.head > ch.dirtyFrom) sub(0, ch.capacity);
      else { sub(ch.dirtyFrom, ch.capacity); sub(0, ch.head); }
    } else {
      sub(ch.dirtyFrom, ch.head);
    }
    ch.dirtyFrom = -1;
    ch.wrapped = false;
    return c;
  }

  _debris() {
    if (this.deb) return this.deb;
    const gl = this.gl;
    const geo = shardGeometry();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nb);
    gl.bufferData(gl.ARRAY_BUFFER, geo.nor, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.bufferData(gl.ARRAY_BUFFER, 512 * 16 * 4, gl.DYNAMIC_DRAW);
    for (let k = 0; k < 4; k++) {
      gl.enableVertexAttribArray(2 + k);
      gl.vertexAttribPointer(2 + k, k === 3 ? 3 : 4, gl.FLOAT, false, 64, 16 * k);
      gl.vertexAttribDivisor(2 + k, 1);
    }
    gl.bindVertexArray(null);
    this.deb = { vao, ib, count: geo.count, cap: 512 };
    return this.deb;
  }

  _targets(w, h) {
    const g = this.glc, gl = this.gl;
    const pw = Math.max(2, Math.round(w * this.particleScale)), ph = Math.max(2, Math.round(h * this.particleScale));
    const opts = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    if (!this.out || this.out.w !== w || this.out.h !== h) {
      if (this.out) { g.destroyTarget(this.out); gl.deleteFramebuffer(this.outFb); gl.deleteRenderbuffer(this.outRb); }
      this.out = g.target(w, h, opts);
      // Enkazın kendi içinde sıralanması için derinlik eki olan ikinci framebuffer
      this.outFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex.handle, 0);
      this.outRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.outRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.outRb);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (!this.pt || this.pt.w !== pw || this.pt.h !== ph) {
      if (this.pt) g.destroyTarget(this.pt);
      this.pt = g.target(pw, ph, opts);
    }
  }

  /**
   * Efektleri sahne rengine ekler ve yeni renk hedefini döndürür.
   * o: { sys, color, aux, cam, w, h, view, preExp, st, key, light, sun, ambL, heatRange, velRange }
   * view: 0 gerçekçi · 1 termal/sıcaklık · 2 maske · 3 ısı salınımı · 4 kurum · 5 hız · 6 türler ·
   *       7 Schlieren (yalnız parçacık tamponu; bileşik geçiş gradyanını alır) · 8 ışınım · 9 yapay zekâ
   */
  render(o) {
    const gl = this.gl, g = this.glc, sys = o.sys;
    const w = o.w, h = o.h;
    this._targets(w, h);
    const real = o.view === 0;
    const gain = real ? o.preExp : 1;
    const box = sys.box || { lo: [0, 0, 0], hi: [0, 0, 0], closed: false };
    const floorY = !box.closed && o.floor ? 0 : -1e6;
    const common = (P) => {
      gl.useProgram(P.handle);
      g.setUniform(P, 'uViewM', o.cam.view);
      g.setUniform(P, 'uProjM', o.cam.proj);
      g.setUniform(P, 'uTime', sys.time);
      g.setUniform(P, 'uBoxLo', box.lo);
      g.setUniform(P, 'uBoxHi', box.hi);
      g.setUniform(P, 'uBoxOn', box.closed ? 1 : 0);
      g.setUniform(P, 'uFloorY', floorY);
      g.setUniform(P, 'uCamPos', o.cam.eye);
      g.setUniform(P, 'uSoft', 0.03 * Math.max(sys.scale, 0.12));
      g.bindSampler(P, 'uDepth', o.aux.tex, 0);
      g.bindSampler(P, 'uNoise', this.noise, 1);
    };
    const lights = (P) => {
      g.setUniform(P, 'uAmbL', o.ambL);
      g.setUniform(P, 'uKey', o.key);
      g.setUniform(P, 'uFire', [o.light.pos[0], o.light.pos[1], o.light.pos[2], o.light.cd]);
      g.setUniform(P, 'uFireCol', o.light.col);
      g.setUniform(P, 'uSun', o.sun);
      g.setUniform(P, 'uGlowNit', FLAME_NIT);
    };

    // 1) Duman ve alev: yarım çözünürlüklü tampon, ön çarpılmış alfa
    const fc = this._flush(sys.fire), sc = this._flush(sys.smoke), kc = this._flush(sys.sparks);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pt.fbo.handle);
    gl.viewport(0, 0, this.pt.w, this.pt.h);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const inv = [1 / this.pt.w, 1 / this.pt.h];
    if ((real || o.view === 4 || o.view === 9) && sys.smoke.highWater > 0 && sys.smoke.live > 0) {
      const P = this.P.smoke;
      common(P);
      lights(P);
      g.setUniform(P, 'uInvViewport', inv);
      g.setUniform(P, 'uGain', gain);
      g.setUniform(P, 'uFxView', o.view);
      gl.bindVertexArray(sc.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sys.smoke.highWater);
    }
    if (sys.fire.highWater > 0 && sys.fire.live > 0) {
      const P = this.P.fire;
      common(P);
      g.setUniform(P, 'uInvViewport', inv);
      g.setUniform(P, 'uGain', gain * FLAME_NIT);
      g.setUniform(P, 'uFxView', o.view);
      g.setUniform(P, 'uHeatRange', o.heatRange || [300, 2200]);
      g.setUniform(P, 'uVelRange', o.velRange || 0.8);
      gl.bindVertexArray(fc.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sys.fire.highWater);
    }
    gl.disable(gl.BLEND);
    // Schlieren: sahne rengi kullanılmaz; yoğunluk açığı tamponu bileşik geçişe verilir
    if (o.view === 7) {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return o.color;
    }

    // 2) Bindirme: sahne + parçacıklar, şok kırılması, ısı titreşimi
    const S = FL.FX_SHADERS;
    const aspect = w / h;
    this._shock.fill(0);
    this._shockW.fill(0.05);
    if (real) {
      const M4 = FL.M4;
      const v = o.cam.view;
      const right = [v[0], v[4], v[8]];
      for (let i = 0; i < Math.min(S.MAX_SHOCK, sys.shockwaves.length); i++) {
        const wave = sys.shockwaves[i];
        const c = M4.transformPoint(o.cam.vp, wave.center);
        if (c[2] > 1 || c[2] < -1) continue;
        const e = M4.transformPoint(o.cam.vp, [wave.center[0] + right[0] * wave.radius, wave.center[1] + right[1] * wave.radius, wave.center[2] + right[2] * wave.radius]);
        const radius = Math.abs(e[0] - c[0]) * 0.5 * aspect;
        const fade = 1 - wave.age / wave.life;
        this._shock[i * 4] = c[0] * 0.5 + 0.5;
        this._shock[i * 4 + 1] = c[1] * 0.5 + 0.5;
        this._shock[i * 4 + 2] = radius;
        this._shock[i * 4 + 3] = wave.strength * fade * fade * 0.03;
        this._shockW[i] = Math.max(0.012, radius * 0.22);
      }
    }
    g.pass(this.P.comp, this.out, {
      tScene: o.color, tParticles: this.pt, uNoise: this.noise,
      uShock: this._shock, uShockWidth: this._shockW, uAspect: aspect, uTime: sys.time, uHaze: real ? 1 : 0,
    });

    // 3) Kıvılcımlar (keskin, tam çözünürlük, toplamalı) ve enkaz
    if (real) {
      const invF = [1 / w, 1 / h];
      if (sys.sparks.highWater > 0 && sys.sparks.live > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo.handle);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const P = this.P.spark;
        common(P);
        g.setUniform(P, 'uInvViewport', invF);
        g.setUniform(P, 'uGain', gain * FLAME_NIT);
        gl.bindVertexArray(kc.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sys.sparks.highWater);
        gl.disable(gl.BLEND);
      }
      const d = sys.debris;
      if (d.active > 0 && d.count > 0) {
        const deb = this._debris();
        gl.bindBuffer(gl.ARRAY_BUFFER, deb.ib);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.inst, 0, Math.min(d.count, deb.cap) * 16);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFb);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.clearBufferfv(gl.DEPTH, 0, [1]);
        const P = this.P.debris;
        gl.useProgram(P.handle);
        g.setUniform(P, 'uVP', o.cam.vp);
        g.setUniform(P, 'uCamPos', o.cam.eye);
        g.setUniform(P, 'uInvViewport', invF);
        g.setUniform(P, 'uGain', gain);
        g.bindSampler(P, 'uDepth', o.aux.tex, 0);
        lights(P);
        gl.bindVertexArray(deb.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, deb.count, Math.min(d.count, deb.cap));
        gl.disable(gl.DEPTH_TEST);
      }
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.out;
  }
}

FL.FX_FLAME_NIT = FLAME_NIT;
FL.FxRenderer = FxRenderer;
