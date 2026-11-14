/* =====================================================================
 * Alev Laboratuvarı — Yapay zekâ veri kümesi
 *
 * Fiziksel kameranın (Blender kamerası gibi) gördüğü kareleri ve her kare için
 * benzetimden gelen yer gerçeğini tek bir .zip dosyasında dışa aktarır.
 * Görüntüler yalnız gerçek bir kameranın göreceği bilgiyi taşır (görünür ışık,
 * doyma, gürültü, alan derinliği, obtüratör bulanıklığı); ölçüm yardımcıları
 * yazılmaz. Etiketler (ısı salınımı, sıcaklık, alev boyu, ışık şiddeti...)
 * modelin tahmin etmesi gereken büyüklüklerdir.
 *
 *   images/000001.png   kamera görüntüsü (sRGB, 8 bit)
 *   masks/000001.png    tepkime bölgesi (HRR) ikili maskesi, aynı kameradan
 *   labels.jsonl        kare başına bir JSON satırı
 *   meta.json           alanların açıklaması, birimler, kamera modeli
 * ===================================================================== */
import { FL } from '../core/fl.js';

/* ------------------------------------------------------------------ */
/* Sıkıştırmasız ZIP yazıcı (STORE)                                     */
/* ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
  }

  add(name, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const nameB = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          // UTF-8 dosya adı
    lh.setUint16(8, 0, true);               // STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, bytes.length, true);
    lh.setUint32(22, bytes.length, true);
    lh.setUint16(26, nameB.length, true);
    lh.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(lh.buffer), nameB, bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, bytes.length, true);
    ch.setUint32(24, bytes.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, this.offset, true);
    this.central.push(new Uint8Array(ch.buffer), nameB);
    this.offset += 30 + nameB.length + bytes.length;
  }

  blob() {
    let cdSize = 0;
    for (const p of this.central) cdSize += p.length;
    const count = this.central.length / 2;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, count, true);
    end.setUint16(10, count, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}
FL.ZipWriter = ZipWriter;

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                          */
/* ------------------------------------------------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (x) => (typeof x === 'number' && isFinite(x) ? +x.toPrecision(5) : null);
const pad6 = (i) => String(i).padStart(6, '0');
const nextFrame = () => new Promise((res) => setTimeout(res, 0));

/** Varsayılan çerçeve arabelleğini (az önce çizilen kare) RGBA bayt olarak oku, dikey çevir */
function readFrame(gl, W, H) {
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8ClampedArray(W * H * 4);
  const row = W * 4;
  for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

function toPNG(rgba, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
  return new Promise((res) => c.toBlob((b) => b.arrayBuffer().then((ab) => res(new Uint8Array(ab))), 'image/png'));
}

/* ------------------------------------------------------------------ */
/* Yakalama                                                             */
/* ------------------------------------------------------------------ */
/**
 * @param app   uygulama nesnesi (sim, renderer, state, glc)
 * @param ui    { status(text), toast(text), canvas }
 */
FL.captureDataset = async function (app, ui) {
  if (app.capturing) return;
  const st = app.state, sim = app.sim, ren = app.renderer, gl = app.glc.gl;
  const canvas = ui.canvas;
  const sensor = FL.SENSORS[st.camSensor] || FL.SENSORS.ff;
  const W = Math.max(64, Math.round(st.dsWidth / 2) * 2);
  const H = Math.max(64, Math.round(((W * sensor.h) / sensor.w) / 2) * 2);
  const N = Math.max(1, st.dsFrames | 0);
  const saved = {
    paused: app.paused, camPhys: st.camPhys, camLook: st.camLook, asyncReads: sim.asyncReads,
    cw: canvas.width, ch: canvas.height, yaw: st.camYaw, pitch: st.camPitch, view: st.view,
  };
  app.capturing = true;
  app.paused = true;
  // Görüntüler her zaman sahne kamerasından (Blender: render kameradan alınır)
  if (!st.camSet && ui.alignCamera) ui.alignCamera();
  st.camPhys = true;
  st.camLook = true;
  sim.asyncReads = false;
  // Kare hızı yöneticisinin kare başına alt adım bütçesi burada geçerli değildir
  sim.subCap = 0;
  canvas.width = W; canvas.height = H;
  const zip = new ZipWriter();
  const labels = [];
  const rng = mulberry32((Date.now() & 0xffffff) ^ 0x5bd1e995);
  const t0 = performance.now();
  try {
    ren.invalidate();
    // Kamera ve TAA ısınması: birkaç kare
    for (let k = 0; k < 6; k++) ren.render(st, W, H, { paused: true });

    for (let i = 0; i < N; i++) {
      // Kamera yönü sapması (çeşitlilik)
      if (st.dsJitter > 0) {
        const j = st.dsJitter;
        st.camYaw = saved.yaw + (rng() * 2 - 1) * j;
        st.camPitch = FL.clamp(saved.pitch + (rng() * 2 - 1) * j * 0.6, -89, 89);
        ren.invalidate();
      }
      // Benzetimi kare aralığı kadar ilerlet; son obtüratör penceresinde her alt adımda
      // çiz (pozlama süresi boyunca birikim = gerçek hareket bulanıklığı)
      const tShut = ren.shutterTime(st);
      let remain = i === 0 ? Math.min(tShut, st.dsInterval) : st.dsInterval;
      ren._shutValid = false;
      let tail = false;
      while (remain > 1e-9) {
        const inTail = remain <= tShut + 1e-9;
        const h = inTail ? Math.min(remain, Math.max(tShut / 6, 1 / 960)) : Math.min(remain - tShut, 1 / 60) || Math.min(remain, 1 / 60);
        if (app.autoIgnPending && sim.simTime >= app.autoIgnAt) { app.autoIgnPending = false; sim.ignite(ui.ignDuration()); }
        sim.step(h);
        // Nesne yangını ve patlama efektleri aynı süre kadar ilerler (iki çözücü bağlıdır)
        if (FL.fxAdvance) FL.fxAdvance(h);
        remain -= h;
        if (sim.frame % 3 === 0) sim.computeStats({ sync: true });
        if (sim.frame % 10 === 0 && sim.measureSheetFront) sim.measureSheetFront({ sync: true });
        if (inTail) {
          if (!tail) { ren._shutValid = false; tail = true; }
          ren.render(st, W, H, { paused: false });
        }
      }
      sim.computeStats({ sync: true });
      // Son kare: kamera görüntüsü
      ren.render(st, W, H, { paused: true, keepShutter: true });
      const img = readFrame(gl, W, H);
      const cam = ren.lastCam;
      const info = Object.assign({}, ren.camInfo || {});
      const proj = (p) => {
        const q = ren.project(p, W, H);
        return q ? [r4(q[0]), r4(q[1])] : null;
      };
      // Tepkime bölgesi maskesi: aynı kamera, ısı salınımı alanı
      let maskBytes = null;
      if (st.dsMask) {
        ren.render(st, W, H, { paused: true, mask: true });
        const m = readFrame(gl, W, H);
        for (let p = 0; p < m.length; p += 4) {
          const v = Math.max(m[p], m[p + 1], m[p + 2]) > 40 ? 255 : 0;
          m[p] = m[p + 1] = m[p + 2] = v; m[p + 3] = 255;
        }
        maskBytes = await toPNG(m, W, H);
        ren.render(st, W, H, { paused: true, keepShutter: true });   // kamera durumunu geri getir
      }
      const png = await toPNG(img, W, H);
      const name = pad6(i + 1);
      zip.add('images/' + name + '.png', png);
      if (maskBytes) zip.add('masks/' + name + '.png', maskBytes);

      const s = sim.stats, gr = sim.grid, d = sim.droplet;
      // Nesne yangını (yüzey hücreleri) ve patlama: nerede, ne kadar, ne renk
      const fxSys = app.fx;
      const fxs = fxSys ? fxSys.stats : null;
      const bbox2 = (lo, hi) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
        for (let k = 0; k < 8; k++) {
          const q = ren.project([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]], W, H);
          if (!q) continue;
          n++;
          x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
        }
        if (!n) return null;
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
        return x1 > x0 && y1 > y0 ? [r4(x0), r4(y0), r4(x1), r4(y1)] : null;
      };
      const regions = fxSys ? fxSys.regions(12).map((g) => ({
        part: g.part, object: g.object, material: g.material, cells: g.cells,
        area_cm2: r4(g.area_m2 * 1e4), intensity: r4(g.intensity), Tmax_K: r4(g.Tmax_K), flame_color: g.color,
        centroid_m: g.centroid_m.map(r4), centroid_px: proj(g.centroid_m), bbox_px: bbox2(g.bbox_lo_m, g.bbox_hi_m),
      })) : [];
      const ex = fxSys && fxSys.lastExplosion && fxSys.time - fxSys.lastExplosion.t < Math.max(st.dsInterval, 0.5) ? fxSys.lastExplosion : null;
      const cfdOn = !!sim.flameOn;
      const fireOn = !!(fxs && fxs.burningCells > 0);
      const kinds = [];
      if (cfdOn) kinds.push(st.source === 'sheet' ? 'solid_sheet_spread' : st.source === 'droplet' ? 'droplet_diffusion' : st.source === 'jet' ? 'gas_jet_diffusion' : 'candle_diffusion');
      if (fireOn) kinds.push('surface_fire');
      if (ex) kinds.push('explosion');
      // Akış çözücüsündeki alevin görüntüdeki sınır kutusu (kaynak, alev ucu ve yarıçapından)
      const fr = Math.max(s.rMax || 0, 0.5 * (s.flameH || 0), 0.004);
      const cfdBox = cfdOn ? bbox2([s.cx - fr, Math.min(s.cy - fr, anchorY(sim)), s.cz - fr], [s.cx + fr, Math.max(s.cy + fr, s.yTip || 0), s.cz + fr]) : null;
      const fx = W / 2 / Math.tan(((info.fov_h_deg || 40) * Math.PI) / 360);
      const fy = H / 2 / Math.tan(((info.fov_v_deg || 27) * Math.PI) / 360);
      const anchor = sim.geo.anchor;
      labels.push({
        frame: i + 1,
        image: 'images/' + name + '.png',
        mask: maskBytes ? 'masks/' + name + '.png' : null,
        t_s: r4(sim.simTime),
        scenario: {
          preset: app.preset.id, source: st.source, fuel: st.fuel,
          gravity_g0: r4(st.gravity), o2_pct: r4(st.o2), pressure_kPa: r4(st.pressure), diluent: st.diluent,
          Tamb_K: r4(st.Tamb), flow_cm_s: r4(st.flow), wind_cm_s: r4(st.wind), wind_dir_deg: r4(st.windDir), ozone_pct: r4(st.ozone),
          domain_cm: [r4(gr.Lx * 100), r4(gr.Ly * 100), r4(gr.Lz * 100)], resolution: [gr.NX, gr.NY, gr.NZ],
        },
        truth: {
          // Görüntüde alev var mı (akış çözücüsündeki alev, nesne yangını ya da patlama)
          flame_present: cfdOn || fireOn || !!ex,
          flame_kinds: kinds,
          fire: fxSys ? {
            burning: fireOn,
            hrr_kW: r4(fxs.heatKW), burning_area_cm2: r4(fxs.burningArea * 1e4), burning_cells: fxs.burningCells,
            smoldering_cells: fxs.hotCells, debris: fxs.debris, particles: fxs.particles,
            cabin_o2_pct: fxSys.cabin ? r4(fxSys.cabin.o2Fraction * 100) : null, cabin_pressure_kPa: fxSys.cabin ? r4(fxSys.cabin.pressure) : null,
            cabin_gas_T_K: fxSys.cabin ? r4(fxSys.cabin.temperature) : null,
            hull_breached: !!(fxSys.cabin && fxSys.cabin.breached),
            explosions_total: fxSys.explosionCount,
            explosion: ex ? { age_s: r4(fxSys.time - ex.t), yield_MJ: r4(ex.yield), fireball: r4(ex.fireball), shock: ex.shock, radius_m: r4(ex.radius), center_m: ex.pos.map(r4), center_px: proj(ex.pos) } : null,
            regions,
          } : null,
          flame_on: !!sim.flameOn,
          hrr_W: r4(s.hrr), Tmax_K: r4(s.Tmax),
          flame_height_mm: r4(s.flameH * 1000), flame_radius_mm: r4(s.rMax * 1000),
          luminous_intensity_cd: r4(s.lumY), soot_ug: r4(s.soot), chi_rad: r4(s.chiRad),
          rad_loss_W: r4(s.qrad), rad_wall_max_kW_m2: r4(s.qWallMax / 1000), rad_to_walls_W: r4(s.radOut),
          cool_flame_W: r4(s.cool), umax_m_s: r4(s.umax),
          droplet_d_mm: d ? r4(d.d * 1000) : null, burning_rate_K_mm2_s: d ? r4(d.K * 1e6) : null,
          spread_mm_s: isFinite(sim.spread) ? r4(sim.spread) : null,
          hrr_centroid_m: [r4(s.cx), r4(s.cy), r4(s.cz)],
          quenching: sim.quenching ? sim.quenching() : false, smothering: sim.smothering ? sim.smothering() : false,
        },
        camera: Object.assign(info, {
          width: W, height: H,
          intrinsics: { fx: r4(fx), fy: r4(fy), cx: W / 2, cy: H / 2 },
          eye_m: cam ? cam.eye.map(r4) : null,
          world_to_camera: cam ? Array.from(cam.view).map(r4) : null,
          projection: cam ? Array.from(cam.proj).map(r4) : null,
        }),
        projected_px: {
          source_anchor: proj(anchor),
          flame_tip: s.flameH > 0 ? proj([anchor[0], s.yTip, anchor[2]]) : null,
          hrr_centroid: s.hrr > 0.01 ? proj([s.cx, s.cy, s.cz]) : null,
          flame_bbox: cfdBox,
        },
      });
      ui.status('Kare ' + (i + 1) + ' / ' + N + ' · t = ' + FL.fmt(sim.simTime, 4) + ' s');
      await nextFrame();
    }

    zip.add('labels.jsonl', labels.map((l) => JSON.stringify(l)).join('\n') + '\n');
    zip.add('meta.json', JSON.stringify(datasetMeta(st, W, H, N), null, 2));
    const blob = zip.blob();
    const fname = 'alev-veri-' + app.preset.id + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.zip';
    ui.download(blob, fname);
    const dt = (performance.now() - t0) / 1000;
    ui.status(N + ' kare · ' + (blob.size / 1e6).toFixed(1) + ' MB · ' + dt.toFixed(0) + ' s');
    ui.toast('Veri kümesi kaydedildi (' + N + ' kare)');
  } catch (e) {
    console.error(e);
    ui.status('Hata: ' + (e.message || e));
    ui.toast('Veri kümesi kaydedilemedi');
  } finally {
    canvas.width = saved.cw; canvas.height = saved.ch;
    st.camYaw = saved.yaw; st.camPitch = saved.pitch;
    st.camPhys = saved.camPhys;
    st.camLook = saved.camLook;
    sim.asyncReads = saved.asyncReads;
    app.paused = saved.paused;
    ren.invalidate();
    ren.warming = Math.max(ren.warming, 12);
    app.capturing = false;
  }
};

