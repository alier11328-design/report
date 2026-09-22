/**
 * Cloudflare Pages 线上部署验证
 *
 * 用法：
 *   node scripts/verify_live_deploy.mjs
 *   node scripts/verify_live_deploy.mjs https://your-project.pages.dev
 *
 * 做四层验证（不只看构建绿灯）：
 *   1. API 端点存活 —— 用 OPTIONS 预检，能区分「函数不存在」与「函数在但方法不符」
 *   2. 页面可访问 —— 带随机参数，避开 Pages 对不存在路径兜底返回 index.html 的「假 200」
 *   3. 关键内容核验 —— 接口真的在执行业务逻辑（返回业务错误而非 HTML 兜底）
 *   4. 主题令牌核验 —— 确认前端拿到的 CSS 是最新版
 */

const BASE = (process.argv[2] || 'https://classbroreport.pages.dev').replace(/\/$/, '');
const rand = () => '?v=' + Math.random().toString(36).slice(2);

const API_ENDPOINTS = [
    '/api/health',
    '/api/ai/course-plan',
    '/api/ai/course-plan-new',
    '/api/ai/study-plan/guide',
    '/api/ai/study-plan/plan',
    '/api/ai/final-report',
    '/api/ai/period-feedback/schedule',
    '/api/ai/period-feedback/feedback',
    '/api/ai/review-report/reason',
    '/api/ai/review-report/process',
    '/api/ai/essay-review',
    '/api/ai/poster-caption',
    '/api/parse-file'
];

const PAGES = [
    ['/', '首页', /<title>万能班长 · 智能报告工坊<\/title>/],
    ['/social-poster', '朋友圈海报', /<title>万能班长 · 朋友圈海报<\/title>/],
    ['/course-plan', '课程规划', /<html/i],
    ['/course-plan-new', '课程规划新版', /<html/i],
    ['/study-plan', '学习规划', /<html/i],
    ['/final-report', '结课报告', /<html/i],
    ['/period-feedback', '阶段反馈', /<html/i],
    ['/review-report', '售后复盘', /<html/i],
    ['/essay-review', '论文批改', /<html/i]
];

let pass = 0;
let fail = 0;
const problems = [];

function ok(msg) { pass++; console.log('  ✅ ' + msg); }
function bad(msg, detail) { fail++; problems.push(msg + (detail ? ' — ' + detail : '')); console.log('  ❌ ' + msg + (detail ? ' — ' + detail : '')); }

(async () => {
    console.log('目标：' + BASE + '\n');

    // ---------- 1. API 端点 ----------
    console.log('=== 1/4  API 端点存活（OPTIONS 预检）===');
    for (const ep of API_ENDPOINTS) {
        try {
            const r = await fetch(BASE + ep + rand(), { method: 'OPTIONS' });
            const allow = r.headers.get('access-control-allow-methods') || '';
            if (r.status !== 404 && allow) ok(`${ep}  HTTP ${r.status}`);
            else bad(ep, `HTTP ${r.status}，CORS=${allow || '无'}`);
        } catch (e) { bad(ep, e.message); }
    }

    // ---------- 2. 页面 ----------
    console.log('\n=== 2/4  页面可访问 ===');
    for (const [path, name, expect] of PAGES) {
        try {
            const r = await fetch(BASE + path + rand());
            const t = await r.text();
            const isHtml = /text\/html/.test(r.headers.get('content-type') || '') && /<html/i.test(t.slice(0, 2000));
            if (r.status === 200 && isHtml && expect.test(t)) ok(`${path}  ${name}  ${t.length}B`);
            else bad(`${path}  ${name}`, `HTTP ${r.status}，${isHtml ? '内容不符预期' : '非 HTML（可能是兜底页）'}`);
        } catch (e) { bad(path, e.message); }
    }

    // ---------- 3. 业务逻辑真在跑 ----------
    console.log('\n=== 3/4  接口真实执行（非兜底 HTML）===');
    try {
        const r = await fetch(BASE + '/api/health' + rand());
        const j = await r.json();
        if (j.ok === true && j.configured === true) ok(`/api/health  configured=true，模型 ${j.model}`);
        else bad('/api/health', JSON.stringify(j).slice(0, 120));
    } catch (e) { bad('/api/health', e.message); }

    try {
        // 缺参数应当返回业务级 400，而不是 HTML 200
        const r = await fetch(BASE + '/api/ai/poster-caption', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const ct = r.headers.get('content-type') || '';
        const j = await r.json().catch(() => null);
        if (r.status === 400 && j && j.error && !/text\/html/.test(ct)) ok(`/api/ai/poster-caption  参数校验生效 → 400 "${j.error}"`);
        else bad('/api/ai/poster-caption', `HTTP ${r.status}，${ct}`);
    } catch (e) { bad('/api/ai/poster-caption', e.message); }

    // ---------- 4. 主题令牌 ----------
    console.log('\n=== 4/4  前端资源版本 ===');
    try {
        const css = await (await fetch(BASE + '/tokens.css' + rand())).text();
        // 主题数 = :root 里的默认主题（course）+ 各 [data-theme="..."] 覆盖块
        const rootHasDefault = /:root\s*\{[^}]*--poster-primary:/.test(css) || /--poster-primary:\s*#[0-9a-fA-F]{6}/.test(css);
        const themes = [...css.matchAll(/\[data-theme="([a-z]+)"\]/g)].map(m => m[1]);
        const total = themes.length + (rootHasDefault ? 1 : 0);
        if (total >= 11) ok(`tokens.css 共 ${total} 个主题（:root 默认 + ${themes.length} 个覆盖块）：${themes.join(', ')}`);
        else bad('tokens.css 主题数不足', `只有 ${total} 个：${themes.join(', ')}`);

        // 只校验 --poster-* 主题令牌：必须已换成 hex（基础 --color-* 令牌仍用 oklch，属正常）
        const posterOklch = [...css.matchAll(/--poster-[a-z-]+:\s*oklch\([^)]*\)/g)].map(m => m[0]);
        const posterHex = [...css.matchAll(/--poster-primary:\s*(#[0-9a-fA-F]{6})/g)].map(m => m[1]);
        if (!posterOklch.length && posterHex.length >= 11) ok(`--poster-* 已全部为 hex 精确值（${posterHex.length} 处，如 ${posterHex.slice(0, 3).join(' / ')}）`);
        else bad('--poster-* 主题令牌未更新', posterOklch.length ? `仍有 oklch：${posterOklch.slice(0, 3).join(', ')}` : `hex 值只有 ${posterHex.length} 处`);
    } catch (e) { bad('/tokens.css', e.message); }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(56));
    console.log(`结果：${pass} 项通过，${fail} 项失败`);
    if (fail) {
        console.log('需处理：');
        for (const p of problems) console.log('  - ' + p);
        process.exit(1);
    }
    console.log('线上部署验证全部通过 ✅');
})();
