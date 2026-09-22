// 生成两张整页截图：① 首次进入（课程信息全空）② 填入内容后（老师自动补「老师」）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '_verify');

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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false }, s);
await send('Page.navigate', { url: 'http://127.0.0.1:3000/social-poster.html' }, s);
await new Promise(r => setTimeout(r, 2500));

const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, s);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
};

const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' }, s);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('已保存', name);
};

// ① 清空存档 → 首次进入的默认状态
await ev(`localStorage.clear(); location.reload(); 'reload'`);
await new Promise(r => setTimeout(r, 2800));
const empty = await ev(`(() => {
  const f = ['region','school','major','courseCode','teacher','courseName'];
  return f.map(k => k + '=' + JSON.stringify(document.getElementById(k).value)).join('  ')
    + '   \\n海报：' + document.getElementById('previewChipCourse').textContent;
})()`);
console.log('① 默认状态：', empty);
await shot('form-default-empty.png');

// ② 填入内容（老师故意只写 Michelle.许）
const filled = await ev(`(() => {
  const sample = { region: '澳洲', school: '昆士兰大学', major: '食品科学', courseCode: 'BIOL1020', teacher: 'Michelle.许', courseName: 'Genes, Cells & Evolution' };
  Object.entries(sample).forEach(([k, v]) => {
    const el = document.getElementById(k);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.getElementById('teacher').dispatchEvent(new Event('blur'));
  return {
    teacherInput: document.getElementById('teacher').value,
    teacherChip: document.getElementById('previewChipCourse').textContent,
    courseName: document.getElementById('previewCourseName').textContent
  };
})()`);
console.log('② 填 Michelle.许 后：编辑框 =', JSON.stringify(filled.teacherInput),
    '｜海报 =', JSON.stringify(filled.teacherChip),
    '｜课程名 =', JSON.stringify(filled.courseName));
await new Promise(r => setTimeout(r, 600));
await shot('form-filled-teacher.png');

ws.close();
