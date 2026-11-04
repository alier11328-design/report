/**
 * GET /api/gallery/facets
 * 返回筛选栏要用的候选项（产品类型 / 素材类型 / 老师 / 学校 / 专业 / 国家地区）。
 * 聚合要扫全表，所以结果缓存 5 分钟，避免每次打开页面都烧 D1 行读额度。
 */
import { DB_BINDING, BUCKET_BINDING, D1_CAPACITY_BYTES, ensureSchema, json, fail } from './_shared.js';

const GROUPED_SQL = `
    SELECT 'product' AS kind, product_type AS value, COUNT(*) AS c FROM gallery WHERE product_type <> '' GROUP BY product_type
    UNION ALL
    SELECT 'material', material_type, COUNT(*) FROM gallery WHERE material_type <> '' GROUP BY material_type
    UNION ALL
    SELECT 'teacher', teacher, COUNT(*) FROM gallery WHERE teacher <> '' GROUP BY teacher
    UNION ALL
    SELECT 'school', school, COUNT(*) FROM gallery WHERE school <> '' GROUP BY school
    UNION ALL
    SELECT 'major', major, COUNT(*) FROM gallery WHERE major <> '' GROUP BY major
    UNION ALL
    SELECT 'country', country, COUNT(*) FROM gallery WHERE country <> '' GROUP BY country
    ORDER BY c DESC
    LIMIT 400
`;

export async function onRequestGet(context) {
    const { env } = context;

    try {
        if (!env[DB_BINDING]) return fail('图库数据库尚未绑定。', 503);
        await ensureSchema(env);

        const [{ results }, totalRow, usedRow] = await Promise.all([
            env[DB_BINDING].prepare(GROUPED_SQL).all(),
            env[DB_BINDING].prepare("SELECT COUNT(*) AS c FROM gallery WHERE status = 'public'").first(),
            env[DB_BINDING].prepare('SELECT SUM(bytes) AS used FROM gallery').first()
        ]);

        const buckets = { product: [], material: [], teacher: [], school: [], major: [], country: [] };
        for (const row of results || []) {
            if (buckets[row.kind]) buckets[row.kind].push({ value: row.value, count: row.c });
        }

        return json({
            ok: true,
            total: totalRow?.c || 0,
            usedBytes: usedRow?.used || 0,
            // 存 D1 时单库上限 500MB；绑了 R2 就不受这个限制
            capacityBytes: env[BUCKET_BINDING] ? null : D1_CAPACITY_BYTES,
            ...buckets
        }, 200, {
            // 聚合要扫全表，缓存短一点：新老师/新学校一分钟内能出现
            'Cache-Control': 'public, max-age=0, s-maxage=60'
        });
    } catch (error) {
        console.error('[gallery facets]', error);
        return fail(`读取筛选项失败：${error?.message || '请稍后重试'}`, 500);
    }
}
