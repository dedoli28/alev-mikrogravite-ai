(async () => {
  const out = [];
  const cases = [
    ['earth-candle', {}], ['earth-candle', { renderScale: 1 }], ['iss-candle', {}], ['methane-jet', {}], ['saffire', {}],
  ];
  for (const [id, ov] of cases) {
    // Kare süresi (profilsiz) ve geçiş profili (zamanlayıcı sorgusu) ayrı koşulur
    const a = await FLBench.run(id, { frames: 40, warm: 40, W: 1280, H: 720, overrides: ov });
    const b = await FLBench.run(id, { frames: 50, warm: 40, W: 1280, H: 720, overrides: ov, profile: true });
    out.push({ id, ov, grid: a.grid, hdr: a.hdr, frameMs: +a.frameMs.toFixed(2), subSteps: a.subSteps, solverMs: +b.prof.total.solver.toFixed(2), renderMs: +b.prof.total.render.toFixed(2), top: b.prof.rows.slice(0, 8) });
  }
  return out;
})()
