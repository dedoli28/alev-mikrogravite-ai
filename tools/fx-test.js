/* =====================================================================
 * Yangın ve patlama efektleri — duman testi (başsız tarayıcıda)
 *
 *   node tools/cdp.mjs --gpu=high --expr-file=tools/fx-test.js --out=docs/fx --timeout=400
 *
 * Kareleri kendisi sürer (sabit Δt = 1/60 s); uygulamanın rAF döngüsü durur.
 * Döndürdüğü nesne: adım adım sayılar (yanan hücre, güç, kabin O₂, kare süresi)
 * ve --out verilirse ekran görüntüleri.
 * ===================================================================== */
(async () => {
  const app = FL.app, api = FL.api, glc = app.glc, gl = glc.gl, sim = app.sim, ren = app.renderer, fx = app.fx;
  const canvas = document.getElementById('gl');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const W = 1280, H = 800;
  const out = { gpu: glc.renderer, steps: [], shots: {} };
  const px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  app.paused = true;
  app.lost = true;            // rAF döngüsü durur
  app.state.adaptive = false;
  ren.adaptiveScale = 1; ren.stepBoost = 1;
  sim.subCap = 0;
  canvas.width = W; canvas.height = H;
  const frame = (dt = 1 / 60, opts) => {
    if (app.autoIgnPending && sim.simTime >= app.autoIgnAt) { app.autoIgnPending = false; sim.ignite(2); }
    const t0 = sim.simTime;
    sim.step(dt);
    if (sim.frame % 3 === 0) sim.computeStats({ sync: true });
    api.fxAdvance(sim.simTime - t0);
    ren.camera.update(dt);
    return ren.render(app.state, W, H, opts || { paused: false });
  };
  const run = async (n, dt) => { for (let i = 0; i < n; i++) { frame(dt); if (i % 10 === 9) await sleep(0); } };
  const shot = (name) => { ren.render(app.state, W, H, { paused: true }); out.shots[name] = canvas.toDataURL('image/png'); };
  const timeFrames = (n) => { sync(); const t0 = performance.now(); for (let i = 0; i < n; i++) frame(); sync(); return +((performance.now() - t0) / n).toFixed(2); };
  const snap = (label) => {
    const s = fx.stats, c = fx.cabin;
    const o = { label, t: +sim.simTime.toFixed(2), burning: s.burningCells, hot: s.hotCells, kW: +s.heatKW.toFixed(2), area_cm2: +(s.burningArea * 1e4).toFixed(1), particles: s.particles, debris: s.debris, o2: +(c.o2Fraction * 100).toFixed(2), p_kPa: +c.pressure.toFixed(1), stO2: app.state.o2, candleW: +(sim.stats.hrr || 0).toFixed(1), lightCd: +(fx.light.cd || 0).toFixed(1), glErr: gl.getError(), logs: api.logs().slice(-2) };
    out.steps.push(o);
    return o;
  };
  const waitModel = async (id) => {
    api.setModel(id);
    for (let i = 0; i < 400; i++) { await sleep(100); if (id === 'none' ? !ren.model.ready : ren.model.ready && ren.model.def && ren.model.def.id === FL.modelById(id).id && fx.scene === ren.model) break; }
    api.fitCamera(false);
  };

  // 1) Masa üstü: iki ayrı nesne + mum (1 g)
  await waitModel('co2+sfog');
  out.scene1 = { model: app.state.model, parts: ren.model.parts.length, cells: fx.stats.cells, bodies: fx.stats.bodies, spacing_mm: +(fx.spacing * 1000).toFixed(1), objects: [...new Set(ren.model.parts.map((p) => p.obj))], explosive: fx.bodies.filter((b) => b.explosive).map((b) => b.label + ':' + b.explosive.kind) };
  await run(90);
  out.frameMs_idle = timeFrames(20);
  snap('mum yanıyor, nesneler soğuk');
  shot('01_nesneler_mum');
  api.fxAction('act-short');
  await run(150);
  snap('kısa devre + 2,5 s');
  shot('02_kisa_devre');
  out.frameMs_fire = timeFrames(20);
  await run(240);
  snap('yangın + 6,5 s');
  shot('03_yangin');
  api.fxAction('act-cook');
  await run(420);
  snap('tüp yanında yangın + 7 s');
  shot('04_tup');
  api.setControl('fxYield', 0.03);
  api.fxAction('act-blast');
  await run(6);
  shot('05_patlama_0_1s');
  await run(14);
  snap('patlama + 0,33 s');
  shot('06_patlama_0_3s');
  out.frameMs_blast = timeFrames(10);
  await run(60);
  shot('07_patlama_sonrasi');
  snap('patlama + 1,5 s');
  // Yer gerçeği maskesi (aynı kamera)
  ren.render(app.state, W, H, { paused: true });
  ren.render(app.state, W, H, { paused: true, mask: true });
  out.shots['08_maske'] = canvas.toDataURL('image/png');
  out.regions = fx.regions(4).map((r) => ({ part: r.part, object: r.object, material: r.material, cells: r.cells, color: r.color }));
  // Termal görünüm
  api.setControl('view', 'ir');
  shot('09_termal');
  api.setControl('view', 'real');
  api.reset();
  snap('sıfırlandı');

  // 2) Mikrogravite + yörünge arka planı: mum, nesne yok
  await waitModel('none');
  api.loadPreset('iss-candle');
  await sleep(50);
  canvas.width = W; canvas.height = H;
  api.fitCamera(false);
  await run(120);
  out.backdrop = { orbit: ren.orbitBackdrop(app.state), preset: app.preset.id };
  shot('10_iss_mum_dunya');
  return out;
})()
