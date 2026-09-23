// 校验「导出双版本 + 附带复制文案」：
//  ①两个文件都落盘，尺寸各自等于对应预览的 2 倍
//  ②两张图确实是两个不同版本（顶栏色带高度 + 条内白像素 + 图区水印差异）
//  ③导出结束后水印选择、海报高度、左侧高亮、存档被完整还原
//  ④文案随导出进入剪贴板；文案区已有内容时不重新调 AI
//  ⑤「复制带水印图 / 复制无水印图」两个按钮各自一次点击写入对应版本，且不弹任何选择框
// 前置：node server.js 已起（3000），无头 Chrome 已开（9222）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '_verify');
const DL = path.join(OUT, 'downloads');
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const PORT = process.env.PORT || '3000';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PAGE = `${ORIGIN}/social-poster.html`;

const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); } };
const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
await send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });

const t = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const s = attached.result.sessionId;
await send('Page.enable', {}, s);
await send('Runtime.enable', {}, s);
await send('DOM.enable', {}, s);
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 2600, deviceScaleFactor: 1, mobile: false }, s);
ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === s) {
        console.log('  [exception]', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description || '');
    }
});

const ev = async (expression, userGesture = false) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, s);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.text + ' :: ' + (res.result.exceptionDetails.exception?.description || ''));
    return res.result.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const ok = (label, pass, detail) => {
    if (!pass) failed += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
};

// 无头环境访问不了 i.ibb.co（JS fetch 直接 Failed to fetch，且要 26 秒才报错），
// 这里用 CDP 把远程 logo 与水印图回填成本地生成的替身图，
// 让验证专注在导出逻辑本身，而不是测试机的网络可达性。
const stubBase64 = await ev(`(() => {
  const c = document.createElement('canvas');
  c.width = 240; c.height = 120;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 240, 120);
  x.fillStyle = '#222222'; x.fillRect(20, 20, 80, 80);
  return c.toDataURL('image/png').split(',')[1];
})()`);
console.log('替身素材：240×120 白底黑块');
await send('Fetch.enable', { patterns: [{ urlPattern: '*i.ibb.co*' }] }, s);
ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method !== 'Fetch.requestPaused' || m.sessionId !== s) return;
    send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [
            { name: 'Content-Type', value: 'image/png' },
            { name: 'Access-Control-Allow-Origin', value: '*' }
        ],
        body: stubBase64
    }, s);
});

await send('Page.navigate', { url: PAGE }, s);
await wait(2500);
await send('Page.bringToFront', {}, s);

// 0) 清存档 + 固定输入，保证导出文件名可预测
await ev(`(() => { localStorage.removeItem('clasbro-social-poster-v1'); return 1; })()`);
await send('Page.reload', {}, s);
await wait(2500);
await send('Page.bringToFront', {}, s);

await ev(`(() => {
  const set = (eid, v) => { const el = document.getElementById(eid); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('courseCode', 'MATH101');
  set('courseName', '线性代数');
  return 1;
})()`);
await wait(500);

