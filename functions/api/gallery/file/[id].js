/**
 * GET /api/gallery/file/:id
 *   ?download=1 以附件形式下载（浏览器直接存成文件）
 *
 * 图片内容长期不变，回应带 immutable 缓存，回访不再消耗 D1 行读。
 */
import { BUCKET_BINDING, DB_BINDING, ensureSchema, fail, hashIp, json } from '../_shared.js';

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

        // 图片内容永不改变，命中边缘缓存就直接返回，不再回源查 D1。
        // 国内访问 Cloudflare 边缘本身不稳定，少一次回源就少一次抖动。
        const cache = typeof caches !== 'undefined' ? caches.default : null;
        const cacheKey = new Request(request.url, { method: 'GET' });
        if (cache) {
            const hit = await cache.match(cacheKey);
            if (hit) return hit;
        }

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

        const response = new Response(body, { status: 200, headers });
        if (cache) {
            try {
                context.waitUntil(cache.put(cacheKey, response.clone()));
            } catch (error) {
                console.warn('[gallery file] 写边缘缓存失败', id, error?.message);
            }
        }
        return response;
    } catch (error) {
        console.error('[gallery file]', error);
        return fail(`读取图片失败：${error?.message || '请稍后重试'}`, 500);
    }
}

/**
 * DELETE /api/gallery/file/:id
 * 删除权限：上传时的来源 IP，或持有环境变量 GALLERY_ADMIN_KEY 对应的口令
 *（请求头 X-Gallery-Key）。公开图库不设账号体系，这样既能自己删，也不会被随便清空。
 */
export async function onRequestDelete(context) {
    const { params, env, request } = context;
    const id = String(params.id || '');

    try {
        if (!ID_RE.test(id)) return fail('图片编号不合法。', 400);
        if (!env[DB_BINDING]) return fail('图库数据库尚未绑定。', 503);

        const row = await env[DB_BINDING]
            .prepare('SELECT ip_hash, object_key FROM gallery WHERE id = ?1')
            .bind(id)
            .first();
        if (!row) return fail('这张图不存在，可能已经删掉了。', 404);

        const adminKey = env.GALLERY_ADMIN_KEY;
        const providedKey = request.headers.get('x-gallery-key');
        const fromSameIp = row.ip_hash === await hashIp(request);
        const allowed = fromSameIp || Boolean(adminKey && providedKey && providedKey === adminKey);
        if (!allowed) {
            return fail('只能删除自己上传的图片。', 403);
        }

        await env[DB_BINDING].prepare('DELETE FROM gallery WHERE id = ?1').bind(id).run();

        const bucket = env[BUCKET_BINDING];
        if (bucket && row.object_key) {
            try { await bucket.delete(row.object_key); } catch (error) {
                console.warn('[gallery delete] R2 删除失败', id, error?.message);
            }
        }

        // 顺便清掉边缘缓存，避免删完还能按原链接看到图
        if (typeof caches !== 'undefined') {
            const origin = new URL(request.url).origin;
            for (const suffix of ['', '?download=1']) {
                try {
                    await caches.default.delete(new Request(`${origin}/api/gallery/file/${id}${suffix}`, { method: 'GET' }));
                } catch {}
            }
        }

        return json({ ok: true, id });
    } catch (error) {
        console.error('[gallery delete]', error);
        return fail(`删除失败：${error?.message || '请稍后重试'}`, 500);
    }
}
