/* =====================================================================
 * Alev Laboratuvarı — WebGL2 yardımcı katmanı
 * ---------------------------------------------------------------------
 * - Program derleme ve uniform tip içgözlemi (otomatik setter)
 * - Kayan noktalı doku ve çoklu hedefli (MRT) framebuffer yönetimi
 * - Ping-pong çiftleri
 * - Tam ekran üçgen ile "pass" çalıştırma
 * ===================================================================== */
import { FL } from '../core/fl.js';

class GLContext {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Bu tarayıcı WebGL2 desteklemiyor.');
    this.gl = gl;
    this.canvas = canvas;
    this.extCBF = gl.getExtension('EXT_color_buffer_float');
    this.extFL = gl.getExtension('OES_texture_float_linear');
    this.extTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!this.extCBF) {
      throw new Error('EXT_color_buffer_float yok: kayan noktalı hedeflere yazılamıyor.');
    }
    // Doğrusal süzme fizik için gerekmez (örnekleme texelFetch). 32 bit
    // hedef yazılabiliyorsa onu kullan: Windows'ta Edge/Opera çoğu zaman
    // OES_texture_float_linear vermez, yarım duyarlık ise alevi söndürür.
    this.floatLinear = !!this.extFL;
    this.float32RT = this._probeMRT(gl.RGBA32F, gl.RGBA, gl.FLOAT, 2);
    this.float32R = this._probeMRT(gl.R32F, gl.RED, gl.FLOAT, 1);
    this.fmtField = this.float32RT ? gl.RGBA32F : gl.RGBA16F;
    this.typeField = this.float32RT ? gl.FLOAT : gl.HALF_FLOAT;
    this.fmtR = this.float32R ? gl.R32F : gl.R16F;
    this.typeR = this.float32R ? gl.FLOAT : gl.HALF_FLOAT;
    // Alan dokusu hiçbir tarayıcıda doğrusal süzülmez. Eklenti bildirilmiş
    // olsa bile ANGLE örnekleri siyaha çevirebiliyor; okuma texelFetch'tir.
    this.fieldFilter = gl.NEAREST;
    this.prof = { on: false, mode: 'timer', group: 'solver', frame: 0, lastFrame: -1, count: 0, window: new Map(), pending: [], pool: [], report: null };
    this.programs = [];
    this.textures = new Set();
    this.fbos = new Set();
    this._cacheState();
    this._buildQuad();
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  /**
   * Durum önbelleği. Çözücü kare başına yüzlerce tam ekran geçişi çalıştırır; her
   * geçişte aynı programı, dokuyu ve hedefi yeniden bağlamak GPU'yu değil, tarayıcının
   * komut kuyruğunu doldurur (ölçüm: karenin ~19 ms'si). Zaten geçerli olan durum için
   * WebGL çağrısı yapılmaz. Önbellek bağlamın kendi işlevlerini sarar; doğrudan
   * gl.bindTexture kullanan kod da (model sahnesi, efektler) tutarlı kalır.
   */
  _cacheState() {
    const gl = this.gl;
    const raw = {
      activeTexture: gl.activeTexture.bind(gl), bindTexture: gl.bindTexture.bind(gl), useProgram: gl.useProgram.bind(gl),
      bindFramebuffer: gl.bindFramebuffer.bind(gl), viewport: gl.viewport.bind(gl), bindVertexArray: gl.bindVertexArray.bind(gl),
      deleteTexture: gl.deleteTexture.bind(gl), deleteFramebuffer: gl.deleteFramebuffer.bind(gl),
      deleteProgram: gl.deleteProgram.bind(gl), deleteVertexArray: gl.deleteVertexArray.bind(gl),
    };
    const s = { unit: gl.TEXTURE0, t2: [], t3: [], prog: undefined, fb: undefined, vao: undefined, vp: [NaN, NaN, NaN, NaN] };
    this.glState = s;
    this.glCalls = 0;
    gl.activeTexture = (u) => { if (u !== s.unit) { s.unit = u; raw.activeTexture(u); } };
    gl.bindTexture = (target, tex) => {
      const arr = target === gl.TEXTURE_2D ? s.t2 : target === gl.TEXTURE_3D ? s.t3 : null;
      if (arr) {
        const i = s.unit - gl.TEXTURE0;
        if (arr[i] === tex) return;
        arr[i] = tex;
      }
      raw.bindTexture(target, tex);
    };
    gl.useProgram = (p) => { if (p !== s.prog) { s.prog = p; raw.useProgram(p); } };
    gl.bindFramebuffer = (target, fb) => {
      if (target !== gl.FRAMEBUFFER) { s.fb = undefined; raw.bindFramebuffer(target, fb); return; }
      if (fb !== s.fb) { s.fb = fb; raw.bindFramebuffer(target, fb); }
    };
    gl.viewport = (x, y, w, h) => {
      const v = s.vp;
      if (v[0] === x && v[1] === y && v[2] === w && v[3] === h) return;
      v[0] = x; v[1] = y; v[2] = w; v[3] = h;
      raw.viewport(x, y, w, h);
    };
    gl.bindVertexArray = (v) => { if (v !== s.vao) { s.vao = v; raw.bindVertexArray(v); } };
    // Silinen nesne bağlamdan da düşer: önbellekte kalmasın
    gl.deleteTexture = (t) => {
      for (let i = 0; i < s.t2.length; i++) if (s.t2[i] === t) s.t2[i] = undefined;
      for (let i = 0; i < s.t3.length; i++) if (s.t3[i] === t) s.t3[i] = undefined;
      raw.deleteTexture(t);
    };
    gl.deleteFramebuffer = (f) => { if (s.fb === f) s.fb = undefined; raw.deleteFramebuffer(f); };
    gl.deleteProgram = (p) => { if (s.prog === p) s.prog = undefined; raw.deleteProgram(p); };
    gl.deleteVertexArray = (v) => { if (s.vao === v) s.vao = undefined; raw.deleteVertexArray(v); };
  }

  _buildQuad() {
    const gl = this.gl;
    // Tek bir büyük üçgen ekranı kaplar (köşegen dikişi olmaz)
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /* -------------------------------------------------------------- */
  /* Programlar                                                     */
  /* -------------------------------------------------------------- */
  compile(type, src, name) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n');
      // Hatalı satırı bağlamıyla göster
      const m = /ERROR:\s*\d+:(\d+)/.exec(log);
      let ctx = '';
      if (m) {
        const ln = parseInt(m[1], 10);
        for (let i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 2); i++) {
          ctx += (i === ln ? '>> ' : '   ') + i + ': ' + lines[i - 1] + '\n';
        }
      }
      gl.deleteShader(sh);
      throw new Error('Shader derleme hatası [' + name + ']\n' + log + '\n' + ctx);
    }
    return sh;
  }

  program(name, fsSource, vsSource) {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vsSource || FL.SHADERS.vsQuad, name + ':vs');
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSource, name + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program bağlama hatası [' + name + ']: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const prog = { name, handle: p, uniforms: {}, samplers: [] };
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const uname = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      prog.uniforms[uname] = { loc, type: info.type, size: info.size };
      if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_3D) prog.samplers.push(uname);
    }
    this.programs.push(prog);
    return prog;
  }

  /**
   * Uniform değeri programın kendi durumudur ve bağlama göre kalıcıdır: değer son
   * yazılanla aynıysa yeniden gönderilmez (çözücü geçişlerinin uniform'larının çoğu
   * kare boyunca sabittir).
   */
  setUniform(prog, name, value) {
    const u = prog.uniforms[name];
    if (!u || value === undefined) return;
    const gl = this.gl;
    const l = u.loc;
    if (typeof value === 'number' || typeof value === 'boolean') {
      const v = +value;
      if (u.cs === v) return;
      u.cs = v;
      u.ca = null;
    } else if (value && value.length !== undefined) {
      const n = value.length;
      let c = u.ca;
      if (c && c.length === n) {
        let i = 0;
        for (; i < n; i++) if (c[i] !== value[i]) break;
        if (i === n) return;
        for (; i < n; i++) c[i] = value[i];
      } else {
        c = u.ca = new Float64Array(n);
        for (let i = 0; i < n; i++) c[i] = value[i];
      }
      u.cs = undefined;
    }
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1) gl.uniform1fv(l, value);
        else gl.uniform1f(l, value);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(l, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(l, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(l, value); break;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(l, value | 0); break;
      case gl.INT_VEC2: gl.uniform2iv(l, value); break;
      case gl.INT_VEC3: gl.uniform3iv(l, value); break;
      case gl.INT_VEC4: gl.uniform4iv(l, value); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(l, false, value); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(l, false, value); break;
      default:
        break;
    }
  }

  /** Örnekleyiciyi doku birimine bağlar (birim numarası da önbelleklenir) */
  bindSampler(prog, name, tex, unit) {
    const u = prog.uniforms[name];
    if (!u || !tex) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(tex.is3D ? gl.TEXTURE_3D : gl.TEXTURE_2D, tex.handle);
    if (u.cs !== unit) { u.cs = unit; gl.uniform1i(u.loc, unit); }
    return true;
  }

  /* -------------------------------------------------------------- */
  /* Dokular ve framebuffer'lar                                     */
  /* -------------------------------------------------------------- */
  /** internal/format/type ile n renk hedefi tamamlanıyor mu */
  _probeMRT(internal, format, type, n) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    const texs = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const bufs = [];
    for (let i = 0; i < n; i++) {
      const t = gl.createTexture();
      texs.push(t);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    texs.forEach((t) => gl.deleteTexture(t));
    while (gl.getError() !== gl.NO_ERROR) { /* deneme hatalarını boşalt */ }
    return ok;
  }

  texture(w, h, opts) {
    const gl = this.gl;
    // Alan dokuları texelFetch ile okunur; doğrusal süzme varsayılan olursa
    // süzülmeyen kayan nokta dokusu eksik kalır ve örnekler siyaha döner.
    const o = Object.assign({ internal: this.fmtField, format: gl.RGBA, type: this.typeField, filter: this.fieldFilter, data: null, wrap: gl.CLAMP_TO_EDGE }, opts || {});
    let filter = o.filter;
    const float32 = o.internal === gl.RGBA32F || o.internal === gl.R32F || o.internal === gl.RG32F;
    if (filter === gl.LINEAR && float32 && !this.floatLinear) filter = gl.NEAREST;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap);
    // Mipmap istenmediği halde bazı ANGLE sürücüleri seviyeyi 1000 sanıp dokuyu eksik sayar.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, o.internal, w, h, 0, o.format, o.type, o.data);
    this._texId = (this._texId || 0) + 1;
    const tex = { id: this._texId, handle: t, w, h, internal: o.internal, format: o.format, type: o.type };
    this.textures.add(tex);
    return tex;
  }

  /** Doku listesi için önbellekli MRT framebuffer (ping-pong takası sonrası yeniden kullanılır) */
  mrt(texList) {
    this._mrtCache = this._mrtCache || new Map();
    const key = texList.map((t) => t.id).join(':');
    let f = this._mrtCache.get(key);
    if (!f) {
      f = this.framebuffer(texList);
      this._mrtCache.set(key, f);
    }
    return f;
  }

  clearMRTCache() {
    if (!this._mrtCache) return;
    this._mrtCache.forEach((f) => this.destroyFBO(f));
    this._mrtCache.clear();
  }

  framebuffer(texList) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const bufs = [];
    texList.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.handle, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    gl.drawBuffers(bufs);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer tamamlanmadı (durum 0x' + st.toString(16) + ')');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const f = { handle: fb, w: texList[0].w, h: texList[0].h, textures: texList };
    this.fbos.add(f);
    return f;
  }

  /** Tek doku + framebuffer */
  target(w, h, opts) {
    const tex = this.texture(w, h, opts);
    const fbo = this.framebuffer([tex]);
    return { tex, fbo, w, h };
  }

  /** Ping-pong çifti; opts.mrt = ek eşlik eden doku sayısı */
  pingPong(w, h, opts) {
    const a = this.target(w, h, opts);
    const b = this.target(w, h, opts);
    return {
      read: a, write: b,
      swap() { const t = this.read; this.read = this.write; this.write = t; },
    };
  }

  destroyTexture(tex) {
    if (!tex) return;
    this.gl.deleteTexture(tex.handle);
    this.textures.delete(tex);
  }

  destroyFBO(f) {
    if (!f) return;
    this.gl.deleteFramebuffer(f.handle);
    this.fbos.delete(f);
  }

  destroyTarget(t) {
    if (!t) return;
    this.destroyFBO(t.fbo);
    this.destroyTexture(t.tex);
  }

  destroyPingPong(pp) {
    if (!pp) return;
    this.destroyTarget(pp.read);
    this.destroyTarget(pp.write);
  }

  clearTarget(t, value) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo ? t.fbo.handle : t.handle);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearBufferfv(gl.COLOR, 0, value || [0, 0, 0, 0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* -------------------------------------------------------------- */
  /* Pass çalıştırma                                                */
  /* -------------------------------------------------------------- */
  /**
   * prog     : program nesnesi
   * target   : {fbo} | fbo | null (ekran)
   * uniforms : { ad: değer | doku }  — dokular {handle} ile tanınır
   */
  pass(prog, target, uniforms, viewport) {
    const gl = this.gl;
    gl.useProgram(prog.handle);
    let unit = 0;
    for (const name in uniforms) {
      const v = uniforms[name];
      if (v && v.handle) {
        if (this.bindSampler(prog, name, v, unit)) unit++;
      } else if (v && v.tex && v.tex.handle) {
        if (this.bindSampler(prog, name, v.tex, unit)) unit++;
      } else {
        this.setUniform(prog, name, v);
      }
    }
    let fb = null, w, h;
    if (target) {
      const f = target.fbo || target;
      fb = f.handle;
      w = f.w; h = f.h;
    } else {
      w = gl.drawingBufferWidth; h = gl.drawingBufferHeight;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (viewport) gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    else gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    if (this.prof.on) {
      const tok = this._profBegin(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._profEnd(tok);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* -------------------------------------------------------------- */
  /* GPU geçiş profilleyicisi (geliştirici paneli, D tuşu)          */
  /* -------------------------------------------------------------- */
  /**
   * EXT_disjoint_timer_query_webgl2 varsa her pass'in GPU süresi sorgu ile
   * ölçülür. Yoksa performance.now + gl.finish yedeği kullanılır; bu yedek
   * GPU hattını her geçişte boşalttığı için toplamı şişirir, yalnız göreli
   * sıralama için güvenilirdir.
   * Etiket: grup (çözücü | görüntü) + program adı. Grubu çağıran belirler (prof.group).
   */
  profEnable(on) {
    const p = this.prof;
    if (p.on === !!on) return;
    p.on = !!on;
    p.mode = this.extTimer ? 'timer' : 'finish';
    p.window = new Map();
    p.count = 0;
    p.report = null;
    p.pending.forEach((e) => this.gl.deleteQuery(e.q));
    p.pending = [];
    p.pool.forEach((q) => this.gl.deleteQuery(q));
    p.pool = [];
  }

  _profBegin(prog) {
    const p = this.prof;
    const gl = this.gl;
    const label = p.group + ':' + prog.name;
    if (p.mode === 'timer') {
      const q = p.pool.pop() || gl.createQuery();
      gl.beginQuery(this.extTimer.TIME_ELAPSED_EXT, q);
      return { q, label, frame: p.frame };
    }
    gl.finish();
    return { t0: performance.now(), label, frame: p.frame };
  }

  _profEnd(tok) {
    const p = this.prof;
    if (p.mode === 'timer') {
      this.gl.endQuery(this.extTimer.TIME_ELAPSED_EXT);
      p.pending.push(tok);
    } else {
      this.gl.finish();
      this._profAdd(tok.label, performance.now() - tok.t0, tok.frame);
    }
  }

  _profAdd(label, ms, frame) {
    const p = this.prof;
    p.window.set(label, (p.window.get(label) || 0) + ms);
    if (frame > p.lastFrame) { p.lastFrame = frame; p.count++; }
  }

  /** Karenin sonunda çağrılır: biten sorguları toplar, 60 karelik pencereyi yayımlar */
  profEndFrame() {
    const p = this.prof;
    if (!p.on) return;
    const gl = this.gl;
    p.frame++;
    if (p.mode === 'timer') {
      const disjoint = gl.getParameter(this.extTimer.GPU_DISJOINT_EXT);
      while (p.pending.length) {
        const e = p.pending[0];
        if (!disjoint && !gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
        p.pending.shift();
        if (!disjoint) this._profAdd(e.label, gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6, e.frame);
        p.pool.push(e.q);
      }
    }
    const now = performance.now();
    if (!p.t0) p.t0 = now;
    if (p.count >= 60 || (p.count >= 3 && now - p.t0 > 4000)) this.profPublish();
  }

  /** Penceredeki gerçek kare sayısına bölerek raporu yayımlar */
  profPublish() {
    const p = this.prof;
    if (p.count > 0) {
      p.t0 = performance.now();
      const n = p.count;
      const rep = { frames: n, mode: p.mode, total: { solver: 0, render: 0 }, rows: [] };
      p.window.forEach((ms, label) => {
        const [grp, name] = label.split(':');
        rep.rows.push({ group: grp, name, ms: ms / n });
        rep.total[grp] = (rep.total[grp] || 0) + ms / n;
      });
      rep.rows.sort((a, b) => b.ms - a.ms);
      p.report = rep;
      p.window = new Map();
      p.count = 0;
    }
  }

  /** RGBA32F hedefinden piksel okuma (eşzamanlı: GPU kuyruğunu boşaltır) */
  readPixels(target, x, y, w, h, out) {
    const gl = this.gl;
    const f = target.fbo || target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.handle);
    const buf = out || new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }

  /**
   * Engellemeyen okuma: piksel paketleme tamponuna (PBO) kopyalar, bir çit
   * (fence) koyar ve sonuç hazır olduğunda geri çağırır. Ana iş parçacığı
   * GPU'yu beklemediği için kare süresinde takılma oluşmaz.
   *   reads: [{ target, x, y, w, h }]
   *   cb   : (Float32Array[]) => void
   */
  readAsync(reads, cb) {
    const gl = this.gl;
    this._pboPool = this._pboPool || [];
    this._pending = this._pending || [];
    const items = reads.map((r) => {
      const bytes = r.w * r.h * 16;
      let i = this._pboPool.findIndex((p) => p.bytes === bytes);
      let pbo;
      if (i >= 0) pbo = this._pboPool.splice(i, 1)[0];
      else {
        pbo = { handle: gl.createBuffer(), bytes };
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.handle);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      }
      const f = r.target.fbo || r.target;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.handle);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.handle);
      gl.readPixels(r.x || 0, r.y || 0, r.w, r.h, gl.RGBA, gl.FLOAT, 0);
      return { pbo, n: r.w * r.h * 4 };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this._pending.push({ fence, items, cb, age: 0 });
  }

  /** Hazır olan engellemeyen okumaları teslim eder; her karede çağrılır. */
  pollReads() {
    if (!this._pending || !this._pending.length) return;
    const gl = this.gl;
    const still = [];
    for (const p of this._pending) {
      p.age++;
      const s = gl.clientWaitSync(p.fence, 0, 0);
      if (s === gl.TIMEOUT_EXPIRED && p.age < 30) { still.push(p); continue; }
      gl.deleteSync(p.fence);
      const out = p.items.map((it) => {
        const a = new Float32Array(it.n);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, it.pbo.handle);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, a);
        this._pboPool.push(it.pbo);
        return a;
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      try { p.cb(out); } catch (e) { console.error(e); }
    }
    this._pending = still;
  }

  /** Bekleyen okumaları iptal eder (ızgara yeniden kurulurken) */
  cancelReads() {
    if (!this._pending) return;
    const gl = this.gl;
    for (const p of this._pending) {
      gl.deleteSync(p.fence);
      p.items.forEach((it) => this._pboPool.push(it.pbo));
    }
    this._pending = [];
  }

  unbindAll() {
    const gl = this.gl;
    for (let i = 0; i < 8; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }
}

FL.GLContext = GLContext;

/* ------------------------------------------------------------------ */
/* Küçük matris kütüphanesi (sütun-öncelikli, WebGL düzeni)             */
/* ------------------------------------------------------------------ */
const M4 = {
  identity() {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) * nf; m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  },
  lookAt(eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ]);
  },
  multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  },
  invert(m) {
    const inv = new Float32Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (det === 0) return M4.identity();
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
  transformPoint(m, p) {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
};
FL.M4 = M4;