// 1) 上传一张图（有图时图区才会出现水印覆盖层）
const testImage = path.join(__dirname, '..', 'examples', '163f0615ffd14bd1aa913ae6886d7b42.png');
const doc = await send('DOM.getDocument', {}, s);
const fileInput = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#posterImages' }, s);
// setFileInputFiles 自己会触发 change；再手动 dispatch 会让处理函数跑两次、同一张图被加两遍
await send('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [testImage] }, s);
await wait(1800);
ok('只上传了 1 张图片', (await ev(`document.querySelectorAll('.poster-media').length`)) === 1);

// 2) 桩掉 AI：只关心「文案有没有进剪贴板」和「调了几次」，不真的走网络
await ev(`(() => {
  window.__aiCalls = 0;
  window.__fakeCaption = '【测试文案】包课辅导 · 课堂展示\\n第一行内容\\n第二行内容';
  window.aiClient = { request: async () => { window.__aiCalls += 1; return { caption: window.__fakeCaption }; } };
  return 1;
})()`);

const geometry = `(() => {
  const p = document.getElementById('poster');
  const prev = p.style.transform;
  p.style.transform = 'none';
  const c = document.getElementById('posterContent');
  const pr = p.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  const top = document.querySelector('.poster-topbar');
  const res = {
    posterH: p.offsetHeight,
    topbarH: top.offsetHeight,
    contentTop: Math.round(cr.top - pr.top),
    contentH: Math.round(cr.height),
    brand: p.dataset.brand,
    overlay: !!document.querySelector('.poster-watermark'),
    active: Array.from(document.querySelectorAll('[data-watermark]')).filter(el => el.classList.contains('active')).map(el => el.dataset.watermark).join(',')
  };
  p.style.transform = prev;
  return res;
})()`;

const before = await ev(geometry);
console.log('导出前（万能班长）：', JSON.stringify(before));

// 切两次水印，拿到两个状态下图区的几何位置（导出图里按相对位置比对图区像素）
await ev(`document.querySelector('[data-watermark="none"]').click(); 1`);
await wait(800);
const geomNone = await ev(geometry);
await ev(`document.querySelector('[data-watermark="w1"]').click(); 1`);
await wait(800);
const geomW1 = await ev(geometry);
console.log('万能班长：', JSON.stringify(geomW1));
console.log('无      ：', JSON.stringify(geomNone));
ok('两状态顶栏高度分别为 86 / 43', geomW1.topbarH === 86 && geomNone.topbarH === 43, `${geomW1.topbarH} / ${geomNone.topbarH}`);
ok('两状态图区起点不同（版式确实变了）', geomW1.contentTop !== geomNone.contentTop, `${geomW1.contentTop} / ${geomNone.contentTop}`);
ok('万能班长：有图区水印覆盖层', geomW1.overlay === true);
ok('无水印：无图区水印覆盖层', geomNone.overlay === false);

// 3) 点「导出双版本」
const BASE = '包课辅导_MATH101';
const expectFiles = [`${BASE}_带水印.png`, `${BASE}_无水印.png`];
await ev(`document.getElementById('exportBothButton').click(); 1`, true);

let files = [];
for (let i = 0; i < 80; i++) {
    await wait(500);
    files = fs.existsSync(DL) ? fs.readdirSync(DL) : [];
    if (expectFiles.every(f => files.includes(f))) break;
}
console.log('下载目录：', JSON.stringify(files));
ok('两个文件都已落盘', expectFiles.every(f => files.includes(f)), JSON.stringify(files));

const readPng = f => {
    const buf = fs.readFileSync(path.join(DL, f));
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), buf };
};

if (expectFiles.every(f => files.includes(f))) {
    const A = readPng(expectFiles[0]);
    const B = readPng(expectFiles[1]);
    console.log(`带水印 ${A.w}×${A.h}，无水印 ${B.w}×${B.h}`);
    ok('两张图宽度都是 1500', A.w === 1500 && B.w === 1500, `${A.w} / ${B.w}`);
    ok('带水印尺寸 = 对应预览 ×2', A.h === geomW1.posterH * 2, `${A.h} vs ${geomW1.posterH * 2}`);
    ok('无水印尺寸 = 对应预览 ×2', B.h === geomNone.posterH * 2, `${B.h} vs ${geomNone.posterH * 2}`);
    ok('两张图高度差 = 上下色带缩半量 ×2 = 156', A.h - B.h === 156, `实际差 ${A.h - B.h}`);

    const analyze = async (b64, key) => {
        const res = await send('Runtime.evaluate', {
            expression: `(async () => {
  const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = 'data:image/png;base64,' + ${JSON.stringify(b64)}; });
  if (!img) return { error: 'load-failed' };
  window.${key} = img;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const isRed = d => d[0] > 150 && d[1] < 110 && d[2] < 110;
  let bandH = 0;
  for (let y = 0; y < img.height; y++) {
    const d = ctx.getImageData(img.width - 30, y, 1, 1).data;
    if (!isRed(d)) { bandH = y; break; }
  }
  const countWhite = (x, y, w, h) => {
    const d = ctx.getImageData(x, y, w, h).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) n++;
    return n;
  };
  return { w: img.width, h: img.height, bandH, topWhite: countWhite(40, 0, 800, Math.min(bandH, 200)), px: Array.from(ctx.getImageData(img.width - 30, 10, 1, 1).data) };
})()`, awaitPromise: true, returnByValue: true
        }, s);
        if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
        return res.result.result.value;
    };

    const pA = await analyze(A.buf.toString('base64'), '__imgW1');
    const pB = await analyze(B.buf.toString('base64'), '__imgNone');
    console.log('带水印顶栏统计：', JSON.stringify(pA));
    console.log('无水印顶栏统计：', JSON.stringify(pB));
    ok('带水印顶栏色带高 ≈ 86×2', Math.abs(pA.bandH - 172) <= 3, String(pA.bandH));
    ok('无水印顶栏色带高 ≈ 43×2', Math.abs(pB.bandH - 86) <= 3, String(pB.bandH));
    ok('带水印顶栏仍是品牌红', pA.px[0] > 150 && pA.px[1] < 110, JSON.stringify(pA.px));
    ok('无水印顶栏仍是品牌红', pB.px[0] > 150 && pB.px[1] < 110, JSON.stringify(pB.px));
    ok('带水印条内有 logo/白字', pA.topWhite > 500, `白像素 ${pA.topWhite}`);
    ok('无水印条内无 logo/白字', pB.topWhite === 0, `白像素 ${pB.topWhite}`);

    // 图区水印：整块图区按相对位置对齐后比对。两图内容相同，
    // 带水印版多出水印图案 → 差异像素占比应显著大于 0
    const yA = geomW1.contentTop * 2;
    const yB = geomNone.contentTop * 2;
    const band = Math.round(geomW1.contentH * 2);
    const diff = await send('Runtime.evaluate', {
        expression: `(() => {
  const mk = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0); return x; };
  const ca = mk(window.__imgW1), cb = mk(window.__imgNone);
  const H = ${band}, W = window.__imgW1.width;
  const da = ca.getImageData(0, ${yA}, W, H).data;
  const db = cb.getImageData(0, ${yB}, W, H).data;
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]) > 24) n++;
  }
  return { total: da.length / 4, diff: n, ratio: +(n / (da.length / 4) * 100).toFixed(2) };
})()`, returnByValue: true
    }, s);
    const d = diff.result.result.value;
    console.log('图区（相同相对位置）差异：', JSON.stringify(d));
    ok('图区水印确实画进了带水印版', d.ratio > 0.5, `差异占比 ${d.ratio}%`);
}

