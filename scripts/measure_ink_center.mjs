// 量出海报里各文本块「文字墨迹」相对色块的真实偏移（上下左右），用于判断是否真正居中。
// 做法：截取元素本身（scale=2），逐行取该行最左侧像素当作底色，超过阈值即算墨迹。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.PROFILE || 'project';
const fileUrl = winPath => 'file:///' + String(winPath).split('/').map(s => encodeURIComponent(s)).join('/');

const PROFILES = {
    project: {
        url: 'http://127.0.0.1:3000/social-poster.html',
        targets: [
            { name: '产品类型色块', sel: '.poster-title span:nth-child(1)' },
            { name: '素材类型色块', sel: '.poster-title span:nth-child(2)' },
            { name: '信息标签-学校', sel: '.poster-chips .poster-chip:nth-child(1)' },
            { name: '信息标签-课程', sel: '.poster-chips .poster-chip:nth-child(2)' },
            { name: '课程名称', sel: '.poster-course' },
            { name: '页脚品牌字', sel: '.poster-footer-left' },
            { name: '页脚网址', sel: '.poster-footer-right' }
        ]
    },
    reference: {
        url: fileUrl('D:/桌面/朋友圈海报.html'),
        targets: [
            { name: '产品类型色块', sel: '#title1' },
            { name: '素材类型色块', sel: '#title2' },
            { name: '信息标签-学校', sel: '#chip1' },
            { name: '信息标签-课程', sel: '#chip2' },
            { name: '课程名称', sel: '#courseName' },
            { name: '页脚品牌字', sel: '.footer-left' },
            { name: '页脚网址', sel: '.footer-right' }
        ]
    }
};
const CUR = PROFILES[PROFILE];
const PAGE_URL = process.env.PAGE_URL || CUR.url;
const TARGETS = CUR.targets;

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
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2000, deviceScaleFactor: 2, mobile: false }, s);
await send('Page.navigate', { url: PAGE_URL }, s);
await new Promise(r => setTimeout(r, 3500));

const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, s);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
};

const fontState = await ev(`(async () => {
  await document.fonts.ready;
  const probe = (f, t) => document.fonts.check(f, t);
  const probeEl = document.querySelector('.poster-title') || document.querySelector('.hero-title') || document.body;
  return {
    display: getComputedStyle(probeEl).fontFamily,
    notoSC: probe('800 22px "Noto Sans SC"', '包课辅导'),
    loaded: document.fonts.size
  };
})()`, true);
console.log('字体：', JSON.stringify(fontState));

const rects = await ev(`(() => {
  const map = {};
  ${JSON.stringify(TARGETS)}.forEach(t => {
    const el = document.querySelector(t.sel);
    if (!el) { map[t.name] = null; return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    map[t.name] = {
      x: r.x, y: r.y, w: r.width, h: r.height,
      text: el.textContent,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight, padding: cs.padding, border: cs.borderTopWidth,
      letterSpacing: cs.letterSpacing, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight
    };
  });
  return map;
})()`);

const shots = [];
for (const t of TARGETS) {
    const r = rects[t.name];
    if (!r) continue;
    const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 2 }
    }, s);
    if (!shot.result || !shot.result.data) {
        console.log('截图失败：', t.name, JSON.stringify(shot.error || shot).slice(0, 200));
        continue;
    }
    if (process.env.DEBUG) {
        console.log('debug', t.name, 'dataLen', shot.result.data.length, 'head', shot.result.data.slice(0, 12));
    }
    if (process.env.SAVE_SHOTS) {
        fs.writeFileSync(path.join(__dirname, '_verify', `ink-${PROFILE}-${t.name}.png`), Buffer.from(shot.result.data, 'base64'));
    }
    shots.push({ name: t.name, data: shot.result.data, rect: r });
}

