// 量 PNG 指定区域内「文字墨迹」的上下留白，用于比对导出图与预览图里同一块文字的位置
// 用法：node scripts/measure_region_ink.mjs <png> <x> <y> <w> <h> <label>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [file, x, y, w, h, label] = process.argv.slice(2);
const filePath = path.isAbsolute(file) ? file : path.join(__dirname, '_verify', file);
const b64 = fs.readFileSync(filePath).toString('base64');
const PNG_W = fs.readFileSync(filePath).readUInt32BE(16);
const PNG_H = fs.readFileSync(filePath).readUInt32BE(20);

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

const out = await send('Runtime.evaluate', {
    expression: `(async () => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + ${JSON.stringify(b64)}; });
      const rx = ${+x}, ry = ${+y}, rw = ${+w}, rh = ${+h};
      const c = document.createElement('canvas'); c.width = rw; c.height = rh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
      const D = ctx.getImageData(0, 0, rw, rh).data;
      const px = (px_, py) => { const i = (py * rw + px_) * 4; return [D[i], D[i+1], D[i+2]]; };
      const dev = (p, q) => Math.max(Math.abs(p[0]-q[0]), Math.abs(p[1]-q[1]), Math.abs(p[2]-q[2]));
      // 边距按区域尺寸自适应，小区域也能量
      const margin = Math.max(2, Math.min(20, Math.floor(Math.min(rw, rh) / 5)));
      let top = 1e9, bottom = -1;
      for (let py = margin; py < rh - margin; py++) {
        const hist = new Map();
        for (let p = 2; p < rw - 2; p++) { const [r,g,b] = px(p, py); const k = (r<<16)|(g<<8)|b; hist.set(k, (hist.get(k)||0)+1); }
        let bk = 0, bc = -1;
        for (const [k, cnt] of hist) if (cnt > bc) { bc = cnt; bk = k; }
        const bg = [(bk>>16)&255, (bk>>8)&255, bk&255];
        for (let p = margin; p < rw - margin; p++) {
          if (dev(px(p, py), bg) > 60) { if (py < top) top = py; if (py > bottom) bottom = py; break; }
        }
      }
      return { top, bottom, rh };
    })()`, awaitPromise: true, returnByValue: true
}, s);
ws.close();
const o = out.result.result.value;
console.log(`${label}  (图 ${PNG_W}x${PNG_H}，区域 ${x},${y} ${w}x${h})`);
console.log(`  墨迹 上留白 ${o.top}  下留白 ${o.rh - 1 - o.bottom}  → 垂直偏移 ${((o.top - (o.rh - 1 - o.bottom)) / 2).toFixed(1)}px（图内像素，÷2 = CSS px）`);
