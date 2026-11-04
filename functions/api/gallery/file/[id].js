/**
 * GET /api/gallery/file/:id
 *   ?download=1 以附件形式下载（浏览器直接存成文件）
 *
 * 图片内容长期不变，回应带 immutable 缓存，回访不再消耗 D1 行读。
 */
import { BUCKET_BINDING, DB_BINDING, ensureSchema, fail } from '../_shared.js';

const ID_RE = /^[0-9a-fA-F-]{16,40}$/;

function safeBaseName(row) {
    const raw = [row.product_type, row.course_name || row.course_code]
        .filter(Boolean)
        .join('_')
        .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return raw || '万能班长成品图';
}

export async function onRequestGet(context) {
    const { params, env, request } = context;
    const id = String(params.id || '');

    try {
        if (!ID_RE.test(id)) return fail('图片编号不合法。', 400);
        if (!env[DB_BINDING]) return fail('图库数据库尚未绑定。', 503);
        await ensureSchema(env);

        const row = await env[DB_BINDING]
            .prepare(`SELECT mime, object_key, data, width, height, product_type, course_name, course_code, created_at
                      FROM gallery WHERE id = ?1 AND status = 'public'`)
            .bind(id)
            .first();

        if (!row) return fail('这张图不存在或已被移除。', 404);

        const etag = `"${id}"`;
        if (request.headers.get('if-none-match') === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag } });
        }

        let body = null;
        let mime = row.mime || 'image/webp';

        const bucket = env[BUCKET_BINDING];
        if (bucket && row.object_key) {
            const object = await bucket.get(row.object_key);
            if (!object) return fail('图片文件已丢失。', 404);
            body = object.body;
            mime = object.httpMetadata?.contentType || mime;
        } else if (row.data) {
            body = row.data;
        }

        if (!body) return fail('图片文件已丢失。', 404);

        const headers = {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=31536000, immutable',
            ETag: etag,
            'X-Content-Type-Options': 'nosniff'
        };

        if (new URL(request.url).searchParams.get('download') === '1') {
            const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
            const filename = `${safeBaseName(row)}.${ext}`;
            headers['Content-Disposition'] =
                `attachment; filename="poster.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
        }

        return new Response(body, { status: 200, headers });
    } catch (error) {
        console.error('[gallery file]', error);
        return fail(`读取图片失败：${error?.message || '请稍后重试'}`, 500);
    }
}
