// 几何比对：量出项目海报与参考稿各区块的实际盒模型，逐项对照
import fs from 'node:fs';

const info = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); } };
const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

async function open(url) {
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const a = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    const s = a.result.sessionId;
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2000, deviceScaleFactor: 2, mobile: false }, s);
    await send('Page.navigate', { url }, s);
    await new Promise(r => setTimeout(r, 2500));
    return s;
}
const ev = async (s, expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result.result.value;
};

const MEASURE = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '),
    radius: cs.borderRadius, weight: cs.fontWeight, size: cs.fontSize,
    ls: cs.letterSpacing, shadow: cs.boxShadow === 'none' ? '-' : cs.boxShadow
  };
}`;

const projectSession = await open('http://127.0.0.1:3000/social-poster.html');
await ev(projectSession, `document.getElementById('theme').value='thesis';document.getElementById('theme').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('poster').style.transform='none';'ok'`);
await new Promise(r => setTimeout(r, 300));

const project = await ev(projectSession, `(() => {
  const M = ${MEASURE};
  const title = document.querySelector('.poster-title');
  const span1 = title.querySelector('span');
  const span2 = title.querySelector('span:last-child');
  const box = el => { const r = el.getBoundingClientRect(); return { w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
  const cs = el => { const c = getComputedStyle(el); return { pad:[c.paddingTop,c.paddingRight,c.paddingBottom,c.paddingLeft].join(' '), radius:c.borderRadius, weight:c.fontWeight, size:c.fontSize, ls:c.letterSpacing, shadow:c.boxShadow==='none'?'-':c.boxShadow, gap:c.gap }; };
  return {
    poster: M('#poster'),
    topbar: M('.poster-topbar'),
    hero: { ...M('.poster-hero'), bg: getComputedStyle(document.querySelector('.poster-hero')).backgroundImage },
    title: { ...M('.poster-title'), margin: getComputedStyle(title).marginBottom },
    titleSpan1: { ...box(span1), ...cs(span1) },
    titleSpan2: { ...box(span2), ...cs(span2) },
    chips: { ...M('.poster-chips'), ...cs(document.querySelector('.poster-chips')) },
    chip: { ...box(document.querySelector('.poster-chip')), ...cs(document.querySelector('.poster-chip')) },
    course: { ...box(document.querySelector('.poster-course')), ...cs(document.querySelector('.poster-course')) },
    content: { ...M('.poster-content') },
    media: { ...box(document.querySelector('.poster-media')), ...cs(document.querySelector('.poster-media')) },
    footer: M('.poster-footer'),
    footerLeft: M('.poster-footer-left'),
    footerRight: M('.poster-footer-right')
  };
})()`);

const refSession = await open('file:///D:/' + encodeURIComponent('桌面') + '/' + encodeURIComponent('朋友圈海报.html'));
await ev(refSession, `document.querySelector('.theme-tab[data-theme="thesis"]').click();'ok'`);
await new Promise(r => setTimeout(r, 300));

const reference = await ev(refSession, `(() => {
  const M = ${MEASURE};
  const title = document.querySelector('.hero-title');
  const span1 = title.querySelector('span');
  const span2 = title.querySelector('span:last-child');
  const box = el => { const r = el.getBoundingClientRect(); return { w:+r.width.toFixed(1), h:+r.height.toFixed(1) }; };
  const cs = el => { const c = getComputedStyle(el); return { pad:[c.paddingTop,c.paddingRight,c.paddingBottom,c.paddingLeft].join(' '), radius:c.borderRadius, weight:c.fontWeight, size:c.fontSize, ls:c.letterSpacing, shadow:c.boxShadow==='none'?'-':c.boxShadow, gap:c.gap }; };
  return {
    poster: M('.page'),
    topbar: M('.topbar'),
    hero: { ...M('.hero'), bg: getComputedStyle(document.querySelector('.hero')).backgroundImage },
    title: { ...M('.hero-title'), margin: getComputedStyle(title).marginBottom },
    titleSpan1: { ...box(span1), ...cs(span1) },
    titleSpan2: { ...box(span2), ...cs(span2) },
    chips: { ...M('.chips'), ...cs(document.querySelector('.chips')) },
    chip: { ...box(document.querySelector('.chip')), ...cs(document.querySelector('.chip')) },
    course: { ...box(document.querySelector('.course')), ...cs(document.querySelector('.course')) },
    content: { ...M('.content') },
    media: { ...box(document.querySelector('.img-slot')), ...cs(document.querySelector('.img-slot')) },
    footer: M('.footer'),
    footerLeft: M('.footer-left'),
    footerRight: M('.footer-right')
  };
})()`);

ws.close();

const KEYS = ['poster', 'topbar', 'hero', 'title', 'titleSpan1', 'titleSpan2', 'chips', 'chip', 'course', 'content', 'media', 'footer', 'footerLeft', 'footerRight'];
console.log('区块          项目(750宽)                     参考稿(750宽)                    一致?');
for (const k of KEYS) {
    const p = project[k], r = reference[k];
    const fmt = o => o ? `${o.w}x${o.h} pad[${o.pad}] r${o.radius} w${o.weight} ${o.size}` : 'null';
    const same = JSON.stringify(p) === JSON.stringify(r) ? 'SAME' : 'DIFF';
    console.log(`\n[${k}] ${same}`);
    console.log(`   项目  ${fmt(p)}`);
    console.log(`   参考  ${fmt(r)}`);
}
fs.writeFileSync('D:/Trae project/report0922/scripts/_verify/geometry.json', JSON.stringify({ project, reference }, null, 2));
