/* =====================================================================
 * Kıyas ve doğrulama aracı — tarayıcı konsoluna (ya da javascript_tool'a)
 * yapıştırılır; uygulamanın rAF döngüsünden bağımsızdır.
 *
 *   const out = await FLBench.run('earth-candle', { frames: 90, overrides: {} });
 *
 * Kareleri kendisi sürer (sabit Δt = 1/60 s), böylece fizik sonucu GPU
 * hızından bağımsız ve tekrarlanabilirdir. Döndürdüğü nesne:
 *   frameMs      kare başına toplam süre (gl.finish ile), ortalama
 *   prof         geçiş başına ms (glc.prof); zamanlayıcı yoksa yedek yöntem
 *   stats        son istatistikler (HRR, Tmax, alev boyu, yayılma hızı ...)
 *   shot         isteğe bağlı PNG data URL (opts.shot = true)
 * ===================================================================== */
window.FLBench = {
  async run(id, opts = {}) {
    const app = FL.app, glc = app.glc, sim = app.sim, ren = app.renderer;
    const frames = opts.frames || 90;
    const warm = opts.warm === undefined ? 30 : opts.warm;
    const dt = 1 / 60;
    const r = FL.stateForPreset(id);
    Object.assign(r.state, { adaptive: false }, opts.overrides || {});
    app.paused = true;
    app.lost = true; // uygulamanın rAF döngüsü durur; kareleri yalnız bu araç sürer
    ren.adaptiveScale = 1;
    ren.stepBoost = 1;
    app.state = r.state;
    app.preset = r.preset;
    sim.configure(app.state);
    ren.invalidate();
    const gr = sim.grid;
    ren.camera.fit([gr.Lx, gr.Ly, gr.Lz], gr.Ly * (r.preset.focus !== undefined ? r.preset.focus : 0.5), false, 1.5);
    const canvas = document.getElementById('gl');
    const W = opts.W || canvas.width || 960, H = opts.H || canvas.height || 600;
    canvas.width = W; canvas.height = H;
    sim.ignite(r.state.source === 'sheet' ? 5 : r.state.source === 'candle' ? 2 : 0.9);
    const st = app.state;
    const frame = (measure) => {
      glc.prof.group = 'solver';
      sim.step(dt);
      if (sim.frame % 3 === 0) sim.computeStats({ sync: true });
      if (sim.frame % 10 === 0) sim.measureSheetFront({ sync: true });
      ren.camera.update(dt);
      glc.prof.group = 'render';
      ren.render(st, W, H, { paused: false });
      glc.profEndFrame();
    };
    for (let i = 0; i < warm; i++) frame(false);
    glc.gl.finish();
    glc.profEnable(!!opts.profile);
    if (opts.profile) glc.prof.mode = opts.mode || glc.prof.mode;
    const times = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      frame(true);
      if (!opts.profile) glc.gl.finish();
      times.push(performance.now() - t0);
      if (i % 5 === 4) await new Promise((res) => setTimeout(res, 0));
    }
    if (opts.profile) {
      glc.profPublish(); // kalan pencereyi gerçek kare sayısıyla yayımla
    }
    const rep = glc.prof.report;
    const s = sim.stats;
    const out = {
      id, grid: gr.NX + 'x' + gr.NY + 'x' + gr.NZ, view: W + 'x' + H, hdr: ren.hdr.w + 'x' + ren.hdr.h,
      frameMs: times.reduce((a, b) => a + b, 0) / times.length,
      subSteps: sim.lastPlan && sim.lastPlan.n,
      simTime: sim.simTime,
      stats: { hrr: s.hrr, Tmax: s.Tmax, flameH_mm: s.flameH * 1000, soot: s.soot, lumY: s.lumY, spread_mm_s: sim.spread, qrad: s.qrad },
      prof: rep && { mode: rep.mode, total: rep.total, rows: rep.rows.slice(0, 16).map((x) => x.group + ':' + x.name + ' ' + x.ms.toFixed(2)) },
    };
    if (opts.shot) out.shot = canvas.toDataURL('image/png');
    return out;
  },
};
