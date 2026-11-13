// 校验：切到「无水印」时部分产品类型的显示名自动替换（预览 / 画布 / 文件名 / 左侧提示），
// 切回「万能班长」恢复；配色与左侧下拉值始终不变。
// 用法：先启动本地 server + 无头 Chrome(9222)，再 node scripts/verify_no_watermark_theme_titles.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP = 'http://127.0.0.1:9222';
const PAGE = process.env.PROJECT_URL || 'http://127.0.0.1:3000/social-poster.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const ok = (label, pass, detail = '') => {
    if (!pass) failures += 1;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
};

// [theme key, 带水印显示, 无水印显示]
const THEMES = [
    ['course', '包课辅导', '包课辅导'],
    ['paper', '论文辅导', '论文导航'],
    ['custom', '定制辅导', '定制辅导'],
    ['thesis', '毕业论文', '毕业论文'],
    ['cram', '考前突击', '押题课'],
    ['hours', '课时卡', '讲课卡'],
    ['papercard', '论文卡', '论文导航'],
    ['preview', '课程预习', '课程预习'],
    ['homework', '作业辅导', '作业辅导'],
    ['polish', '修改润色', '修改润色'],
    ['papercustom', '论文定制', '论文定制']
];

// ---------- 静态源码断言 ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'social-poster.html'), 'utf8');
ok('源码：映射表含 4 条规则',
    ["hours: '讲课卡'", "cram: '押题课'", "paper: '论文导航'", "papercard: '论文导航'"]
        .every(s => src.includes(s)));
ok('源码：预览标题走 displayThemeTitle()', src.includes('titlePrimary: displayThemeTitle(),'));
ok('源码：AI 文案 productType 走 displayThemeTitle()', src.includes('productType: displayThemeTitle(),'));
ok('源码：图库 product_type 走 displayThemeTitle()', src.includes('product_type: displayThemeTitle(),'));
ok('源码：文件名按水印版本取名', src.includes('const variantBase = posterFileBase(variant.watermark);'));

// ---------- CDP ----------
const info = await (await fetch(`${CDP}/json/version`)).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
let sessionId = null;
const pending = new Map();
const exceptions = [];
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId === sessionId) {
        exceptions.push(m.params.exceptionDetails.text + ' :: ' + (m.params.exceptionDetails.exception?.description || ''));
    }
};
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
};
const waitFor = async (expression, predicate, timeout = 40000) => {
    const start = Date.now();
    let value;
    do {
        value = await ev(expression);
        if (predicate(value)) return value;
        await sleep(300);
    } while (Date.now() - start < timeout);
    return value;
};

const created = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
sessionId = attached.sessionId;
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2000, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: PAGE }, sessionId);
await sleep(2500);

// 清存档 + 重载，保证默认「万能班长」+ 默认产品类型
await ev(`localStorage.removeItem('clasbro-social-poster-v1'); 1`);
await send('Page.reload', {}, sessionId);
await sleep(2200);

const setTheme = theme => ev(`(() => {
    const sel = document.getElementById('theme');
    sel.value = ${JSON.stringify(theme)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
})()`);
const readState = () => ev(`(() => ({
    title: document.getElementById('previewTitlePrimary').textContent,
    hint: document.getElementById('themeTitleHint').textContent,
    selectValue: document.getElementById('theme').value,
    dataTheme: document.getElementById('poster').dataset.theme,
    brand: document.getElementById('poster').dataset.brand,
    activeWatermark: Array.from(document.querySelectorAll('[data-watermark]')).filter(el => el.classList.contains('active')).map(el => el.dataset.watermark).join(',')
}))()`);
const setWatermark = value => ev(`document.querySelector('[data-watermark=${JSON.stringify(value)}]').click(); 1`);

// ---------- 1) 带水印：11 个产品类型全部显示原词 ----------
console.log('\n--- 带水印（万能班长） ---');
for (const [theme, w1] of THEMES) {
    await setTheme(theme);
    await sleep(60);
    const s = await readState();
    ok(`w1 ${theme.padEnd(12)} 标题=${w1} / 下拉不变 / 提示不误报 / 配色不变`,
        s.title === w1 && s.selectValue === theme && s.dataTheme === theme && s.activeWatermark === 'w1'
            && s.hint === `海报显示：${w1}`,
        JSON.stringify(s));
}

// ---------- 2) 切无水印：4 条规则生效，其余保持原词 ----------
console.log('\n--- 无水印 ---');
await setWatermark('none');
await sleep(250);
for (const [theme, w1, none] of THEMES) {
    await setTheme(theme);
    await sleep(60);
    const s = await readState();
    const expectedHint = none === w1
        ? `海报显示：${w1}`
        : `无水印版显示：${none}（原：${w1}）`;
    ok(`none ${theme.padEnd(12)} ${w1} → ${none} / 下拉不变 / 配色不变 / 提示正确`,
        s.title === none && s.selectValue === theme && s.dataTheme === theme && s.brand === 'off'
            && s.activeWatermark === 'none' && s.hint === expectedHint,
        JSON.stringify(s));
}

