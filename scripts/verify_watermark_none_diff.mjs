// 「水印选无 + 已上传图片」状态下，逐像素比对预览截图与导出 PNG 是否一致
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '_verify');
fs.mkdirSync(OUT, { recursive: true });

const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); } };
const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const t = await send('Target.createTarget', { url: 'about:blank' });
const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const s = a.result.sessionId;
await send('Page.enable', {}, s);
await send('Runtime.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2400, deviceScaleFactor: 2, mobile: false }, s);
await send('Page.navigate', { url: 'http://127.0.0.1:3000/social-poster.html' }, s);
await new Promise(r => setTimeout(r, 2500));

const ev = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result.result.value;
};

await ev(`(() => { localStorage.removeItem('clasbro-social-poster-v1'); return 1; })()`);
await send('Page.reload', {}, s);
await new Promise(r => setTimeout(r, 2500));
await ev(`document.getElementById('poster').style.transform = 'none'; 1`);

// 填入样例内容
await ev(`(() => {
  const sample = { region: '澳洲', school: '昆士兰大学', major: '食品科学', courseCode: 'BIOL1020', teacher: 'Michelle.许', courseName: 'Genes, Cells & Evolution' };
  Object.entries(sample).forEach(([key, value]) => {
    const el = document.getElementById(key); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.getElementById('teacher').dispatchEvent(new Event('blur'));
  return 1;
})()`);
// 上传一张图 + 切到「无」
const doc = await send('DOM.getDocument', {}, s);
const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#posterImages' }, s);
await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [path.join(__dirname, '..', 'examples', '163f0615ffd14bd1aa913ae6886d7b42.png')] }, s);
const WM = process.env.WM || 'none';
await ev(`document.querySelector('[data-watermark="${WM}"]').click(); 1`);
await new Promise(r => setTimeout(r, 1800));
await ev(`document.getElementById('poster').style.transform = 'none'; 1`);
await new Promise(r => setTimeout(r, 400));

const state = await ev(`(() => { const p = document.getElementById('poster'); return { h: p.offsetHeight, brand: p.dataset.brand, media: document.querySelectorAll('.poster-media').length, wm: !!document.querySelector('.poster-watermark') }; })()`);
console.log('当前状态：', JSON.stringify(state));

await ev(`(() => {
  window.__exportDataUrl = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    if (blob && blob.type === 'image/png') { const rd = new FileReader(); rd.onload = () => { window.__exportDataUrl = String(rd.result); }; rd.readAsDataURL(blob); }
    return orig(blob);
  };
  return 'hooked';
})()`);
await ev(`document.getElementById('exportButton').click(); 'clicked'`);
let dataUrl = null;
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    dataUrl = await ev(`window.__exportDataUrl`);
    if (dataUrl) break;
}
if (!dataUrl) { console.log('导出未产生 PNG：', await ev(`document.getElementById('exportStatus').textContent`)); ws.close(); process.exit(1); }
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');

const box = await ev(`(() => { const r = document.getElementById('poster').getBoundingClientRect(); return { x:r.x+window.scrollX, y:r.y+window.scrollY, w:r.width, h:r.height }; })()`);
const shotRes = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } }, s);
const previewBuf = Buffer.from(shotRes.result.data, 'base64');
fs.writeFileSync(path.join(OUT, 'preview-none-watermark.png'), previewBuf);
fs.writeFileSync(path.join(OUT, 'export-none-watermark-diff.png'), buf);

const expr = `(async () => {
  const load = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + src; });
  const [a, b] = await Promise.all([load(${JSON.stringify(previewBuf.toString('base64'))}), load(${JSON.stringify(buf.toString('base64'))})]);
  if (!a || !b) return { error: 'load-failed' };
  const H = Math.min(a.height, b.height);
  const c = document.createElement('canvas'); c.width = 1500; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(a, 0, 0, 1500, a.height, 0, 0, 1500, H);
  const A = ctx.getImageData(0, 0, 1500, H).data;
  ctx.clearRect(0,0,1500,H);
  ctx.drawImage(b, 0, 0, 1500, b.height, 0, 0, 1500, H);
  const B = ctx.getImageData(0, 0, 1500, H).data;
  let bad = 0, sum = 0; const rows = [];
  for (let y = 0; y < H; y++) {
    let rowBad = 0;
    for (let x = 0; x < 1500; x++) {
      const i = (y*1500+x)*4;
      const d = Math.max(Math.abs(A[i]-B[i]), Math.abs(A[i+1]-B[i+1]), Math.abs(A[i+2]-B[i+2]));
      if (d > 12) { bad++; rowBad++; }
      sum += d;
    }
    if (rowBad > 45) rows.push({ cssY: y/2, ratio: +(rowBad/1500*100).toFixed(1) });
  }
  return { total: H*1500, previewH: a.height, exportH: b.height, diffRatio: +(bad/(H*1500)*100).toFixed(2), meanDiff: +(sum/(H*1500)).toFixed(2), rows };
})()`;
const cmp = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
ws.close();
const r = cmp.result.result.value;
console.log('预览图高 / 导出图高：', r.previewH, '/', r.exportH, '（导出应为预览的 2 倍）');
console.log('预览 vs 导出：差异像素占比', r.diffRatio + '%', '平均色差', r.meanDiff);
if (r.rows && r.rows.length) console.log('差异集中的行（css y）：', r.rows.map(x => `${x.cssY}(${x.ratio}%)`).join(' '));
else console.log('没有明显差异行 —— 预览与导出完全一致。');
