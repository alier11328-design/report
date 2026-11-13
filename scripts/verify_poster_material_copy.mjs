/**
 * 回归验证：多成品图并排时，复制/导出的「素材类型」必须取当前那张，不能串到 1 号图。
 *
 * 前置：node server.js（3000）+ 无头 Chrome --remote-debugging-port=9222
 * 运行：node scripts/verify_poster_material_copy.mjs [--png]
 *       --png 会把双击复制出的海报顶部另存为 scripts/verify_poster_material_top.png 供肉眼核对。
 *
 * 期望：
 *   ② 双击第 2 张 -> 画布文字 ["辅导展示"]（曾错画成 1 号图的「课堂展示」）
 *   ④ 按钮批量   -> ["辅导展示","课堂展示"]（曾因切图竞态变成两张「课堂展示」）
 *   ④ 双击第 1 张 / 只剩 1 张 -> ["课堂展示"]
 */
import fs from 'node:fs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
await send('Page.enable', {}, s);
await send('Runtime.enable', {}, s);
await send('Page.navigate', { url: 'http://127.0.0.1:3000/social-poster.html' }, s);
await sleep(2200);
const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, s);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
};

await ev(`localStorage.clear(); location.reload(); 'ok'`);
await sleep(2200);

// 两张成品图，各放一张示例图
await ev(`document.getElementById('addPasteBox').click(); 'added'`);
await sleep(400);
for (const g of [1, 2]) {
    await ev(`(async () => {
      const res = await fetch('/examples/ai-sample-screenshots/period-feedback-schedule.png');
      const blob = await res.blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'sample.png', { type: 'image/png' }));
      const input = document.getElementById('posterImages-${g}');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    await sleep(700);
}

// 第 1 张跟随顶部默认「课堂展示」，第 2 张单独改成「辅导展示」
const before = await ev(`(() => {
  const sel = document.querySelector('[data-box-material="2"]');
  sel.value = '辅导展示';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    top: document.getElementById('titleSecondary').value,
    box1: document.querySelector('[data-box-material="1"]').value,
    box2: sel.value,
    hosts: Array.from(document.querySelectorAll('.poster-host')).map(h => ({
      group: h.dataset.group,
      title: h.querySelectorAll('.poster-title > span')[1]?.textContent,
      label: h.querySelector('.poster-host-label')?.textContent
    }))
  };
})()`);
console.log('① 双击前设置：', JSON.stringify(before));

// 钩子：记录画进画布的文字，并截下画布顶部（标题区）
await ev(`(() => {
  window.__canvasTexts = [];
  window.__captures = [];
  const origFill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (txt, ...rest) {
    window.__canvasTexts.push(String(txt));
    return origFill.call(this, txt, ...rest);
  };
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
    try {
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = Math.min(this.height, 560);
      c.getContext('2d').drawImage(this, 0, 0, this.width, c.height, 0, 0, this.width, c.height);
      window.__capturedPng = c.toDataURL('image/png');
      window.__capturedTitle = document.getElementById('previewTitleSecondary').textContent;
      window.__firstTitleRow = document.querySelector('.poster-title')?.children[1]?.textContent;
      window.__capturedGroup = document.getElementById('posterHost').dataset.group;
      window.__captures = window.__captures || [];
      window.__captures.push({ group: window.__capturedGroup, title: window.__capturedTitle, firstRow: window.__firstTitleRow });
    } catch (e) { window.__captureErr = String(e); }
    return origToBlob.call(this, cb, ...rest);
  };
  try { if (navigator.clipboard) navigator.clipboard.write = async () => {}; } catch (e) { window.__hookErr = String(e); }
  return 'hooked';
})()`);

// 双击第 2 张成品图
await ev(`(() => {
  const host = Array.from(document.querySelectorAll('.poster-host')).find(h => h.dataset.group === '2');
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 60, clientY: r.top + 60 }));
  return 'dblclicked group 2';
})()`);
for (let i = 0; i < 40; i++) {
    const busy = await ev(`document.getElementById('exportButton').disabled`);
    if (!busy && i > 1) break;
    await sleep(500);
}
await sleep(600);

const after = await ev(`({
  canvasTitleWords: window.__canvasTexts.filter(t => /展示|喜报|分享|答疑|复购|下单|自定义|课堂/.test(t)),
  capturedTitle: window.__capturedTitle,
  firstTitleRow: window.__firstTitleRow,
  capturedGroup: window.__capturedGroup,
  captureErr: window.__captureErr || '',
  hookErr: window.__hookErr || '',
  top: document.getElementById('titleSecondary').value,
  box1: document.querySelector('[data-box-material="1"]')?.value,
  box2: document.querySelector('[data-box-material="2"]')?.value,
  activeGroup: document.getElementById('posterHost').dataset.group,
  hosts: Array.from(document.querySelectorAll('.poster-host')).map(h => ({
    group: h.dataset.group,
    title: h.querySelectorAll('.poster-title > span')[1]?.textContent
  })),
  status: document.getElementById('exportStatus').textContent
})`);
console.log('② 双击复制后：', JSON.stringify(after, null, 2));

const png = await ev(`window.__capturedPng || ''`);
console.log('③ 画布顶部快照：', png ? `已捕获（${Math.round(png.length / 1024)} KB）` : '未捕获到画布');
if (png && process.argv.includes('--png')) {
    const out = 'scripts/verify_poster_material_top.png';
    fs.writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
    console.log('   已保存：', out);
}

// ④ 其它入口回归：双击第 2 张、双击第 1 张、只剩 1 张
async function runCase(label, triggerExpr) {
    await ev(`window.__canvasTexts = []; window.__captures = []; 'cleared'`);
    await ev(triggerExpr);
    for (let i = 0; i < 40; i++) {
        const busy = await ev(`document.getElementById('exportButton').disabled`);
        if (!busy && i > 1) break;
        await sleep(400);
    }
    await sleep(300);
    const words = await ev(`window.__canvasTexts.filter(t => /展示|喜报|分享|答疑|复购|下单|自定义|课堂/.test(t))`);
    const captures = await ev(`window.__captures || []`);
    const active = await ev(`document.getElementById('posterHost').dataset.group`);
    console.log(`④ ${label}\n   画布文字 = ${JSON.stringify(words)}  捕获 = ${JSON.stringify(captures)}  当前张 = ${active}`);
}
await runCase('双击第 2 张（当前水印版）',
    `(() => { const h = Array.from(document.querySelectorAll('.poster-host')).find(x => x.dataset.group === '2'); h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 })); return 'ok'; })()`);
await runCase('双击第 1 张',
    `(() => { const h = Array.from(document.querySelectorAll('.poster-host')).find(x => x.dataset.group === '1'); h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 })); return 'ok'; })()`);
await runCase('删掉第 2 个框后只剩 1 张',
    `(() => { const b = document.querySelector('[data-remove-box="2"]'); if (b) b.click(); setTimeout(() => { const h = document.querySelector('.poster-host'); if (h) h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 })); }, 500); return 'ok'; })()`);

await send('Target.closeTarget', { targetId: t.result.targetId });
ws.close();
process.exit(0);
