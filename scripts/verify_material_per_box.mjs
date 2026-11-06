// 验证「每张成品图各自设置素材类型」：
// 单张默认值 → 多张互不影响 → 切换预览 → 刷新后存档保留 → 自定义文字
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'http://127.0.0.1:3000/social-poster.html';
const SHOT_DIR = path.join(__dirname, '_verify');

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
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false }, s);

const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, s);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails));
    return r.result.result.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, s);
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'));
}

// 造一张真图（用页面自身 canvas 生成 PNG）再模拟拖入粘贴框
const DROP_SCRIPT = (group, hue) => `(async () => {
  const c = document.createElement('canvas');
  c.width = 700; c.height = 460;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'hsl(${hue} 70% 55%)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText('IMG ${group}', 40, 240);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const file = new File([blob], 'shot-${group}.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const box = document.querySelector('.paste-box[data-box="' + ${group} + '"]');
  box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
})()`;

const READ_SCRIPT = `(() => {
  const span = (root, index) => {
    const row = root.querySelector('.poster-title');
    if (!row) return null;
    const s = row.querySelectorAll(':scope > span')[index];
    return s ? { text: s.textContent, hidden: s.hidden, width: s.offsetWidth } : null;
  };
  const hosts = Array.from(document.querySelectorAll('#posterStage .poster-host')).map(host => {
    const art = host.querySelector('.poster');
    return {
      group: Number(host.dataset.group),
      active: host.classList.contains('is-active'),
      secondary: span(art, 1),
      label: host.querySelector('.poster-host-label')?.textContent || ''
    };
  });
  const boxes = Array.from(document.querySelectorAll('.paste-box')).map(box => ({
    group: Number(box.dataset.box),
    select: box.querySelector('[data-box-material]')?.value,
    customHidden: box.querySelector('[data-box-material-custom]')?.hidden,
    customValue: box.querySelector('[data-box-material-custom]')?.value,
    count: box.querySelector('.paste-box-count')?.textContent,
    active: box.classList.contains('is-active')
  }));
  return {
    hosts,
    boxes,
    main: span(document.getElementById('poster'), 1),
    hasTopSelect: Boolean(document.getElementById('titleSecondary')),
    posterHeight: document.getElementById('poster').offsetHeight
  };
})()`;

const setMaterial = (group, value) => `(() => {
  const sel = document.querySelector('.paste-box[data-box="' + ${group} + '"] [data-box-material]');
  sel.value = ${JSON.stringify(value)};
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`;

