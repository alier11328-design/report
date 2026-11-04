/**
 * GET /api/gallery/list
 *
 * 查询参数（都可选）：
 *   product  产品类型（精确）
 *   material 素材类型（精确）
 *   country / school / major / code / teacher / course  模糊匹配
 *   cursor   上一页返回的 nextCursor
 *   limit    每页数量，默认 24，上限 60
 */
import { DB_BINDING, ensureSchema, json, fail, toItem } from './_shared.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

function decodeCursor(cursor) {
    const match = /^(\d+)_([0-9a-fA-F-]{8,40})$/.exec(cursor || '');
    if (!match) return null;
    return { createdAt: Number(match[1]), id: match[2] };
}

export async function onRequestGet(context) {
    const { request, env } = context;

    try {
        if (!env[DB_BINDING]) return fail('图库数据库尚未绑定。', 503);
        await ensureSchema(env);

        const url = new URL(request.url);
        const q = url.searchParams;
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.get('limit')) || DEFAULT_LIMIT));

        const clauses = ["status = 'public'"];
        const params = [];
        const push = (sql, value) => {
            params.push(value);
            clauses.push(sql.replace('?', `?${params.length}`));
        };

        // 产品类型 / 素材类型是枚举，走精确匹配（能吃到索引）
        const product = (q.get('product') || '').trim();
        const material = (q.get('material') || '').trim();
        if (product) push('product_type = ?', product);
        if (material) push('material_type = ?', material);

        // 文本字段走模糊匹配；空值列不参与命中（NULL 与 '' 都不会 LIKE 出结果）
        const fuzzy = [
            ['country', q.get('country')],
            ['school', q.get('school')],
            ['major', q.get('major')],
            ['course_code', q.get('code')],
            ['teacher', q.get('teacher')],
            ['course_name', q.get('course')]
        ];
        for (const [column, value] of fuzzy) {
            const text = (value || '').trim();
            if (text) push(`${column} LIKE ?`, `%${text}%`);
        }

        // 游标分页：按 (created_at, id) 倒序定位，避免 offset 越翻越慢
        // 占位符编号由 params.length 推出，用三份参数保证编号与取值一一对应
        const cursor = decodeCursor(q.get('cursor'));
        if (cursor) {
            params.push(cursor.createdAt, cursor.createdAt, cursor.id);
            const n = params.length;
            clauses.push(`(created_at < ?${n - 2} OR (created_at = ?${n - 1} AND id < ?${n}))`);
        }

        const where = clauses.join(' AND ');
        const sql = `SELECT id, width, height, bytes, product_type, material_type, country, school,
                            major, course_code, teacher, course_name, created_at
                     FROM gallery
                     WHERE ${where}
                     ORDER BY created_at DESC, id DESC
                     LIMIT ?${params.length + 1}`;

        const stmt = env[DB_BINDING].prepare(sql);
        const { results } = await stmt.bind(...params, limit + 1).all();

        const rows = results || [];
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        return json({
            ok: true,
            items: page.map(toItem),
            hasMore,
            nextCursor: hasMore && last ? `${last.created_at}_${last.id}` : ''
        }, 200, {
            // 列表不做边缘缓存：刚存进去的图要能立刻刷出来。
            // 一次列表只读 limit+1 行，D1 免费额度（500 万行/天）完全够用。
            'Cache-Control': 'no-store'
        });
    } catch (error) {
        console.error('[gallery list]', error);
        return fail(`读取图库失败：${error?.message || '请稍后重试'}`, 500);
    }
}
