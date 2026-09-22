// 验证「课程信息」默认空值 + 辅导老师显示规则（含失焦自动补「老师」）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = 'http://127.0.0.1:3000/social-poster.html';

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
await send('Page.navigate', { url: PAGE_URL }, s);
await new Promise(r => setTimeout(r, 2000));

const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }, s);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
};

// ① 首次进入（清空本地存档后）表单默认值
await ev(`localStorage.clear(); location.reload(); 'reloading'`);
await new Promise(r => setTimeout(r, 2500));

const defaults = await ev(`(() => {
  const fields = ['region','school','major','courseCode','teacher','courseName'];
  const inputs = Object.fromEntries(fields.map(f => [f, document.getElementById(f).value]));
  return {
    inputs,
    chips: [document.getElementById('previewChipSchool').textContent,
            document.getElementById('previewChipCourse').textContent,
            document.getElementById('previewCourseName').textContent]
  };
})()`);
console.log('① 清空存档后各输入框的值：');
for (const [k, v] of Object.entries(defaults.inputs)) console.log(`   ${k.padEnd(11)} = ${JSON.stringify(v)}`);
console.log('   海报占位：', defaults.chips.map(c => JSON.stringify(c)).join('  '));

// ② 旧版本存档（预填示例值）应被清空
await ev(`localStorage.setItem('clasbro-social-poster-v1', JSON.stringify({ theme:'thesis', titleSecondary:'好评分享', watermark:'w1', region:'澳洲', school:'昆士兰大学', major:'食品科学', courseCode:'BIOL1020', teacher:'Michelle.许老师', courseName:'Genes, Cells & Evolution' })); location.reload(); 'reloading'`);
await new Promise(r => setTimeout(r, 2500));
const migrated = await ev(`(() => {
  const fields = ['region','school','major','courseCode','teacher','courseName'];
  return { inputs: Object.fromEntries(fields.map(f => [f, document.getElementById(f).value])), theme: document.getElementById('theme').value };
})()`);
console.log('\n② 载入旧版本存档（原本预填示例值）：');
for (const [k, v] of Object.entries(migrated.inputs)) console.log(`   ${k.padEnd(11)} = ${JSON.stringify(v)}`);
console.log(`   产品类型保留（存档里的 thesis）= ${migrated.theme}`);

// ③ 辅导老师：输入 → 失焦 → 海报显示
const cases = ['Michelle.许', 'Tilley.方思思', 'Michelle.许老师', 'Mr. Wang', '', '双木老师'];
console.log('\n③ 辅导老师显示规则：');
for (const input of cases) {
    const r = await ev(`(() => {
      const el = document.getElementById('teacher');
      el.value = ${JSON.stringify(input)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('blur'));
      return { input: el.value, chip: document.getElementById('previewChipCourse').textContent };
    })()`);
    console.log(`   填 ${JSON.stringify(input).padEnd(16)} → 编辑框 ${JSON.stringify(r.input).padEnd(18)} 海报 ${JSON.stringify(r.chip)}`);
}

ws.close();
