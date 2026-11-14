/* Başsız Edge/Chrome ile sayfa içinde betik çalıştırır (yeni bağımlılık yok: Node ≥ 22 WebSocket).
 *
 *   node tools/cdp.mjs --gpu=low|high|soft --url=http://127.0.0.1:47321/#p=earth-candle --expr="..." [--timeout=240]
 *   node tools/cdp.mjs --gpu=low --expr-file=tools/job.js
 *
 * --gpu=low   düşük güç (tümleşik) GPU, --gpu=high yüksek başarım GPU, soft = SwiftShader
 * İfade, FLBench.run(...) gibi bir Promise döndürebilir; sonuç JSON olarak yazdırılır.
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?([\s\S]*)$/.exec(a); return [m[1], m[2] === '' ? true : m[2]]; }));
const url = args.url || 'http://127.0.0.1:47321/#p=earth-candle';
const gpu = args.gpu || 'low';
const timeout = (Number(args.timeout) || 240) * 1000;
const expr = args['expr-file'] ? readFileSync(args['expr-file'], 'utf8') : args.expr;
if (!expr) { console.error('--expr veya --expr-file gerekli'); process.exit(2); }

const edge = process.env.BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9333 + Math.floor(Math.random() * 500);
const flags = [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'alev-edge-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];
if (gpu === 'soft') flags.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
else flags.push('--use-angle=d3d11', gpu === 'low' ? '--force-low-power-gpu' : '--force_high_performance_gpu');
// --luid=<düşük 32 bit, onaltılık>: belirli bir DXGI bağdaştırıcısı (ör. tümleşik GPU) için
if (args.luid) flags.push(`--use-adapter-luid=0,${parseInt(args.luid, 16)}`);
flags.push('about:blank');
const proc = spawn(edge, flags, { stdio: 'ignore' });
const done = (code) => { try { proc.kill(); } catch { /* yok say */ } process.exit(code); };
setTimeout(() => { console.error('zaman aşımı'); done(3); }, timeout + 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(500);
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch { /* henüz hazır değil */ }
}
if (!wsUrl) { console.error('tarayıcıya bağlanılamadı'); done(4); }
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Page.navigate', { url });
// Uygulama açılana kadar bekle
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: '!!(window.FL && FL.app && FL.app.renderer && FL.app.started)', returnByValue: true });
  if (r.result && r.result.result && r.result.result.value) break;
  if (i === 239) { console.error('uygulama açılmadı'); done(5); }
}
const bench = readFileSync(new URL('./bench.js', import.meta.url), 'utf8');
await send('Runtime.evaluate', { expression: bench });
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout });
if (r.result && r.result.exceptionDetails) { console.error(JSON.stringify(r.result.exceptionDetails, null, 1)); done(6); }
// --out=<klasör>: sonuçtaki PNG veri adresleri (data:image/png;base64,…) dosyaya yazılır
if (!r.result || !r.result.result) { console.error('değerlendirme yanıtı yok: ' + JSON.stringify(r).slice(0, 800)); done(7); }
let value = r.result.result.value;
if (args.out && value && typeof value === 'object') {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(args.out, { recursive: true });
  const walk = (o, prefix) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string' && v.startsWith('data:image/png;base64,')) {
        const f = join(args.out, (prefix + k).replace(/[^\w.-]+/g, '_') + '.png');
        writeFileSync(f, Buffer.from(v.slice(22), 'base64'));
        o[k] = f;
      } else if (v && typeof v === 'object') walk(v, prefix + k + '_');
    }
  };
  walk(value, '');
}
// --page-shot=<dosya.png>: arayüzle birlikte sayfanın ekran görüntüsü (ifade bittikten sonra)
if (args['page-shot']) {
  const { writeFileSync } = await import('node:fs');
  await sleep(Number(args['shot-wait']) || 600);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result && s.result.data) writeFileSync(args['page-shot'], Buffer.from(s.result.data, 'base64'));
}
console.log(JSON.stringify(value, null, 1));
done(0);
