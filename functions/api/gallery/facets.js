/**
 * GET /api/gallery/facets
 * 返回筛选栏要用的候选项（产品类型 / 素材类型 / 老师 / 学校 / 专业 / 国家地区）。
 * 聚合要扫全表，所以结果缓存 60 秒，避免每次打开页面都烧 D1 行读额度。
 *
 * 注意：不能把 6 个 GROUP BY 拼成一条 UNION ALL —— D1 对 compound SELECT 的项数
 * 有上限（会报 too many terms in compound SELECT），必须拆成多条独立查询，
 * 用 batch() 一次发过去（只算一次请求，且 D1 内部串行执行）。
 */
import { DB_BINDING, BUCKET_BINDING, D1_CAPACITY_BYTES, ensureSchema, json, fail } from './_shared.js';

const KIND_COLUMNS = [
    ['product', 'product_type'],
    ['material', 'material_type'],
    ['teacher', 'teacher'],
    ['school', 'school'],
    ['major', 'major'],
    ['country', 'country']
];

// 单个维度的候选值上限，避免老师/学校太多把下拉撑爆
const MAX_OPTIONS = 100;

export async function onRequestGet(context) {
    const { env } = context;

    try {
        if (!env[DB_BINDING]) return fail('图库数据库尚未绑定。', 503);
        await ensureSchema(env);

        const statements = KIND_COLUMNS.map(([, column]) => env[DB_BINDING].prepare(
            `SELECT ${column} AS value, COUNT(*) AS c FROM gallery WHERE ${column} <> '' GROUP BY ${column}`
        ));
        statements.push(env[DB_BINDING].prepare("SELECT COUNT(*) AS c FROM gallery WHERE status = 'public'"));
        statements.push(env[DB_BINDING].prepare('SELECT SUM(bytes) AS used FROM gallery'));

        const results = await env[DB_BINDING].batch(statements);

        const payload = {
            ok: true,
            total: results[KIND_COLUMNS.length]?.results?.[0]?.c || 0,
            usedBytes: results[KIND_COLUMNS.length + 1]?.results?.[0]?.used || 0,
            // 存 D1 时单库上限 500MB；绑了 R2 就不受这个限制
            capacityBytes: env[BUCKET_BINDING] ? null : D1_CAPACITY_BYTES
        };

        KIND_COLUMNS.forEach(([kind], index) => {
            const rows = results[index]?.results || [];
            payload[kind] = rows
                .sort((a, b) => b.c - a.c)
                .slice(0, MAX_OPTIONS)
                .map(row => ({ value: row.value, count: row.c }));
        });

        return json(payload, 200, {
            // 聚合要扫全表，缓存短一点：新老师/新学校一分钟内能出现
            'Cache-Control': 'public, max-age=0, s-maxage=60'
        });
    } catch (error) {
        console.error('[gallery facets]', error);
        return fail(`读取筛选项失败：${error?.message || '请稍后重试'}`, 500);
    }
}
