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

// D1 的 BLOB 可能以 ArrayBuffer / Uint8Array / 数字数组返回，统一转成可放进 Response 的二进制；
// 长度 0 一律当缺失处理——空响应会让浏览器显示一张打不开的图，不如直接 404。
function toBinary(raw) {
    if (!raw) return null;
    if (raw instanceof ArrayBuffer) return raw.byteLength ? raw : null;
    if (ArrayBuffer.isView(raw)) return raw.byteLength ? raw : null;
    if (Array.isArray(raw)) return raw.length ? new Uint8Array(raw) : null;
    return null;
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
        } else {
            body = toBinary(row.data);
        }

        if (!body) {
            // 早期版本用 ArrayBuffer 绑定导致存进了空 BLOB，这类记录没有任何价值：
            // 读到就顺手删掉（只删确实没有二进制的那条），避免图库里一直挂着破图。
            if (!row.object_key) {
                try {
                    await env[DB_BINDING]
                        .prepare('DELETE FROM gallery WHERE id = ?1 AND (data IS NULL OR length(data) = 0)')
                        .bind(id)
                        .run();
                } catch (error) {
                    console.warn('[gallery file] 清理空图失败', id, error?.message);
                }
            }
            return fail('这张图的图片数据缺失，已自动清理，请重新存入。', 404);
        }

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
