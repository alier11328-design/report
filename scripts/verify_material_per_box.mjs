// 验证「素材类型 = 顶部默认值 + 单张覆盖」：
// 顶部改一处全部跟随 → 单张改只动那一张 → 单张改回默认值重新跟随 → 刷新存档 → 隐藏开关 → 多张导出
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
  const boxes = Array.from(document.querySelectorAll('.paste-box')).map(box => {
    const own = box.querySelector('.paste-box-material-own');
    return {
      group: Number(box.dataset.box),
      select: box.querySelector('[data-box-material]')?.value,
      options: Array.from(box.querySelectorAll('[data-box-material] option'), o => o.value),
      ownVisible: Boolean(own && !own.hidden && own.offsetWidth > 0),
      customHidden: box.querySelector('[data-box-material-custom]')?.hidden,
      customValue: box.querySelector('[data-box-material-custom]')?.value,
      count: box.querySelector('.paste-box-count')?.textContent,
      active: box.classList.contains('is-active')
    };
  });
  const topSelect = document.getElementById('titleSecondary');
  const topCustom = document.getElementById('titleSecondaryCustom');
  return {
    hosts,
    boxes,
    main: span(document.getElementById('poster'), 1),
    top: topSelect ? {
      value: topSelect.value,
      options: Array.from(topSelect.options, o => o.value)
    } : null,
    topCustom: topCustom ? { value: topCustom.value, hidden: topCustom.hidden, width: topCustom.offsetWidth } : null
  };
})()`;

// 顶部的默认素材类型
const setDefault = value => `(() => {
  const sel = document.getElementById('titleSecondary');
  sel.value = ${JSON.stringify(value)};
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`;

// 单张成品图的素材类型
const setMaterial = (group, value) => `(() => {
  const sel = document.querySelector('.paste-box[data-box="' + ${group} + '"] [data-box-material]');
  sel.value = ${JSON.stringify(value)};
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`;

const setTopCustom = text => `(() => {
  const input = document.getElementById('titleSecondaryCustom');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()`;

const fail = [];
const check = (name, ok, detail) => {
    if (!ok) fail.push(`${name}${detail ? ` → ${detail}` : ''}`);
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
};

// ---------- ① 首次进入：顶部有默认值，单框跟随 ----------
await send('Page.navigate', { url: PAGE_URL }, s);
await wait(2200);
await ev(`localStorage.clear(); location.reload(); 'ok'`);
await wait(2200);
let st = await ev(READ_SCRIPT);
check('顶部「素材类型」下拉恢复', st.top && st.top.value === '课堂展示', st.top?.value);
check('顶部候选含「辅导下单」「辅导展示」等 9 项', st.top?.options.length === 9
    && st.top.options.includes('辅导下单') && st.top.options.includes('辅导展示'), JSON.stringify(st.top?.options));
check('单个粘贴框默认 = 课堂展示', st.boxes.length === 1 && st.boxes[0].select === '课堂展示', JSON.stringify(st.boxes.map(b => b.select)));
check('默认状态下没有「单独设置」标记', st.boxes[0].ownVisible === false);
check('海报标题显示默认素材类型', st.main.text === '课堂展示', st.main.text);
await shot('material-single-default.png');

// ---------- ② 改顶部默认值，单框跟着变 ----------
await ev(setDefault('好评分享'));
await wait(600);
st = await ev(READ_SCRIPT);
check('顶部选「好评分享」后单框跟着变', st.boxes[0].select === '好评分享', st.boxes[0].select);
check('海报同步「好评分享」', st.main.text === '好评分享', st.main.text);

// ---------- ③ 新增成品图：新框也跟随默认值 ----------
await ev(DROP_SCRIPT(1, 12), true);
await wait(900);
await ev(`document.getElementById('addPasteBox').click(); 'ok'`);
await wait(600);
await ev(DROP_SCRIPT(2, 210), true);
await wait(900);
st = await ev(READ_SCRIPT);
check('新增后有两个粘贴框', st.boxes.length === 2, String(st.boxes.length));
check('新增的成品图也跟随默认值', st.boxes[1].select === '好评分享', st.boxes[1].select);
check('两张海报都是「好评分享」', st.hosts.every(h => h.secondary.text === '好评分享'), JSON.stringify(st.hosts.map(h => h.secondary.text)));

// ---------- ④ 单独改第 2 张，只影响它 ----------
await ev(setMaterial(2, '高分喜报'));
await wait(500);
st = await ev(READ_SCRIPT);
check('成品图 2 改成「高分喜报」', st.boxes[1].select === '高分喜报', st.boxes[1].select);
check('成品图 2 出现「单独设置」标记', st.boxes[1].ownVisible === true);
check('成品图 1 没有标记、仍是好评分享', st.boxes[0].ownVisible === false && st.boxes[0].select === '好评分享', `${st.boxes[0].ownVisible}/${st.boxes[0].select}`);
const host1 = () => st.hosts.find(h => h.group === 1);
const host2 = () => st.hosts.find(h => h.group === 2);
check('并排预览里两张各自不同', host1()?.secondary.text === '好评分享' && host2()?.secondary.text === '高分喜报', `${host1()?.secondary.text} | ${host2()?.secondary.text}`);
check('并排预览标签带出各自素材类型', (host1()?.label || '').includes('好评分享') && (host2()?.label || '').includes('高分喜报'), `${host1()?.label} | ${host2()?.label}`);
await shot('material-two-groups.png');

// ---------- ⑤ 再改顶部：跟随的那张变，单独设置的不动 ----------
await ev(setDefault('课后答疑'));
await wait(600);
st = await ev(READ_SCRIPT);
check('改顶部后跟随中的成品图 1 变成「课后答疑」', st.boxes[0].select === '课后答疑', st.boxes[0].select);
check('单独设置过的成品图 2 保持「高分喜报」', st.boxes[1].select === '高分喜报' && st.boxes[1].ownVisible === true, `${st.boxes[1].select}/${st.boxes[1].ownVisible}`);
check('海报成品图 1 = 课后答疑', host1()?.secondary.text === '课后答疑', host1()?.secondary.text);
check('海报成品图 2 = 高分喜报', host2()?.secondary.text === '高分喜报', host2()?.secondary.text);

// ---------- ⑥ 单张改回默认值 → 重新跟随 ----------
await ev(setMaterial(2, '课后答疑'));
await wait(500);
st = await ev(READ_SCRIPT);
check('成品图 2 改回默认值后「单独设置」标记消失', st.boxes[1].ownVisible === false);
await ev(setDefault('辅导展示'));
await wait(600);
st = await ev(READ_SCRIPT);
check('改回默认后两张都跟随新的默认值「辅导展示」', st.boxes.every(b => b.select === '辅导展示'), JSON.stringify(st.boxes.map(b => b.select)));

// ---------- ⑦ 顶部选「自定义」并输入文字，所有成品图共用 ----------
await ev(setDefault('自定义'));
await wait(500);
st = await ev(READ_SCRIPT);
check('顶部选「自定义」后出现自定义输入框', st.topCustom && st.topCustom.hidden === false);
check('各张下拉也变成「自定义」', st.boxes.every(b => b.select === '自定义'), JSON.stringify(st.boxes.map(b => b.select)));
await ev(setTopCustom('辅导下单'));
await wait(600);
st = await ev(READ_SCRIPT);
check('默认自定义文字立刻出现在两张海报上', st.hosts.every(h => h.secondary.text === '辅导下单'), JSON.stringify(st.hosts.map(h => h.secondary.text)));
check('框内自定义输入框带出同样的文字', st.boxes.every(b => b.customValue === '辅导下单'), JSON.stringify(st.boxes.map(b => b.customValue)));

// ---------- ⑧ 刷新后存档保留 ----------
// 粘贴框数量 / 图片本来就不进存档（刷新后回 1 个空框），素材类型是全局默认值，会存下来
await ev(`location.reload(); 'ok'`);
await wait(2400);
st = await ev(READ_SCRIPT);
check('刷新后回到 1 个空粘贴框', st.boxes.length === 1, String(st.boxes.length));
check('刷新后顶部仍是「自定义」', st.top?.value === '自定义', st.top?.value);
check('刷新后自定义文字仍是「辅导下单」', st.topCustom?.value === '辅导下单', st.topCustom?.value);
check('刷新后海报仍是「辅导下单」', st.main.text === '辅导下单', st.main.text);

// ---------- ⑨ 关掉「素材类型显示」时全部一起隐藏 ----------
await ev(`document.getElementById('addPasteBox').click(); 'ok'`);
await wait(500);
await ev(`(() => {
  const box = document.getElementById('showTitleSecondary');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return box.checked;
})()`);
await wait(600);
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
await wait(600);
st = await ev(READ_SCRIPT);
check('重新打开后各张恢复显示', st.hosts.every(h => h.secondary && !h.secondary.hidden && h.secondary.width > 0));

// ---------- ⑩ 两张按各自的素材类型导出 ----------
await ev(DROP_SCRIPT(1, 12), true);
await wait(800);
await ev(DROP_SCRIPT(2, 210), true);
await wait(800);
await ev(setMaterial(2, '高分喜报'));
await wait(400);
await ev(`document.getElementById('exportButton').click(); 'ok'`);
await wait(4500);
const status = await ev(`document.getElementById('exportStatus').textContent`);
check('多张成品图导出成功', /已导出 2 张成品图/.test(status), status);
st = await ev(READ_SCRIPT);
check('导出后成品图 2 仍是「高分喜报」', host2()?.secondary.text === '高分喜报' || st.main.text === '高分喜报', st.main.text);

ws.close();

console.log(fail.length ? `\n❌ 失败 ${fail.length} 项：\n- ${fail.join('\n- ')}` : '\n✅ 全部通过');
process.exit(fail.length ? 1 : 0);
