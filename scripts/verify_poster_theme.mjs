// 视觉校验：截取「项目海报」与「参考稿」在各产品类型下的渲染结果，输出到 scripts/_verify 目录
// 用法：node scripts/verify_poster_theme.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '_verify');
const CDP = 'http://127.0.0.1:9222';
const THEMES = ['course', 'paper', 'custom', 'thesis', 'cram', 'hours', 'papercard', 'preview', 'homework', 'polish', 'papercustom'];

const PROJECT_URL = process.env.PROJECT_URL || 'http://127.0.0.1:3000/social-poster.html';
const REFERENCE_URL = process.env.REFERENCE_URL || fileUrl('D:/桌面/朋友圈海报.html');

function fileUrl(winPath) {
    const segs = String(winPath).replace(/\\/g, '/').split('/');
    return 'file:///' + segs.map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
    const info = await (await fetch(`${CDP}/json/version`)).json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    return { ws, send };
}

async function openTarget(send, url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
        width: 1400, height: 2000, deviceScaleFactor: 2, mobile: false
    }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    await sleep(2500);
    return sessionId;
}

async function evaluate(send, sessionId, expression) {
    const res = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
    }, sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' :: ' + expression);
    return res.result.value;
}

async function shoot(send, sessionId, selector, file) {
    const box = await evaluate(send, sessionId, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    })()`);
    if (!box || !box.width) throw new Error('未找到元素 ' + selector);
    const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
    }, sessionId);
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(shot.data, 'base64'));
    return box;
}

const { ws, send } = await connect();
const report = [];

try {
    // ---------- 项目海报 ----------
    const projectSession = await openTarget(send, PROJECT_URL);
    await evaluate(send, projectSession, `document.getElementById('poster').style.transform = 'none'; 'ok'`);
    for (const theme of THEMES) {
        await evaluate(send, projectSession, `(() => {
            localStorage.removeItem('clasbro-social-poster-v1');
            const sel = document.getElementById('theme');
            sel.value = ${JSON.stringify(theme)};
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('poster').style.transform = 'none';
            return document.getElementById('poster').dataset.theme;
        })()`);
        await sleep(700);
        const box = await shoot(send, projectSession, '#poster', `project-${theme}.png`);
        const tokens = await evaluate(send, projectSession, `(() => {
            const cs = getComputedStyle(document.getElementById('poster'));
            const keys = ['--poster-primary','--poster-primary-dark','--poster-primary-light','--poster-primary-rgb','--poster-accent','--poster-accent-rgb','--poster-accent-deep','--poster-soft'];
            const out = {};
            keys.forEach(k => out[k] = cs.getPropertyValue(k).trim());
            out.theme = document.getElementById('poster').dataset.theme;
            return out;
        })()`);
        report.push({ side: 'project', theme, box: { w: Math.round(box.width), h: Math.round(box.height) }, tokens });
    }

    // ---------- 参考稿 ----------
    const refSession = await openTarget(send, REFERENCE_URL);
    for (const theme of THEMES) {
        const applied = await evaluate(send, refSession, `(() => {
            const tab = document.querySelector('.theme-tab[data-theme=${JSON.stringify(theme)}]');
            if (!tab) return 'no-tab';
            tab.click();
            return document.querySelector('.page').dataset.theme;
        })()`);
        await sleep(700);
        const box = await shoot(send, refSession, '.page', `reference-${theme}.png`);
        const tokens = await evaluate(send, refSession, `(() => {
            const cs = getComputedStyle(document.querySelector('.page'));
            const keys = ['--c-primary','--c-primary-dark','--c-primary-light','--c-primary-rgb','--c-accent','--c-accent-rgb','--c-accent-deep','--c-soft'];
            const out = {};
            keys.forEach(k => out[k] = cs.getPropertyValue(k).trim());
            out.theme = document.querySelector('.page').dataset.theme;
            return out;
        })()`);
        report.push({ side: 'reference', theme, applied, box: { w: Math.round(box.width), h: Math.round(box.height) }, tokens });
    }
} finally {
    ws.close();
}

fs.writeFileSync(path.join(OUT_DIR, 'theme-tokens.json'), JSON.stringify(report, null, 2));

// 逐主题比对色值
const MAP = [
    ['--poster-primary', '--c-primary'],
    ['--poster-primary-dark', '--c-primary-dark'],
    ['--poster-primary-light', '--c-primary-light'],
    ['--poster-primary-rgb', '--c-primary-rgb'],
    ['--poster-accent', '--c-accent'],
    ['--poster-accent-rgb', '--c-accent-rgb'],
    ['--poster-accent-deep', '--c-accent-deep'],
    ['--poster-soft', '--c-soft']
];
console.log('主题色值比对（项目 vs 参考稿）');
let mismatch = 0;
for (const theme of THEMES) {
    const p = report.find(r => r.side === 'project' && r.theme === theme);
    const r = report.find(r => r.side === 'reference' && r.theme === theme);
    const diffs = MAP
        .filter(([a, b]) => String(p.tokens[a]).toLowerCase() !== String(r.tokens[b]).toLowerCase())
        .map(([a, b]) => `${a}: ${p.tokens[a]} ≠ ${r.tokens[b]}`);
    if (diffs.length) mismatch += diffs.length;
    console.log(`  ${theme.padEnd(13)} ${diffs.length ? 'MISMATCH  ' + diffs.join(' | ') : 'OK'}`);
}
console.log(`\n不一致项：${mismatch}`);
console.log(`截图目录：${OUT_DIR}`);
