// 定位截图对齐：找出两张图里顶栏/hero 的实际边界行，判断截图是否存在整体偏移
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '_verify');

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
    p: fs.readFileSync(path.join(DIR, 'project-thesis.png')).toString('base64'),
    r: fs.readFileSync(path.join(DIR, 'reference-thesis.png')).toString('base64')
};

const expr = `(async () => {
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + src; });
  const [pi, ri] = await Promise.all([load(${JSON.stringify(payload.p)}), load(${JSON.stringify(payload.r)})]);
  const rows = img => {
    const c = document.createElement('canvas');
    c.width = 1500; c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, 1500, img.height).data;
  };
  const A = rows(pi), B = rows(ri);
  const px = (D, x, y) => { const i = (y*1500+x)*4; return [D[i],D[i+1],D[i+2]]; };
  // 用最右侧（无文字、无卡片的纯背景）判断分界线
  const scanX = 1490;
  const isInk = (D, y) => { const [r,g,b] = px(D,scanX,y); return r+g+b < 400; };
  let topbarEndP = -1, topbarEndR = -1;
  for (let y = 0; y < 400; y++) { if (topbarEndP < 0 && !isInk(A,y)) topbarEndP = y; if (topbarEndR < 0 && !isInk(B,y)) topbarEndR = y; }
  // 沿最右侧往下找 hero 下边界（分隔线 E8EAED，比白色略深）
  const findBorder = (D, H) => {
    for (let y = topbarEndP + 2; y < Math.min(1600, H); y++) {
      const [r,g,b] = px(D, scanX, y);
      if (r < 248 && Math.abs(r-g) < 10 && Math.abs(g-b) < 10) return y;
    }
    return -1;
  };
  const heroBorderP = findBorder(A, pi.height);
  const heroBorderR = findBorder(B, ri.height);
  // 逐 4px 打印 380~430 css 区间的右侧像素，直观看分界
  const profile = [];
  for (let cssY = 380; cssY <= 430; cssY += 2) {
    const y = cssY * 2;
    profile.push({ cssY, project: px(A, scanX, y), reference: px(B, scanX, y) });
  }
  // css y=360（差异条带所在行）横向扫描
  const row360 = [];
  for (let cssX = 10; cssX <= 740; cssX += 30) {
    const x = cssX * 2, y = 720;
    const p = px(A, x, y), r = px(B, x, y);
    const d = Math.max(Math.abs(p[0]-r[0]), Math.abs(p[1]-r[1]), Math.abs(p[2]-r[2]));
    row360.push({ cssX, project: p, reference: r, diff: d });
  }
  return {
    project: { h: pi.height, topbarEnd: topbarEndP, heroBorder: heroBorderP, cssHeroBorder: heroBorderP / 2 },
    reference: { h: ri.height, topbarEnd: topbarEndR, heroBorder: heroBorderR, cssHeroBorder: heroBorderR / 2 },
    profile, row360
  };
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
ws.close();
const o = res.result.result.value;
console.log('项目  图高', o.project.h, '顶栏结束行', o.project.topbarEnd, '(期望 172)', 'hero 下边界 css y =', o.project.cssHeroBorder, '(期望 398)');
console.log('参考  图高', o.reference.h, '顶栏结束行', o.reference.topbarEnd, '(期望 172)', 'hero 下边界 css y =', o.reference.cssHeroBorder, '(期望 398)');
console.log('\n最右侧纵向色带（css y 380~430）');
for (const row of o.profile) {
    const f = c => `${String(c[0]).padStart(3)},${String(c[1]).padStart(3)},${String(c[2]).padStart(3)}`;
    console.log(`  y=${String(row.cssY).padStart(3)}  项目 ${f(row.project)}   参考 ${f(row.reference)}`);
}
console.log('\ncss y=360 横向扫描');
for (const row of o.row360) {
    const f = c => `${String(c[0]).padStart(3)},${String(c[1]).padStart(3)},${String(c[2]).padStart(3)}`;
    console.log(`  x=${String(row.cssX).padStart(3)}  项目 ${f(row.project)}   参考 ${f(row.reference)}   色差 ${row.diff}`);
}
