// 差异定位：按「横向条带」和「纵向区域」拆解项目海报与参考稿的像素差异来源
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_verify');
const THEME = process.argv[2] || 'course';
const ROWS = 386 * 2;

const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); } };
const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const t = await send('Target.createTarget', { url: 'about:blank' });
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const s = a.result.sessionId;
await send('Runtime.enable', {}, s);

const payload = {
    p: fs.readFileSync(path.join(DIR, `project-${THEME}.png`)).toString('base64'),
    r: fs.readFileSync(path.join(DIR, `reference-${THEME}.png`)).toString('base64')
};

const expr = `(async () => {
  const data = ${JSON.stringify(payload)};
  const ROWS = ${ROWS};
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + src; });
  const [pi, ri] = await Promise.all([load(data.p), load(data.r)]);
  const c = document.createElement('canvas');
  c.width = 1500; c.height = ROWS;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const grab = img => { ctx.clearRect(0,0,1500,ROWS); ctx.drawImage(img, 0,0,1500,img.height, 0,0,1500,ROWS); return ctx.getImageData(0,0,1500,ROWS).data; };
  const A = grab(pi), B = grab(ri);
  const at = (D,x,y) => { const i=(y*1500+x)*4; return [D[i],D[i+1],D[i+2]]; };
  const diffAt = (x,y) => { const i=(y*1500+x)*4; return Math.max(Math.abs(A[i]-B[i]),Math.abs(A[i+1]-B[i+1]),Math.abs(A[i+2]-B[i+2])); };

  // 1) 横向条带差异（每 40 行 = 20 CSS px）
  const bands = [];
  for (let y0 = 0; y0 < ROWS; y0 += 40) {
    let n = 0, bad = 0;
    for (let y = y0; y < Math.min(y0+40, ROWS); y++) for (let x = 0; x < 1500; x++) { n++; if (diffAt(x,y) > 12) bad++; }
    bands.push({ y0, y1: Math.min(y0+40, ROWS), cssY: y0/2, ratio: +(bad/n*100).toFixed(1) });
  }

  // 2) 采样点对比（避开文字）
  const probes = [
    ['顶栏左',        40, 40],
    ['顶栏中',       750, 40],
    ['顶栏右',      1400, 40],
    ['hero 右上角',  1400, 250],
    ['hero 左中',      20, 400],
    ['hero 中下',     750, 700],
    ['hero 左下',      20, 740],
    ['hero 右侧中',  1200, 500]
  ].map(([name,x,y]) => ({ name, x, y, project: at(A,x,y), reference: at(B,x,y), diff: diffAt(x,y) }));

  return { bands, probes };
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
ws.close();
const out = res.result.result.value;

console.log(`主题：${THEME}   横向条带差异 >12 的像素占比`);
for (const b of out.bands) {
    const bar = '#'.repeat(Math.round(b.ratio / 2));
    console.log(`  y=${String(b.cssY).padStart(4)}px  ${String(b.ratio).padStart(5)}%  ${bar}`);
}
console.log('\n采样点色值（项目 vs 参考稿）');
for (const p of out.probes) {
    console.log(`  ${p.name.padEnd(12)} project rgb(${p.project.join(',')})   reference rgb(${p.reference.join(',')})   diff=${p.diff}`);
}