const fail = [];
const check = (name, ok, detail) => {
    if (!ok) fail.push(`${name}${detail ? ` → ${detail}` : ''}`);
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// ---------- ① 首次进入 ----------
await send('Page.navigate', { url: PAGE_URL }, s);
await wait(2200);
await ev(`localStorage.clear(); location.reload(); 'ok'`);
await wait(2200);
let st = await ev(READ_SCRIPT);
check('顶部不再有全局素材类型下拉框', st.hasTopSelect === false);
check('单个粘贴框默认素材类型 = 课堂展示', st.boxes.length === 1 && st.boxes[0].select === '课堂展示', JSON.stringify(st.boxes.map(b => b.select)));
check('海报标题显示默认素材类型', st.main.text === '课堂展示', st.main.text);
await shot('material-single-default.png');

// ---------- ② 第 1 张改成 高分喜报 ----------
await ev(DROP_SCRIPT(1, 12), true);
await wait(900);
await ev(setMaterial(1, '高分喜报'));
await wait(400);
st = await ev(READ_SCRIPT);
check('成品图 1 改成「高分喜报」后海报同步', st.main.text === '高分喜报', st.main.text);

// ---------- ③ 新增第 2 张 ----------
await ev(`document.getElementById('addPasteBox').click(); 'ok'`);
await wait(500);
st = await ev(READ_SCRIPT);
check('新增后有两个粘贴框', st.boxes.length === 2);
check('新框沿用上一张的素材类型', st.boxes[1].select === '高分喜报', st.boxes[1].select);
check('切到新框后海报显示 = 高分喜报', st.main.text === '高分喜报', st.main.text);

await ev(DROP_SCRIPT(2, 210), true);
await wait(900);
await ev(setMaterial(2, '好评分享'));
await wait(500);
st = await ev(READ_SCRIPT);
check('成品图 2 改成「好评分享」后海报同步', st.main.text === '好评分享', st.main.text);
const host1 = st.hosts.find(h => h.group === 1);
const host2 = st.hosts.find(h => h.group === 2);
check('并排预览里成品图 1 仍是「高分喜报」', host1 && host1.secondary.text === '高分喜报', host1?.secondary.text);
check('并排预览里成品图 2 是「好评分享」', host2 && host2.secondary.text === '好评分享', host2?.secondary.text);
check('并排预览的标签带出各自的素材类型', (host1?.label || '').includes('高分喜报') && (host2?.label || '').includes('好评分享'), `${host1?.label} | ${host2?.label}`);
await shot('material-two-groups.png');

// ---------- ④ 切回成品图 1 ----------
await ev(`document.querySelector('.paste-box[data-box="1"] .paste-box-name').click(); 'ok'`);
await wait(500);
st = await ev(READ_SCRIPT);
check('切回成品图 1 后海报显示「高分喜报」', st.main.text === '高分喜报', st.main.text);
check('成品图 2 的设置为「好评分享」不受影响', st.boxes[1].select === '好评分享', st.boxes[1].select);

// ---------- ⑤ 自定义素材类型 ----------
await ev(setMaterial(2, '自定义'));
await wait(400);
st = await ev(READ_SCRIPT);
check('选「自定义」后出现输入框', st.boxes[1].customHidden === false);
check('未填内容时海报回落成「自定义」', st.hosts.find(h => h.group === 2)?.secondary.text === '自定义', st.hosts.find(h => h.group === 2)?.secondary.text);
await ev(`(() => {
  const input = document.querySelector('.paste-box[data-box="2"] [data-box-material-custom]');
  input.value = '辅导下单';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`);
await wait(400);
st = await ev(READ_SCRIPT);
check('自定义文字立刻出现在成品图 2 上', st.hosts.find(h => h.group === 2)?.secondary.text === '辅导下单', st.hosts.find(h => h.group === 2)?.secondary.text);
check('自定义输入框仍保持焦点（未被重建）', await ev(`document.activeElement && document.activeElement.dataset.boxMaterialCustom === '2'`));

// ---------- ⑥ 删掉成品图 1，设置随框前移 ----------
await ev(`document.querySelector('.paste-box[data-box="1"] [data-remove-box]').click(); 'ok'`);
await wait(600);
st = await ev(READ_SCRIPT);
check('删除成品图 1 后只剩一个框', st.boxes.length === 1, String(st.boxes.length));
check('原成品图 2 的设置前移到成品图 1', st.boxes[0]?.select === '自定义' && st.boxes[0]?.customValue === '辅导下单', `${st.boxes[0]?.select}/${st.boxes[0]?.customValue}`);
check('前移后海报显示的就是「辅导下单」', st.main.text === '辅导下单', st.main.text);
await shot('material-after-remove.png');

// ---------- ⑦ 刷新后存档保留 ----------
// 注意：粘贴框数量 / 图片本来就不进存档（刷新后回到 1 个空框），素材类型跟着框号存
await ev(`location.reload(); 'ok'`);
await wait(2200);
st = await ev(READ_SCRIPT);
check('刷新后回到 1 个空粘贴框', st.boxes.length === 1, String(st.boxes.length));
check('刷新后素材类型仍是「自定义 / 辅导下单」', st.boxes[0]?.select === '自定义' && st.boxes[0]?.customValue === '辅导下单', `${st.boxes[0]?.select}/${st.boxes[0]?.customValue}`);
check('刷新后海报仍是「辅导下单」', st.main.text === '辅导下单', st.main.text);

// ---------- ⑧ 关掉「素材类型显示」时，几张成品图一起隐藏 ----------
await ev(`document.getElementById('addPasteBox').click(); 'ok'`);
await wait(400);
await ev(`(() => {
  const box = document.getElementById('showTitleSecondary');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return box.checked;
})()`);
await wait(500);
st = await ev(READ_SCRIPT);
check('关掉显示后主海报的素材类型块隐藏', st.main.hidden === true && st.main.width === 0, `${st.main.hidden}/${st.main.width}`);
check('关掉显示后并排预览的每一张都隐藏', st.hosts.every(h => h.secondary && h.secondary.hidden && h.secondary.width === 0), JSON.stringify(st.hosts.map(h => [h.group, h.secondary.hidden, h.secondary.width])));
await shot('material-hidden.png');

await ev(`(() => {
  const box = document.getElementById('showTitleSecondary');
  box.checked = true;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return box.checked;
})()`);
await wait(500);
st = await ev(READ_SCRIPT);
check('重新打开后各张成品图恢复各自的素材类型', st.hosts.every(h => h.secondary && !h.secondary.hidden && h.secondary.width > 0), JSON.stringify(st.hosts.map(h => [h.group, h.secondary.text])));

// ---------- ⑨ 两张都按各自的素材类型导出 ----------
await ev(DROP_SCRIPT(1, 12), true);
await wait(700);
await ev(DROP_SCRIPT(2, 210), true);
await wait(700);
await ev(setMaterial(1, '高分喜报'));
await wait(300);
await ev(setMaterial(2, '课后答疑'));
await wait(300);
await ev(`document.getElementById('exportButton').click(); 'ok'`);
await wait(4500);
const status = await ev(`document.getElementById('exportStatus').textContent`);
check('多张成品图导出成功', /已导出 2 张成品图/.test(status), status);
st = await ev(READ_SCRIPT);
check('导出后回到原来那张成品图、素材类型没被改动', st.main.text === '课后答疑', st.main.text);

ws.close();

console.log(fail.length ? `\n❌ 失败 ${fail.length} 项：\n- ${fail.join('\n- ')}` : '\n✅ 全部通过');
process.exit(fail.length ? 1 : 0);