// 4) 导出后状态还原
const after = await ev(geometry);
console.log('导出后：', JSON.stringify(after));
ok('导出后水印选择还原为万能班长', after.active === 'w1' && after.brand === 'on', `${after.active} / ${after.brand}`);
ok('导出后海报高度还原', after.posterH === before.posterH, `${before.posterH} → ${after.posterH}`);
ok('导出后图区水印覆盖层仍在', after.overlay === true);
ok('遮罩已关闭', (await ev(`document.getElementById('previewVeil').hidden`)) === true);
const savedWatermark = await ev(`JSON.parse(localStorage.getItem('clasbro-social-poster-v1') || '{}').watermark`);
ok('存档未被临时状态污染', savedWatermark === 'w1', String(savedWatermark));
ok('主按钮恢复可用且文案已还原', (await ev(`document.getElementById('exportBothButton').disabled`)) === false && (await ev(`document.getElementById('exportBothButton').textContent`)).includes('导出双版本'));

// 5) 文案进剪贴板
await wait(1500);
const clip = await ev(`navigator.clipboard.readText()`, true);
const fake = await ev(`window.__fakeCaption`);
// 剪贴板在 Windows 上会把 \n 规范成 \r\n，比对前先归一化
const norm = value => String(value ?? '').replace(/\r\n/g, '\n');
ok('文案已进入剪贴板', norm(clip) === norm(fake) && norm(clip).length > 0, JSON.stringify(String(clip).slice(0, 30)));
const calls1 = await ev(`window.__aiCalls`);
ok('导出时自动生成了 1 次文案', calls1 === 1, `调用 ${calls1} 次`);

// 6) 再导出一次：文案区已有内容，不应重新调 AI
await ev(`document.getElementById('exportBothButton').click(); 1`, true);
await wait(7000);
const calls2 = await ev(`window.__aiCalls`);
ok('文案已存在时不重新调 AI', calls2 === 1, `调用 ${calls2} 次`);

// 7) 复制图片：两个按钮各自直接复制对应版本（不再弹窗二次选择）
// 读回剪贴板里的 PNG 逐版检查尺寸与条内白像素，证明两个按钮复制的确实是不同版本
const readClipImage = `(async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = Array.from(it.types).find(x => String(x).startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const countWhite = (x, y, w, h) => {
        const d = ctx.getImageData(x, y, w, h).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) n++;
        return n;
      };
      // 先沿右边缘量出顶栏色带实际高度：白像素只能在色带范围内数，
      // 否则会扫到条下方的大片白色内容区，把结论带偏
      const isRed = d => d[0] > 150 && d[1] < 110 && d[2] < 110;
      let bandH = bmp.height;
      for (let y = 0; y < bmp.height; y++) {
        if (!isRed(ctx.getImageData(bmp.width - 30, y, 1, 1).data)) { bandH = y; break; }
      }
      return {
        w: bmp.width, h: bmp.height, bandH,
        topWhite: countWhite(40, 0, 800, Math.max(1, bandH - 4)),
        px: Array.from(ctx.getImageData(bmp.width - 30, 10, 1, 1).data)
      };
    }
    return { error: 'no-image-in-clipboard' };
  } catch (e) { return { error: e.message }; }
})()`;

