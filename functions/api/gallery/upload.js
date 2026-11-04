/**
 * POST /api/gallery/upload
 *
 * multipart/form-data：
 *   file  图片文件（前端已压成 1500px 宽 WebP）
 *   meta  JSON 字符串，含产品类型 / 素材类型 / 课程信息等字段
 *
 * 返回 { ok, item }
 */
import {
    MAX_IMAGE_BYTES,
    RATE_LIMIT_PER_HOUR,
    RATE_WINDOW_MS,
    D1_CAPACITY_BYTES,
    ALLOWED_MIME,
    BUCKET_BINDING,
    DB_BINDING,
    ensureSchema,
    json,
    fail,
    cleanMeta,
    hashIp,
    sniffImageMime,
    toItem
} from './_shared.js';

const MIN_SIDE = 200;
const MAX_SIDE = 4000;

// 容量提示用：不到 1MB 时显示 KB，比「已用 0MB / 500MB」直观
function formatSize(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        if (!env[DB_BINDING]) {
            return fail('图库数据库尚未绑定，请先在 Pages 项目里配置 D1 绑定。', 503);
        }
        await ensureSchema(env);

        let form;
        try {
            form = await request.formData();
        } catch {
            return fail('上传格式不正确，请用表单方式提交图片。', 400);
        }

        const file = form.get('file');
        if (!file || typeof file === 'string') {
            return fail('没有收到图片文件。', 400);
        }
        if (file.size === 0) {
            return fail('图片是空的，请重新生成。', 400);
        }
        if (file.size > MAX_IMAGE_BYTES) {
            return fail(`图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB，请压缩后再存。`, 413);
        }

        const buffer = await file.arrayBuffer();
        // 只看文件头，不信任客户端声明的 Content-Type
        const mime = sniffImageMime(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 32)));
        if (!mime || !ALLOWED_MIME[mime]) {
            return fail('只接受 WebP / PNG / JPEG 图片。', 415);
        }

        let metaRaw = {};
        try {
            metaRaw = JSON.parse(String(form.get('meta') || '{}'));
        } catch {
            metaRaw = {};
        }
        const meta = cleanMeta(metaRaw);

        const width = Math.round(Number(metaRaw.width) || 0);
        const height = Math.round(Number(metaRaw.height) || 0);
        if (width < MIN_SIDE || width > MAX_SIDE || height < MIN_SIDE || height > MAX_SIDE) {
            return fail('图片尺寸不在合理范围内。', 400);
        }

        // 同 IP 小时级限流
        const ipHash = await hashIp(request);
        const since = Date.now() - RATE_WINDOW_MS;
        const recent = await env[DB_BINDING]
            .prepare('SELECT COUNT(*) AS c FROM gallery WHERE ip_hash = ?1 AND created_at > ?2')
            .bind(ipHash, since)
            .first();
        if ((recent?.c || 0) >= RATE_LIMIT_PER_HOUR) {
            return fail(`一小时内最多存 ${RATE_LIMIT_PER_HOUR} 张，请稍后再试。`, 429);
        }

        // 存 D1 时先看剩余空间。写满之后 INSERT 只会抛一句英文的 SQLITE_FULL，
        // 前端只会显示「保存失败」，所以这里提前拦下来给人话。
        if (!env[BUCKET_BINDING]) {
            const usedRow = await env[DB_BINDING]
                .prepare('SELECT COALESCE(SUM(bytes), 0) AS used FROM gallery')
                .first();
            const used = Number(usedRow?.used) || 0;
            const room = D1_CAPACITY_BYTES - used;
            if (room < file.size) {
                return fail(
                    `图库空间不足：已用 ${formatSize(used)} / ${formatSize(D1_CAPACITY_BYTES)}，` +
                    `剩余 ${formatSize(Math.max(0, room))}，放不下这张 ${formatSize(file.size)} 的图。` +
                    '请到图库里删掉一些旧图，或开通 R2 对象存储扩容。',
                    507
                );
            }
        }

        const id = crypto.randomUUID();
        const ext = ALLOWED_MIME[mime];
        const objectKey = `gallery/${id}.${ext}`;
        const bucket = env[BUCKET_BINDING];
        let storedKey = '';

        if (bucket) {
            await bucket.put(objectKey, buffer, {
                httpMetadata: { contentType: mime },
                customMetadata: { id }
            });
            storedKey = objectKey;
        }

        // 没有 R2 绑定就把二进制直接存进 D1 的 data 列。
        // 注意必须传 Uint8Array：直接把 ArrayBuffer 交给 D1 绑定会被吞成空 BLOB，
        // 表现为「存成功了但下载是 0 字节」。
        const payload = storedKey ? null : new Uint8Array(buffer);
        await env[DB_BINDING]
            .prepare(`INSERT INTO gallery
                (id, object_key, mime, bytes, width, height,
                 product_type, material_type, country, school, major, course_code, teacher, course_name,
                 data, created_at, ip_hash, status)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 'public')`)
            .bind(
                id,
                storedKey,
                mime,
                buffer.byteLength,
                width,
                height,
                meta.product_type,
                meta.material_type,
                meta.country,
                meta.school,
                meta.major,
                meta.course_code,
                meta.teacher,
                meta.course_name,
                payload,
                Date.now(),
                ipHash
            )
            .run();

        // 写完立刻读回长度自查：宁可当场报错，也不要留下一张打不开的坏图
        if (payload) {
            const check = await env[DB_BINDING]
                .prepare('SELECT length(data) AS len FROM gallery WHERE id = ?1')
                .bind(id)
                .first();
            if (!check || Number(check.len) !== buffer.byteLength) {
                await env[DB_BINDING].prepare('DELETE FROM gallery WHERE id = ?1').bind(id).run();
                console.error('[gallery upload] 写入自检失败', { id, expected: buffer.byteLength, actual: check?.len });
                return fail('图片写入数据库后校验失败，请重试一次。', 500);
            }
        }

        const item = toItem({
            id,
            width,
            height,
            bytes: buffer.byteLength,
            product_type: meta.product_type,
            material_type: meta.material_type,
            country: meta.country,
            school: meta.school,
            major: meta.major,
            course_code: meta.course_code,
            teacher: meta.teacher,
            course_name: meta.course_name,
            created_at: Date.now()
        });

        return json({ ok: true, item, remaining: RATE_LIMIT_PER_HOUR - (recent?.c || 0) - 1 }, 201);
    } catch (error) {
        console.error('[gallery upload]', error);
        // 并发写入时仍可能撞上 D1 满库，这句英文原文对使用者没有意义
        const message = String(error?.message || '');
        if (/SQLITE_FULL|database or disk is full|database is full/i.test(message)) {
            return fail('图库空间已满，请到图库里删掉一些旧图，或开通 R2 对象存储扩容。', 507);
        }
        return fail(`保存失败：${message || '请稍后重试'}`, 500);
    }
}

// 兜底：用 GET 打上传接口时给一句人话，而不是 405 空响应
export async function onRequestGet() {
    return fail('上传请用 POST 方法。', 405);
}
