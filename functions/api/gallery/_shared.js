/**
 * 成品图库公共工具
 *
 * 存储策略：优先 R2（env.GALLERY_BUCKET），没有绑定时退回 D1 的 data BLOB 列。
 * 两套存储对上层接口完全透明，绑定 R2 后无需改任何调用代码。
 */

export const BUCKET_BINDING = 'GALLERY_BUCKET';
export const DB_BINDING = 'DB';

// D1 免费版单库上限 500MB（账户总量 5GB，但单个库只有 500MB）。
// 存 R2 之后 capacityBytes 返回 null，前端不再显示容量条。
export const D1_CAPACITY_BYTES = 500 * 1024 * 1024;

// 单张上限。客户端输出的是 1500px 宽 WebP（约 300~600KB），留一点余量。
export const MAX_IMAGE_BYTES = 900 * 1024;
// 防滥用：同一 IP 每小时最多存这么多张
export const RATE_LIMIT_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export const ALLOWED_MIME = {
    'image/webp': 'webp',
    'image/png': 'png',
    'image/jpeg': 'jpg'
};

// 元数据字段白名单：列名 → 最大长度
export const META_FIELDS = {
    product_type: 40,
    material_type: 40,
    country: 40,
    school: 60,
    major: 60,
    course_code: 40,
    teacher: 60,
    course_name: 80
};

export const SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS gallery (
        id TEXT PRIMARY KEY,
        object_key TEXT,
        mime TEXT NOT NULL DEFAULT 'image/webp',
        bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        product_type TEXT,
        material_type TEXT,
        country TEXT,
        school TEXT,
        major TEXT,
        course_code TEXT,
        teacher TEXT,
        course_name TEXT,
        data BLOB,
        created_at INTEGER NOT NULL,
        ip_hash TEXT,
        status TEXT NOT NULL DEFAULT 'public'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_feed ON gallery(created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_product ON gallery(product_type)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_material ON gallery(material_type)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_teacher ON gallery(teacher)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_school ON gallery(school)`,
    `CREATE INDEX IF NOT EXISTS idx_gallery_ip ON gallery(ip_hash, created_at)`
];

// 每个 isolate 只建一次表；建表语句是幂等的，冷启动重复执行无害
let schemaReady = false;

export async function ensureSchema(env) {
    if (schemaReady || !env[DB_BINDING]) return;
    for (const sql of SCHEMA_SQL) {
        await env[DB_BINDING].prepare(sql).run();
    }
    schemaReady = true;
}

export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers
        }
    });
}

export function fail(message, status = 400, extra = {}) {
    return json({ ok: false, error: message, ...extra }, status);
}

// 去掉控制字符与首尾空白，按列长度截断；空串统一存成空字符串，方便 SQL 里用 <> '' 过滤
export function cleanMeta(input) {
    const out = {};
    for (const [key, max] of Object.entries(META_FIELDS)) {
        const raw = input && typeof input === 'object' ? input[key] : '';
        out[key] = String(raw == null ? '' : raw)
            .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max);
    }
    return out;
}

export async function hashIp(request) {
    const ip = request.headers.get('CF-Connecting-IP')
        || request.headers.get('x-forwarded-for')
        || 'unknown';
    const data = new TextEncoder().encode(ip);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
        .slice(0, 8)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

// 只认真实的图片文件头，避免把任意文件当图片塞进库
export function sniffImageMime(bytes) {
    if (!bytes || bytes.length < 12) return '';
    const b = bytes;
    // RIFF....WEBP
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return 'image/webp';
    }
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    return '';
}

export function publicUrl(id, download = false) {
    return `/api/gallery/file/${id}${download ? '?download=1' : ''}`;
}

export function toItem(row) {
    return {
        id: row.id,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        productType: row.product_type || '',
        materialType: row.material_type || '',
        country: row.country || '',
        school: row.school || '',
        major: row.major || '',
        courseCode: row.course_code || '',
        teacher: row.teacher || '',
        courseName: row.course_name || '',
        createdAt: row.created_at,
        url: publicUrl(row.id),
        downloadUrl: publicUrl(row.id, true)
    };
}