// ---------- 3) 切回带水印：4 条规则全部恢复原词 ----------
console.log('\n--- 切回带水印 ---');
await setWatermark('w1');
await sleep(250);
for (const [theme, w1, none] of THEMES.filter(([, a, b]) => a !== b)) {
    await setTheme(theme);
    await sleep(60);
    const s = await readState();
    ok(`恢复 ${theme.padEnd(12)} ${none} → ${w1}`, s.title === w1 && s.hint === `海报显示：${w1}`, JSON.stringify(s));
}

// ---------- 4) 导出：画布实际绘制的文字 + 下载文件名 ----------
console.log('\n--- 导出 PNG ---');
await setTheme('hours');   // 课时卡 → 讲课卡
await sleep(100);
await ev(`(() => {
    window.__drawnTexts = [];
    window.__downloads = [];
    window.__pngCount = 0;
    const origFill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t) {
        window.__drawnTexts.push(String(t));
        return origFill.apply(this, arguments);
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__downloads.push(this.download);
        return origClick.call(this);
    };
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
        if (blob && blob.type === 'image/png') window.__pngCount += 1;
        return origCreate(blob);
    };
    // 导出后页面会自动请求 AI 文案，这里让它快速失败：不消耗额度、也不让验证挂等
    const origFetch = window.fetch;
    window.fetch = function (url) {
        if (String(url).includes('/api/ai/poster-caption')) {
            return Promise.resolve(new Response(JSON.stringify({ error: 'blocked-by-test' }), {
                status: 502, headers: { 'Content-Type': 'application/json' }
            }));
        }
        return origFetch.apply(this, arguments);
    };
    return 'hooked';
})()`);

await ev(`document.getElementById('exportBothButton').click(); 'clicked'`);
await waitFor('window.__downloads', v => Array.isArray(v) && v.length >= 2);
const drawn = await ev('window.__drawnTexts');
const downloads = await ev('window.__downloads');
const pngCount = await ev('window.__pngCount');
ok('双版本导出生成 2 张 PNG', pngCount >= 2, `pngCount=${pngCount}`);
ok('带水印版画布实际绘制「课时卡」', drawn.includes('课时卡'), `drawn=${JSON.stringify(drawn.slice(0, 12))}`);
ok('无水印版画布实际绘制「讲课卡」', drawn.includes('讲课卡'));
ok('带水印版文件名含「课时卡」', downloads.some(n => n.includes('课时卡') && n.includes('带水印')), JSON.stringify(downloads));
ok('无水印版文件名含「讲课卡」', downloads.some(n => n.includes('讲课卡') && n.includes('无水印')), JSON.stringify(downloads));

// 单张导出：当前水印为 w1 → 文件名用原词
await sleep(1500);   // 等导出后自动文案流程收尾，别和下一次导出抢按钮
const preSingle = await ev(`(() => ({
    disabled: document.getElementById('exportButton').disabled,
    status: document.getElementById('exportStatus').textContent,
    downloads: window.__downloads.length
}))()`);
console.log('  单张导出前状态：', JSON.stringify(preSingle));
await ev('window.__downloads = []; 1');
await ev(`document.getElementById('exportButton').click(); 'clicked'`);
await waitFor('window.__downloads', v => Array.isArray(v) && v.length >= 1, 20000);
const singleW1 = await ev('window.__downloads');
ok('单张导出（w1）文件名用原词「课时卡」', singleW1.some(n => n.includes('课时卡') && !n.includes('讲课卡')), JSON.stringify(singleW1));

// 切到无水印后单张导出 → 文件名用替换词
await setWatermark('none');
await sleep(200);
await ev('window.__downloads = []; 1');
await ev(`document.getElementById('exportButton').click(); 'clicked'`);
await waitFor('window.__downloads', v => Array.isArray(v) && v.length >= 1, 20000);
const singleNone = await ev('window.__downloads');
ok('单张导出（无水印）文件名用「讲课卡」', singleNone.some(n => n.includes('讲课卡')), JSON.stringify(singleNone));
ok('单张导出（无水印）画布绘制「讲课卡」', (await ev('window.__drawnTexts')).includes('讲课卡'));

// ---------- 5) 运行时异常 ----------
console.log('\n--- 稳定性 ---');
ok('无 JS 运行时异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

await send('Target.closeTarget', { targetId: created.targetId });
ws.close();
console.log(`\n结果：${failures ? `FAIL ${failures} 项` : '全部通过'}`);
process.exit(failures ? 1 : 0);
