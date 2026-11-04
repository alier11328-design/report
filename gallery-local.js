/**
 * 本地开发用的成品图库实现
 *
 * 线上跑的是 functions/api/gallery/*（Cloudflare D1 + 可选 R2）。
 * 本地没有 D1，这里用「索引 JSON + 图片文件」模拟等价行为，
 * 接口路径、参数、返回结构、错误码都保持一致，方便本地完整调试。
 *
 * 数据落在 .gallery-data/，已在 .gitignore 中忽略。
 */
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import crypto from 'node:crypto';

const MAX_IMAGE_BYTES = 900 * 1024;
const RATE_LIMIT_PER_HOUR = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_SIDE = 4000;
const MIN_SIDE = 200;

const META_FIELDS = {
    product_type: 40,
    material_type: 40,
    country: 40,
    school: 60,
    major: 60,
    course_code: 40,
    teacher: 60,
    course_name: 80
};

function cleanMeta(input) {
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

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return '';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
        && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    return '';
}

const EXT = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

export function registerGalleryRoutes(app, rootDir) {
    const DATA_DIR = path.join(rootDir, '.gallery-data');
    const IMAGE_DIR = path.join(DATA_DIR, 'images');
    const INDEX_FILE = path.join(DATA_DIR, 'index.json');
    fs.mkdirSync(IMAGE_DIR, { recursive: true });

    let cache = null;
    let cacheMtime = 0;
    const load = () => {
        // 跟着文件修改时间走：手工改过 index.json 也会立即生效，不用重启服务
        let mtime = 0;
        try { mtime = fs.statSync(INDEX_FILE).mtimeMs; } catch { mtime = 0; }
        if (cache && mtime === cacheMtime) return cache;
        try {
            cache = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
            if (!Array.isArray(cache)) cache = [];
        } catch {
            cache = [];
        }
        cacheMtime = mtime;
        return cache;
    };
    const persist = () => {
        const tmp = `${INDEX_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(load(), null, 0));
        fs.renameSync(tmp, INDEX_FILE);
    };

    const galleryUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: MAX_IMAGE_BYTES, files: 1 }
    });

    const item = row => ({
        id: row.id,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
        productType: row.product_type,
        materialType: row.material_type,
        country: row.country,
        school: row.school,
        major: row.major,
        courseCode: row.course_code,
        teacher: row.teacher,
        courseName: row.course_name,
        createdAt: row.created_at,
        url: `/api/gallery/file/${row.id}`,
        downloadUrl: `/api/gallery/file/${row.id}?download=1`
    });

    app.post('/api/gallery/upload', galleryUpload.single('file'), (req, res) => {
        try {
            const file = req.file;
            if (!file) return res.status(400).json({ ok: false, error: '没有收到图片文件。' });
            if (file.size > MAX_IMAGE_BYTES) {
                return res.status(413).json({ ok: false, error: `图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024)}KB 上限。` });
            }
            const mime = sniffImageMime(file.buffer);
            if (!mime) return res.status(415).json({ ok: false, error: '只接受 WebP / PNG / JPEG 图片。' });

            let metaRaw = {};
            try { metaRaw = JSON.parse(String(req.body.meta || '{}')); } catch { metaRaw = {}; }
            const meta = cleanMeta(metaRaw);
            const width = Math.round(Number(metaRaw.width) || 0);
            const height = Math.round(Number(metaRaw.height) || 0);
            if (width < MIN_SIDE || width > MAX_SIDE || height < MIN_SIDE || height > MAX_SIDE) {
                return res.status(400).json({ ok: false, error: '图片尺寸不在合理范围内。' });
            }

            const rows = load();
            const since = Date.now() - RATE_WINDOW_MS;
            const ip = req.ip || 'local';
            const recent = rows.filter(r => r.ip === ip && r.created_at > since).length;
            if (recent >= RATE_LIMIT_PER_HOUR) {
                return res.status(429).json({ ok: false, error: `一小时内最多存 ${RATE_LIMIT_PER_HOUR} 张，请稍后再试。` });
            }

            const id = crypto.randomUUID();
            const ext = EXT[mime];
            fs.writeFileSync(path.join(IMAGE_DIR, `${id}.${ext}`), file.buffer);

            const row = {
                id,
                mime,
                ext,
                bytes: file.size,
                width,
                height,
                ...meta,
                created_at: Date.now(),
                ip
            };
            rows.push(row);
            persist();
            res.status(201).json({ ok: true, item: item(row), remaining: RATE_LIMIT_PER_HOUR - recent - 1 });
        } catch (error) {
            console.error('[local gallery upload]', error);
            res.status(500).json({ ok: false, error: `保存失败：${error.message}` });
        }
    });

    app.get('/api/gallery/list', (req, res) => {
        try {
            const q = req.query;
            const limit = Math.min(60, Math.max(1, Number(q.limit) || 24));
            let rows = load().slice().sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));

            const text = key => String(q[key] || '').trim();
            const product = text('product');
            const material = text('material');
            if (product) rows = rows.filter(r => r.product_type === product);
            if (material) rows = rows.filter(r => r.material_type === material);

            const fuzzy = ['country', 'school', 'major', 'teacher', 'course'];
            for (const key of fuzzy) {
                const text = String(q[key] || '').trim().toLowerCase();
                if (!text) continue;
                const column = key === 'course' ? 'course_name' : key;
                rows = rows.filter(r => String(r[column] || '').toLowerCase().includes(text));
            }
            const code = String(q.code || '').trim().toLowerCase();
            if (code) rows = rows.filter(r => String(r.course_code || '').toLowerCase().includes(code));

            let start = 0;
            const cursor = String(q.cursor || '');
            const match = /^(\d+)_(.+)$/.exec(cursor);
            if (match) {
                const createdAt = Number(match[1]);
                const id = match[2];
                const index = rows.findIndex(r => r.created_at === createdAt && r.id === id);
                start = index >= 0 ? index + 1 : 0;
            }

            const page = rows.slice(start, start + limit);
            const hasMore = rows.length > start + limit;
            const last = page[page.length - 1];
            res.json({
                ok: true,
                items: page.map(item),
                hasMore,
                nextCursor: hasMore && last ? `${last.created_at}_${last.id}` : ''
            });
        } catch (error) {
            console.error('[local gallery list]', error);
            res.status(500).json({ ok: false, error: `读取图库失败：${error.message}` });
        }
    });

    app.get('/api/gallery/facets', (_req, res) => {
        try {
            const rows = load();
            const bucket = key => {
                const map = new Map();
                for (const row of rows) {
                    const value = row[key];
                    if (!value) continue;
                    map.set(value, (map.get(value) || 0) + 1);
                }
                return [...map.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([value, count]) => ({ value, count }));
            };
            res.json({
                ok: true,
                total: rows.length,
                // 与线上 facet 返回保持一致：D1 单库上限 500MB
                usedBytes: rows.reduce((sum, r) => sum + (r.bytes || 0), 0),
                capacityBytes: 500 * 1024 * 1024,
                product: bucket('product_type'),
                material: bucket('material_type'),
                teacher: bucket('teacher').slice(0, 100),
                school: bucket('school').slice(0, 100),
                major: bucket('major').slice(0, 100),
                country: bucket('country')
            });
        } catch (error) {
            console.error('[local gallery facets]', error);
            res.status(500).json({ ok: false, error: `读取筛选项失败：${error.message}` });
        }
    });

    app.get('/api/gallery/file/:id', (req, res) => {
        try {
            const row = load().find(r => r.id === req.params.id);
            if (!row) return res.status(404).json({ ok: false, error: '这张图不存在或已被移除。' });
            const filePath = path.join(IMAGE_DIR, `${row.id}.${row.ext}`);
            if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: '图片文件已丢失。' });

            res.setHeader('Content-Type', row.mime);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('ETag', `"${row.id}"`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            if (req.query.download === '1') {
                const base = [row.product_type, row.course_name || row.course_code]
                    .filter(Boolean).join('_').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48) || '万能班长成品图';
                const filename = `${base}.${row.ext}`;
                res.setHeader('Content-Disposition',
                    `attachment; filename="poster.${row.ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
            }
            fs.createReadStream(filePath).pipe(res);
        } catch (error) {
            console.error('[local gallery file]', error);
            res.status(500).json({ ok: false, error: `读取图片失败：${error.message}` });
        }
    });
}