const clickAndReadClip = async buttonId => {
    // 先把剪贴板占成纯文本：这样「读到图片」就等于本次点击确实写进去了，
    // 否则会读到上一次复制留下的旧图，断言会假通过
    await ev(`navigator.clipboard.writeText('__awaiting-copy__')`, true);
    await wait(400);
    await ev(`document.getElementById('${buttonId}').click(); 1`, true);
    let shot = null;
    for (let i = 0; i < 40; i++) {
        await wait(400);
        shot = await ev(readClipImage, true);
        if (shot && !shot.error) break;
        shot = null;
    }
    return shot;
};

const copyW1 = await clickAndReadClip('copyW1Button');
console.log('复制带水印图：', JSON.stringify(copyW1));
ok('「复制带水印图」一次点击即写入剪贴板', Boolean(copyW1), '未读到图片');
if (copyW1) {
    ok('带水印：剪贴板图片尺寸 = 对应预览 ×2', copyW1.w === 1500 && copyW1.h === geomW1.posterH * 2, `${copyW1.w}×${copyW1.h}，期望 1500×${geomW1.posterH * 2}`);
    ok('带水印：顶栏色带高 ≈ 172', Math.abs(copyW1.bandH - 172) <= 3, String(copyW1.bandH));
    ok('带水印：顶栏仍是品牌红', copyW1.px[0] > 150 && copyW1.px[1] < 110, JSON.stringify(copyW1.px));
    ok('带水印：条内有 logo/白字', copyW1.topWhite > 500, `白像素 ${copyW1.topWhite}`);
    ok('带水印：状态提示成功', /已复制带水印图片/.test(await ev(`document.getElementById('exportStatus').textContent`)), await ev(`document.getElementById('exportStatus').textContent`));
}

const copyNone = await clickAndReadClip('copyNoneButton');
console.log('复制无水印图：', JSON.stringify(copyNone));
ok('「复制无水印图」一次点击即写入剪贴板', Boolean(copyNone), '未读到图片');
if (copyNone) {
    ok('无水印：剪贴板图片尺寸 = 对应预览 ×2', copyNone.w === 1500 && copyNone.h === geomNone.posterH * 2, `${copyNone.w}×${copyNone.h}，期望 1500×${geomNone.posterH * 2}`);
    ok('无水印：顶栏色带高 ≈ 86', Math.abs(copyNone.bandH - 86) <= 3, String(copyNone.bandH));
    ok('无水印：顶栏仍是品牌红', copyNone.px[0] > 150 && copyNone.px[1] < 110, JSON.stringify(copyNone.px));
    ok('无水印：条内无 logo/白字', copyNone.topWhite === 0, `白像素 ${copyNone.topWhite}`);
    ok('无水印：状态提示成功', /已复制无水印图片/.test(await ev(`document.getElementById('exportStatus').textContent`)), await ev(`document.getElementById('exportStatus').textContent`));
}

if (copyW1 && copyNone) {
    ok('两个按钮复制的确实是不同版本（高度差 = 色带缩半量 ×2 = 156）', copyW1.h - copyNone.h === 156, `实际差 ${copyW1.h - copyNone.h}`);
}

// 拆按钮后不应再有任何选择弹窗，水印选择与遮罩也不该被改动
ok('页面已无复制选择弹窗', (await ev(`document.querySelectorAll('.choice-modal').length`)) === 0);
ok('两个按钮都在同一行且都可用', (await ev(`(() => {
  const a = document.getElementById('copyW1Button'), b = document.getElementById('copyNoneButton');
  return !a.disabled && !b.disabled && Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2;
})()`)) === true);
const copyAfter = await ev(geometry);
ok('复制图片后水印选择仍是万能班长', copyAfter.active === 'w1' && copyAfter.brand === 'on', `${copyAfter.active} / ${copyAfter.brand}`);
ok('复制图片后遮罩已关闭', (await ev(`document.getElementById('previewVeil').hidden`)) === true);

ws.close();
console.log(failed === 0 ? '\n全部断言通过 ✅' : `\n${failed} 项未通过 ❌`);
