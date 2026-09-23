// 校验「水印选无」时：选项只剩 2 个、上下品牌区隐藏、导出 PNG 同步变化
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
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2400, deviceScaleFactor: 1, mobile: false }, s);
ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === s) {
        console.log('  [exception]', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description || '');
    }
});
await send('Page.navigate', { url: 'http://127.0.0.1:3000/social-poster.html' }, s);
await new Promise(r => setTimeout(r, 2500));

const ev = async expression => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result.result.value;
};

const ok = (label, pass, detail) => console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);

// 0) 清空存档，避免历史 watermark=w2 干扰
await ev(`(() => { localStorage.removeItem('clasbro-social-poster-v1'); return 1; })()`);
await send('Page.reload', {}, s);
await new Promise(r => setTimeout(r, 2500));
await ev(`document.getElementById('poster').style.transform = 'none'; 1`);

// 1) 水印选项
const options = await ev(`Array.from(document.querySelectorAll('[data-watermark]')).map(el => el.dataset.watermark + ':' + el.textContent.trim())`);
ok('水印选项只有 万能班长 / 无', options.length === 2 && options.join(',') === 'w1:万能班长,none:无', JSON.stringify(options));
ok('页面已无「留学云伴」文案', !(await ev(`document.body.innerText.includes('留学云伴')`)));

const measure = `(() => {
  const p = document.getElementById('poster');
  const top = document.querySelector('.poster-topbar');
  const foot = document.querySelector('.poster-footer');
  const dis = el => el ? getComputedStyle(el).display : 'missing';
  return {
    brand: p.dataset.brand,
    posterH: p.offsetHeight,
    topH: top.offsetHeight,
    topDisplay: getComputedStyle(top).display,
    footDisplay: getComputedStyle(foot).display,
    footH: foot.offsetHeight,
    brandDisplay: dis(document.querySelector('.poster-brand')),
    footLeftDisplay: dis(document.querySelector('.poster-footer-left')),
    footRightDisplay: dis(document.querySelector('.poster-footer-right')),
    hasWatermarkOverlay: !!document.querySelector('.poster-watermark'),
    active: Array.from(document.querySelectorAll('[data-watermark]')).filter(el => el.classList.contains('active')).map(el => el.dataset.watermark)
  };
})()`;

const before = await ev(measure);
console.log('默认（万能班长）：', JSON.stringify(before));
ok('默认上下色带满高、条内信息可见', before.topDisplay === 'flex' && before.topH === 86 && before.footH === 70 && before.brandDisplay === 'flex' && before.footLeftDisplay === 'flex' && before.footRightDisplay === 'block', `topH=${before.topH} footH=${before.footH} brand=${before.brandDisplay} footRight=${before.footRightDisplay}`);

// 2) 切到「无」
await ev(`(() => {
  document.querySelector('[data-watermark="none"]').click();
  return 1;
})()`);
await new Promise(r => setTimeout(r, 600));
const after = await ev(measure);
console.log('切到「无」：', JSON.stringify(after));
ok('data-brand=off', after.brand === 'off');
ok('顶栏色带保留但缩到 50%（86 → 43）', after.topDisplay === 'flex' && after.topH === 43, `display=${after.topDisplay} topH=${after.topH}`);
ok('页脚色带保留但缩到 50%（70 → 35）', after.footDisplay === 'flex' && after.footH === 35, `display=${after.footDisplay} footH=${after.footH}`);
ok('条内 logo 隐藏', after.brandDisplay === 'none', after.brandDisplay);
ok('条内奖章 + 文字隐藏', after.footLeftDisplay === 'none' && after.footRightDisplay === 'none', `${after.footLeftDisplay}/${after.footRightDisplay}`);
ok('无水印覆盖层', after.hasWatermarkOverlay === false);
ok('海报高度减少 78px（顶 43 + 底 35）', before.posterH - after.posterH === 43 + 35, `${before.posterH} → ${after.posterH}`);
ok('高亮切到「无」', after.active.join(',') === 'none', after.active.join(','));