for (const sh of shots) {
    const out = await ev(`(async () => {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + ${JSON.stringify(sh.data)}; });
      const W = img.width, H = img.height;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const D = ctx.getImageData(0, 0, W, H).data;
      const px = (x, y) => { const i = (y * W + x) * 4; return [D[i], D[i+1], D[i+2]]; };
      const dev = (a, b) => Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2]));
      const HUGE = 1e9;
      let top = HUGE, bottom = -1, left = HUGE, right = -1;
      // 每行取「众数颜色」当底色（避免采样点落到圆角外的页面底色上）
      for (let y = 20; y < H - 20; y++) {
        const hist = new Map();
        for (let x = 2; x < W - 2; x++) {
          const [r, g, b] = px(x, y);
          const k = (r << 16) | (g << 8) | b;
          hist.set(k, (hist.get(k) || 0) + 1);
        }
        let bestKey = 0, bestCount = -1;
        for (const [k, c] of hist) if (c > bestCount) { bestCount = c; bestKey = k; }
        const bg = [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
        // 文字与底色接近的（如深色底上的深色）时用页面白底兜底判断
        for (let x = 24; x < W - 24; x++) {
          if (dev(px(x, y), bg) > 60) {
            if (y < top) top = y; if (y > bottom) bottom = y;
            if (x < left) left = x; if (x > right) right = x;
          }
        }
      }
      return { W, H, top, bottom, left, right };
    })()`, true);
    const { W, H } = out;
    const gapTop = out.top / 2, gapBottom = (H - 1 - out.bottom) / 2;
    const gapLeft = out.left / 2, gapRight = (W - 1 - out.right) / 2;
    const vOff = (gapTop - gapBottom) / 2;      // >0 表示文字偏低
    const hOff = (gapLeft - gapRight) / 2;     // >0 表示文字偏右
    const f = n => n.toFixed(1).padStart(5);
    console.log(`\n【${sh.name}】「${sh.rect.text}」  盒 ${(W/2).toFixed(0)}×${(H/2).toFixed(0)}`);
    console.log(`  上下留白  上 ${f(gapTop)}  下 ${f(gapBottom)}   → 垂直偏移 ${vOff > 0 ? '+' : ''}${vOff.toFixed(1)}px ${Math.abs(vOff) < 1 ? '(居中)' : vOff > 0 ? '(偏低)' : '(偏高)'}`);
    console.log(`  左右留白  左 ${f(gapLeft)}  右 ${f(gapRight)}   → 水平偏移 ${hOff > 0 ? '+' : ''}${hOff.toFixed(1)}px ${Math.abs(hOff) < 1 ? '(居中)' : hOff > 0 ? '(偏右)' : '(偏左)'}`);
    console.log(`  墨迹高 ${((out.bottom - out.top + 1) / 2).toFixed(1)}px   行高 ${sh.rect.lineHeight}   字号 ${sh.rect.fontSize}`);
}

// 附：把「画布中间基线」与「DOM 行盒」的字体度量打印出来，用于对齐导出画布
const metrics = await ev(`(() => {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  return ${JSON.stringify(TARGETS.map(t => t.sel))}.map(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const text = el.textContent.trim();
    const m = ctx.measureText(text);
    const A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
    const aA = m.actualBoundingBoxAscent, aD = m.actualBoundingBoxDescent;
    const LH = parseFloat(cs.lineHeight);
    const border = parseFloat(cs.borderTopWidth);
    const padTop = parseFloat(cs.paddingTop);
    return {
      text, font: cs.fontSize + ' w' + cs.fontWeight, LH, A: +A.toFixed(2), D: +D.toFixed(2),
      aA: +aA.toFixed(2), aD: +aD.toFixed(2), border, padTop,
      domBaselineFromBoxTop: +(border + padTop + (LH - (A + D)) / 2 + A).toFixed(2),
      canvasMiddleTop: +(border + padTop + LH / 2).toFixed(2),
      inkTopByDomModel: +(border + padTop + (LH - (A + D)) / 2 + A - aA).toFixed(2),
      inkTopByMiddleModel: +(border + padTop + LH / 2 + (A - D) / 2 - aA).toFixed(2)
    };
  }).filter(Boolean);
})()`);
console.log('\n字体度量（相对元素盒顶部，CSS px）：');
for (const m of metrics) {
    console.log(`  ${m.text.slice(0, 18)}  字号 ${m.font}  行高 ${m.LH}  字体 A=${m.A} D=${m.D}  字形 aA=${m.aA} aD=${m.aD}`);
    console.log(`      按 DOM 行盒推墨迹顶 = ${m.inkTopByDomModel}   按画布 middle 推 = ${m.inkTopByMiddleModel}   （可对比上文实测留白）`);
}
ws.close();