function anchorY(sim) {
  return sim.geo && sim.geo.anchor ? sim.geo.anchor[1] : 0;
}

function datasetMeta(st, W, H, N) {
  return {
    generator: 'Mikrogravite Alev Laboratuvarı',
    created: new Date().toISOString(),
    frames: N,
    image_size: [W, H],
    coordinate_system: 'Dünya koordinatları metre; y yukarı (yerçekimi −y); başlangıç hesaplama alanının köşesi. Görüntü pikselleri sol üstten.',
    camera_model: {
      projection: 'İğne deliği + ince mercek. fov = 2·atan(sensör / (2·odak uzaklığı)). intrinsics fx, fy, cx, cy piksel.',
      exposure: 'Piksel (doyma = 1) = L / L_sat, L_sat = 78·N² / (0,65·ISO·t) [cd/m²] (ISO 12232 doyma tabanlı hız). L: sahnenin görünür ışıklılığı.',
      depth_of_field: 'Karışıklık çemberi c = (f/N)·f·|d − d_f| / (d·(d_f − f)).',
      motion_blur: 'Obtüratör süresi boyunca benzetim alt adımlarında görüntü birikimi.',
      noise: 'Foton (Poisson ≈ Gauss) + okuma gürültüsü (3 e⁻); doyma elektronu = sensör kapasitesi × 100/ISO.',
      white_balance: 'von Kries, kara cisim beyazı (K).',
      view_transform: st.camView === 'agx' ? 'AgX' : 'Standart sRGB, doyan kanal kırpılır',
    },
    labels: {
      'truth.hrr_W': 'Toplam ısı salınım hızı [W]',
      'truth.Tmax_K': 'En yüksek gaz sıcaklığı [K]',
      'truth.flame_height_mm': 'Kaynaktan alev ucuna yükseklik (HRR eşiği) [mm]',
      'truth.flame_radius_mm': 'Kaynaktan en uzak tepkime noktası [mm]',
      'truth.luminous_intensity_cd': 'Alevin görünür ışık şiddeti [cd]',
      'truth.soot_ug': 'Alandaki kurum kütlesi [µg]',
      'truth.chi_rad': 'Işınım kesri q_rad / HRR',
      'truth.rad_wall_max_kW_m2': 'Alan sınırlarına gelen en büyük ışınım ısı akısı [kW/m²]',
      'truth.burning_rate_K_mm2_s': 'Damla d²-yasası yanma hız sabiti [mm²/s]',
      'truth.spread_mm_s': 'Levhada alev yayılma hızı [mm/s]',
      'mask': 'Alevin aynı kameradan ikili maskesi; 255 = alev. Akış çözücüsündeki tepkime bölgesi (HRR) ile nesne yangını ve patlamanın alev gövdesi birlikte; duman, kıvılcım ve enkaz dahil değildir.',
      'truth.flame_present': 'Karede alev var mı: akış çözücüsündeki alev, nesne (yüzey) yangını ya da patlama',
      'truth.flame_kinds': 'Alev türleri: candle_diffusion | gas_jet_diffusion | droplet_diffusion | solid_sheet_spread | surface_fire | explosion',
      'truth.fire.hrr_kW': 'Nesne yangınının ısı salınım hızı [kW] (yüzey hücresi modeli)',
      'truth.fire.burning_area_cm2': 'Alev alan yüzey alanı [cm²]',
      'truth.fire.smoldering_cells': 'Tutuşma sıcaklığına yaklaşmış, piroliz dumanı veren hücre sayısı (alev öncesi erken uyarı)',
      'truth.fire.cabin_o2_pct': 'Kabin (ya da laboratuvar) havasının O₂ hacim yüzdesi; yangın tüketir, O₂ kaynağı yarılırsa yükselir',
      'truth.fire.explosion': 'Son patlama (kare aralığı içinde): yaş [s], enerji [MJ], ateş topu oranı 0..1, şok dalgası (gaz varsa), merkez',
      'truth.fire.regions[]': 'Yanan parça başına bölge: parça, nesne, malzeme, alan [cm²], şiddet, en yüksek yüzey sıcaklığı [K], alev rengi (blue: yüzdürmesiz/kurumsuz, yellow: kurumlu), merkez [m ve px], sınır kutusu [x0, y0, x1, y1] px',
      'projected_px.flame_bbox': 'Akış çözücüsündeki alevin görüntüdeki sınır kutusu [x0, y0, x1, y1] px',
    },
    note: 'Görüntüler yalnız görünür ışık kamerasının göreceği bilgiyi içerir; etiketler benzetimin yer gerçeğidir. Model doğruluğu benzetim modeline bağlıdır (Analiz › Model ve varsayımlar).',
  };
}