// 3) 导出，检查 PNG 尺寸与顶部/底部颜色
await ev(`(() => {
  window.__exportDataUrl = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    if (blob && blob.type === 'image/png') {
      const rd = new FileReader();
      rd.onload = () => { window.__exportDataUrl = String(rd.result); };
      rd.readAsDataURL(blob);
    }
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
if (!dataUrl) { console.log('FAIL  导出未产生 PNG'); ws.close(); process.exit(1); }
const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
const pngW = buf.readUInt32BE(16), pngH = buf.readUInt32BE(20);
console.log(`导出 PNG：${pngW}x${pngH}，期望 1500x${after.posterH * 2}`);
ok('导出尺寸与「无」版式一致', pngW === 1500 && pngH === after.posterH * 2);
fs.writeFileSync(path.join(OUT, 'export-none-watermark.png'), buf);

// 读导出 PNG 的像素统计：上下色带内应保留品牌底色，但条内不应有白色文字/logo
const probePixels = async (pngBuf, topBandCss, footBandCss) => {
    const res = await send('Runtime.evaluate', {
        expression: `(async () => {
      const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = 'data:image/png;base64,' + ${JSON.stringify(pngBuf.toString('base64'))}; });
      if (!img) return { error: 'load-failed' };
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      // 数一块区域里「接近纯白」的像素数（= logo 图与白字留下的痕迹）
      const countWhite = (x, y, w, h) => {
        const d = ctx.getImageData(x, y, w, h).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) n++;
        return n;
      };
      const isBrandRed = p => p[0] > 150 && p[1] < 100 && p[2] < 100;
      const topPx = ${topBandCss} * 2, footPx = ${footBandCss} * 2;   // 导出是 2x
      const topBand = px(img.width / 2, Math.floor(topPx / 2));         // 顶栏色带中线
      const botBand = px(img.width / 2, img.height - Math.floor(footPx / 2));
      // 只在色带矩形范围内数白像素，避免把色带下方的白色 hero 算进来
      return {
        topPx, footPx, topBand, botBand, topRed: isBrandRed(topBand), botRed: isBrandRed(botBand),
        topWhite: countWhite(0, 0, img.width, topPx),
        footWhite: countWhite(0, img.height - footPx, img.width, footPx)
      };
    })()`, awaitPromise: true, returnByValue: true
    }, s);
    return res.result.result.value;
};

const pNone = await probePixels(buf, after.topH, after.footH);
console.log('「无」导出上下色带/白像素：', JSON.stringify(pNone));
ok('导出图顶部仍是品牌红色带', pNone.topRed === true, JSON.stringify(pNone.topBand));
ok('导出图底部仍是品牌红色带', pNone.botRed === true, JSON.stringify(pNone.botBand));
ok('导出图顶部色带高度 = 43px × 2', pNone.topPx === 86, `${pNone.topPx}px`);
ok('导出图底部色带高度 = 35px × 2', pNone.footPx === 70, `${pNone.footPx}px`);
ok('顶栏条内已无 logo/白字', pNone.topWhite === 0, `白像素 ${pNone.topWhite}`);
ok('页脚条内已无奖章/白字', pNone.footWhite === 0, `白像素 ${pNone.footWhite}`);

// 4) 切回万能班长，恢复；同版式再导一次做对照（证明白字确实画上去了）
await ev(`document.querySelector('[data-watermark="w1"]').click(); 1`);
await new Promise(r => setTimeout(r, 600));
const back = await ev(measure);
console.log('切回万能班长：', JSON.stringify(back));
ok('切回后恢复条内品牌信息与满高', back.brand === 'on' && back.topH === 86 && back.footH === 70 && back.brandDisplay === 'flex' && back.footLeftDisplay === 'flex' && back.posterH === before.posterH, JSON.stringify({ brand: back.brand, topH: back.topH, footH: back.footH, posterH: back.posterH }));

await ev(`(() => { window.__exportDataUrl = null; return 1; })()`);
await ev(`document.getElementById('exportButton').click(); 'clicked'`);
let dW1 = null;
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    dW1 = await ev(`window.__exportDataUrl`);
    if (dW1) break;
}
if (dW1) {
    const bW1 = Buffer.from(dW1.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, 'export-w1-watermark.png'), bW1);
    const pW1 = await probePixels(bW1, back.topH, back.footH);
    console.log('「万能班长」导出上下色带/白像素：', JSON.stringify({ topPx: pW1.topPx, footPx: pW1.footPx, topWhite: pW1.topWhite, footWhite: pW1.footWhite }));
    ok('对照：万能班长条内白字/logo 有像素', pW1.topWhite > 0 && pW1.footWhite > 0, `topWhite=${pW1.topWhite} footWhite=${pW1.footWhite}`);
    ok('对照：万能班长色带是满高 86 / 70px', pW1.topPx === 172 && pW1.footPx === 140, `${pW1.topPx}/${pW1.footPx}`);
} else {
    ok('对照：万能班长导出成功', false);
}

// 5) 刷新后存档保持「无」
await ev(`document.querySelector('[data-watermark="none"]').click(); 1`);
await new Promise(r => setTimeout(r, 800));
await send('Page.reload', {}, s);
await new Promise(r => setTimeout(r, 2500));
const reloaded = await ev(measure);
ok('刷新后仍是「无」：色带减半、条内信息隐藏', reloaded.brand === 'off' && reloaded.topH === 43 && reloaded.footH === 35 && reloaded.brandDisplay === 'none' && reloaded.footRightDisplay === 'none', JSON.stringify(reloaded));

// 6) 上传图片后，w1 有覆盖层 / none 没有
const installExportHook = () => ev(`(() => {
  window.__exportDataUrl = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    if (blob && blob.type === 'image/png') {
      const rd = new FileReader();
      rd.onload = () => { window.__exportDataUrl = String(rd.result); };
      rd.readAsDataURL(blob);
    }
    return orig(blob);
  };
  return 'hooked';
})()`);

await ev(`document.querySelector('[data-watermark="w1"]').click(); 1`);
await new Promise(r => setTimeout(r, 400));
const doc = await send('DOM.getDocument', {}, s);
const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#posterImages' }, s);
const testImage = path.join(__dirname, '..', 'examples', '163f0615ffd14bd1aa913ae6886d7b42.png');
await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [testImage] }, s);
await new Promise(r => setTimeout(r, 1500));

const withImgW1 = await ev(`(() => { const p = document.getElementById('poster'); p.style.transform='none'; return { watermark: !!document.querySelector('.poster-watermark'), media: document.querySelectorAll('.poster-media').length, mediaH: document.getElementById('posterContent').offsetHeight }; })()`);
ok('万能班长 + 有图：水印覆盖层显示', withImgW1.watermark === true, JSON.stringify(withImgW1));
await ev(`document.querySelector('[data-watermark="none"]').click(); 1`);
await new Promise(r => setTimeout(r, 600));
const withImgNone = await ev(`(() => { const p = document.getElementById('poster'); p.style.transform='none'; return {
  watermark: !!document.querySelector('.poster-watermark'), media: document.querySelectorAll('.poster-media').length,
  posterH: p.offsetHeight, brand: p.dataset.brand,
  topH: document.querySelector('.poster-topbar').offsetHeight,
  footH: document.querySelector('.poster-footer').offsetHeight,
  brandDisplay: getComputedStyle(document.querySelector('.poster-brand')).display,
  footRightDisplay: getComputedStyle(document.querySelector('.poster-footer-right')).display }; })()`);
ok('无 + 有图：水印覆盖层不显示', withImgNone.watermark === false, JSON.stringify(withImgNone));
ok('无 + 有图：色带减半、条内品牌信息隐藏', withImgNone.topH === 43 && withImgNone.footH === 35 && withImgNone.brandDisplay === 'none' && withImgNone.footRightDisplay === 'none', JSON.stringify(withImgNone));

// 该状态导出一次，确认画布也没有水印、色带同步减半
await installExportHook();
await ev(`document.getElementById('exportButton').click(); 'clicked'`);
let d2 = null;
for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    d2 = await ev(`window.__exportDataUrl`);
    if (d2) break;
}
if (d2) {
    const b2 = Buffer.from(d2.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, 'export-none-watermark-with-image.png'), b2);
    console.log(`导出（无 + 有图）：${b2.readUInt32BE(16)}x${b2.readUInt32BE(20)}，期望 1500x${withImgNone.posterH * 2}`);
    ok('无 + 有图：导出尺寸正确', b2.readUInt32BE(16) === 1500 && b2.readUInt32BE(20) === withImgNone.posterH * 2);
    const pImg = await probePixels(b2, withImgNone.topH, withImgNone.footH);
    ok('无 + 有图：导出图色带也是减半且无白字', pImg.topPx === 86 && pImg.footPx === 70 && pImg.topWhite === 0 && pImg.footWhite === 0, JSON.stringify({ topPx: pImg.topPx, footPx: pImg.footPx, topWhite: pImg.topWhite, footWhite: pImg.footWhite }));
} else {
    ok('无 + 有图：导出成功', false, await ev(`document.getElementById('exportStatus').textContent`));
}

ws.close();
