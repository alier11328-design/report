// 逐像素比对：项目海报 vs 参考稿（只比两者版式相同的上部区域）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_verify');
const THEMES = ['course', 'paper', 'custom', 'thesis', 'cram', 'hours', 'papercard', 'preview', 'homework', 'polish', 'papercustom'];

const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); }
};
const send = (method, params = {}, sessionId) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const t = await send('Target.createTarget', { url: 'about:blank' });
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const s = a.result.sessionId;
await send('Runtime.enable', {}, s);

// 两者版式完全相同的区域：顶栏 86 + hero 300 = 386 CSS px（截图是 2x）
const ROWS = 386 * 2;

const payload = THEMES.map(theme => ({
    theme,
    p: fs.readFileSync(path.join(DIR, `project-${theme}.png`)).toString('base64'),
    r: fs.readFileSync(path.join(DIR, `reference-${theme}.png`)).toString('base64')
}));

const expr = `(async () => {
  const data = ${JSON.stringify(payload)};
  const ROWS = ${ROWS};
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + src; });
  const out = [];
  for (const item of data) {
    const [pi, ri] = await Promise.all([load(item.p), load(item.r)]);
    if (!pi || !ri) { out.push({ theme: item.theme, error: 'load-failed' }); continue; }
    const c = document.createElement('canvas');
    c.width = 1500; c.height = ROWS;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(pi, 0, 0, 1500, pi.height, 0, 0, 1500, ROWS);
    const A = ctx.getImageData(0, 0, 1500, ROWS).data;
    ctx.clearRect(0, 0, 1500, ROWS);
    ctx.drawImage(ri, 0, 0, 1500, ri.height, 0, 0, 1500, ROWS);
    const B = ctx.getImageData(0, 0, 1500, ROWS).data;

    let diffPx = 0, sum = 0, max = 0;
    const N = A.length;
    for (let i = 0; i < N; i += 4) {
      const d = Math.max(
        Math.abs(A[i] - B[i]),
        Math.abs(A[i+1] - B[i+1]),
        Math.abs(A[i+2] - B[i+2])
      );
      if (d > 12) diffPx++;
      sum += d;
      if (d > max) max = d;
    }
    out.push({
      theme: item.theme,
      diffRatio: +(diffPx / (N / 4) * 100).toFixed(2),
      meanDiff: +(sum / (N / 4)).toFixed(2),
      maxDiff: max
    });
  }
  return out;
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
ws.close();

if (res.result.exceptionDetails) {
    console.error(res.result.exceptionDetails);
    process.exit(1);
}
const rows = res.result.result.value;
console.log('上部共同区域像素比对（阈值 >12 / 255 记为一个差异像素）');
console.log('theme         差异像素占比   平均色差   最大色差');
for (const r of rows) {
    if (r.error) { console.log(`${r.theme.padEnd(13)} ${r.error}`); continue; }
    console.log(`${r.theme.padEnd(13)} ${String(r.diffRatio + '%').padEnd(14)} ${String(r.meanDiff).padEnd(10)} ${r.maxDiff}`);
}
