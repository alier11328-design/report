/**
 * Cloudflare Pages 部署状态查询
 *
 * 用法：
 *   node scripts/cf_deploy_status.mjs                  # 列出最近 6 条部署
 *   node scripts/cf_deploy_status.mjs <commit-sha>     # 等这个提交构建出结果
 *   node scripts/cf_deploy_status.mjs <sha> 15         # 最多等 15 分钟（默认 10）
 *
 * 为什么需要它：`git push` 只说明代码进了仓库，不代表 Pages 构建成功。
 * 必须用 `deployment_trigger.metadata.commit_hash` 对齐「这次构建对应哪个提交」——
 * 否则轮询时会读到上一次的旧部署，把还没开始的构建误判成「已经是 success 了」。
 *
 * 令牌：复用 wrangler 的 OAuth 凭证（含 refresh_token，会自动续期），
 * 不需要另外申请 API Token。
 *   Windows: %APPDATA%/xdg.config/.wrangler/config/default.toml
 *   其他   : ~/.wrangler/config/default.toml
 * 若报 9109 Invalid access token，先跑一次 `npx wrangler whoami` 刷新令牌再执行本脚本。
 *
 * 环境变量：
 *   CF_PAGES_PROJECT   项目名，默认 classbroreport
 *   CF_ACCOUNT_ID      账户 ID，默认调 API 自动获取
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT = process.env.CF_PAGES_PROJECT || 'classbroreport';
const API = 'https://api.cloudflare.com/client/v4';

const cfgCandidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
       path.join(os.homedir(), '.wrangler', 'config', 'default.toml')]
    : [path.join(os.homedir(), '.wrangler', 'config', 'default.toml')];

const cfgPath = cfgCandidates.find(p => p && fs.existsSync(p));
if (!cfgPath) {
    console.error('找不到 wrangler 凭证文件，先跑一次 `npx wrangler login`。');
    process.exit(1);
}
const cfg = fs.readFileSync(cfgPath, 'utf8');
const token = (cfg.match(/oauth_token\s*=\s*"([^"]+)"/) || [])[1];
if (!token) {
    console.error('凭证文件里没有 oauth_token，先跑一次 `npx wrangler login`。');
    process.exit(1);
}

const get = async url => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json();
    if (!j.success) {
        const err = (j.errors || [])[0] || {};
        if (err.code === 9109) {
            console.error('令牌已过期：先跑一次 `npx wrangler whoami` 刷新，再重试本脚本。');
        } else {
            console.error(`API 失败：${err.code || r.status} ${err.message || ''}`);
        }
        process.exit(1);
    }
    return j.result;
};

let accountId = process.env.CF_ACCOUNT_ID;
if (!accountId) {
    const accounts = await get(`${API}/accounts`);
    if (!accounts.length) {
        console.error('该令牌下没有账户。');
        process.exit(1);
    }
    accountId = accounts[0].id;
}

const shaArg = (process.argv[2] || '').trim();
const maxMinutes = Number(process.argv[3] || 10);

const listDeployments = () => get(`${API}/accounts/${accountId}/pages/projects/${PROJECT}/deployments?per_page=10`);

const stamp = iso => {
    if (!iso) return '-';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const show = rows => {
    console.log(`项目 ${PROJECT}（账户 ${accountId}）最近 ${rows.length} 条部署：\n`);
    for (const d of rows) {
        const meta = d.deployment_trigger?.metadata || {};
        console.log([
            `  ${(d.latest_stage?.status || '?').padEnd(9)}`,
            `构建 ${(d.latest_stage?.name || '?').padEnd(14)}`,
            `${stamp(d.created_on)}`,
            `${(meta.commit_hash || '').slice(0, 7).padEnd(8)}`,
            `${(meta.commit_message || '').split('\n')[0].slice(0, 46)}`
        ].join(' '));
    }
    console.log('');
};

if (!shaArg) {
    show(await listDeployments());
    console.log('提示：带上 commit sha 再跑一次，可等到该提交构建出结果。');
    process.exit(0);
}

console.log(`等待提交 ${shaArg.slice(0, 7)} 的构建结果（最多 ${maxMinutes} 分钟）…\n`);
const deadline = Date.now() + maxMinutes * 60 * 1000;
let last = '';
let deployment = null;

while (Date.now() < deadline) {
    const rows = await listDeployments();
    deployment = rows.find(d => d.deployment_trigger?.metadata?.commit_hash === shaArg);
    if (!deployment) {
        if (last !== 'pending') { console.log('  构建还没出现在列表里（Pages 通常几秒内开始）…'); last = 'pending'; }
    } else {
        const status = deployment.latest_stage?.status || '?';
        const name = deployment.latest_stage?.name || '?';
        const line = `${status}/${name}`;
        if (line !== last) { console.log(`  当前阶段：${name} → ${status}`); last = line; }
        if (status === 'success' || status === 'failure' || status === 'canceled') break;
    }
    await new Promise(r => setTimeout(r, 10000));
}

if (!deployment) {
    console.error(`\n超时：列表里始终没有 ${shaArg.slice(0, 7)} 的构建，请到控制台确认 Git 集成是否触发。`);
    process.exit(2);
}

const status = deployment.latest_stage?.status;
console.log('');
show([deployment]);
console.log(`提交信息：${(deployment.deployment_trigger?.metadata?.commit_message || '').split('\n')[0]}`);
console.log(`部署地址：${deployment.url}`);
console.log(`生产地址：https://${PROJECT}.pages.dev`);

if (status === 'success') {
    console.log('\n构建成功 ✅');
} else {
    console.error(`\n构建未成功（${status}）❌`);
    process.exit(3);
}
