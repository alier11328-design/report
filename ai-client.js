(function () {
    const TEXT_FILE_EXTENSIONS = ['.txt', '.md', '.json', '.csv'];
    const PARSEABLE_FILE_EXTENSIONS = ['.pdf'];

    // API base URL configuration
    // EdgeOne Pages: Set to empty string '' when deploying to EdgeOne Pages (same-origin)
    // Example: window.__API_BASE__ = 'https://your-project.edgeone.app';
    let apiBaseUrl = window.__API_BASE__ || '';

    function getApiUrl(path) {
        return apiBaseUrl + path;
    }

    function setApiBaseUrl(url) {
        apiBaseUrl = url || '';
    }

    function getExtension(filename) {
        const dotIndex = filename.lastIndexOf('.');
        return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
    }

    function isTextLikeFile(file) {
        const type = file.type || '';
        if (type.startsWith('text/')) return true;
        if (type === 'application/json') return true;
        return TEXT_FILE_EXTENSIONS.includes(getExtension(file.name || ''));
    }

    function isParseableFile(file) {
        const ext = getExtension(file.name || '');
        return PARSEABLE_FILE_EXTENSIONS.includes(ext) ||
            file.type === 'application/pdf';
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsDataURL(file);
        });
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result.split(',')[1] || '';
                resolve(base64);
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsDataURL(file);
        });
    }

    // 客户端 PDF 解析 - 使用 pdfjs-dist 浏览器版
// 从 CDN 加载（多 CDN 备用，避免单一 CDN 失败导致卡死）
let pdfjsLib = null;

// 备用 CDN 列表：main 为主库，worker 为解析所需的 worker 线程库
const PDFJS_CDN_SOURCES = [
    {
        main: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
        worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
    },
    {
        main: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
        worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    },
    {
        main: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
        worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
    }
];

// 从单个地址加载脚本：成功返回 true，失败返回 false（不抛错，交给上层决定是否换源）
function loadScriptOnce(src) {
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
}

async function loadPdfJs() {
    if (pdfjsLib) return pdfjsLib;
    if (typeof window['pdfjsLib'] !== 'undefined') {
        pdfjsLib = window['pdfjsLib'];
        return pdfjsLib;
    }
    // 依次尝试各 CDN，加载失败立即换下一个，避免无限等待
    for (const src of PDFJS_CDN_SOURCES) {
        const ok = await loadScriptOnce(src.main);
        if (ok && typeof window['pdfjsLib'] !== 'undefined') {
            pdfjsLib = window['pdfjsLib'];
            // 关键：必须指定 worker 地址，否则 getDocument 会报
            // “No GlobalWorkerOptions.workerSrc specified”
            pdfjsLib.GlobalWorkerOptions.workerSrc = src.worker;
            return pdfjsLib;
        }
    }
    throw new Error('PDF 解析库加载失败，请检查网络后重试');
}

async function parsePdfClientSide(file) {
    try {
        const pdfjsLib = await loadPdfJs();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
        }

        // 首页（封面）通常含校名校徽 logo，是图片而非文字层。
        // 把首页渲染成图片，让 AI 走视觉识别校名等文字层缺失的信息。
        const pageImages = [];
        try {
            const firstPage = await pdf.getPage(1);
            const viewport = firstPage.getViewport({ scale: 2 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');
            await firstPage.render({ canvasContext: ctx, viewport }).promise;
            pageImages.push(canvas.toDataURL('image/jpeg', 0.9));
        } catch (renderErr) {
            // 渲染失败不影响文字提取，仅记录日志
            console.warn('PDF 首页渲染失败:', renderErr);
        }

        return { text: fullText, pageImages };
    } catch (err) {
        throw new Error(`PDF 解析失败: ${err.message}`);
    }
}

async function parseFileOnServer(file) {
    const fileSizeBytes = file.size || 0;
    const maxSizeBytes = 10 * 1024 * 1024; // 10MB for client-side parsing
    if (fileSizeBytes > maxSizeBytes) {
        throw new Error(`文件过大（${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB），请压缩后重试`);
    }
    
    // PDF 文件在客户端解析
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        return await parsePdfClientSide(file);
    }
    
    // 其他文件类型返回错误
    throw new Error('仅支持 PDF 文件解析');
}

    async function prepareFiles(files, options = {}) {
        const maxImages = options.maxImages || 8;
        const maxTextFiles = options.maxTextFiles || 6;
        const imageFiles = [];
        const pdfImages = [];
        const textBlocks = [];
        const skipped = [];

        for (const file of Array.from(files || [])) {
            if ((file.type || '').startsWith('image/')) {
                if (imageFiles.length < maxImages) {
                    imageFiles.push(file);
                } else {
                    skipped.push(`${file.name}（超出图片数量上限）`);
                }
                continue;
            }

            if (isParseableFile(file)) {
                if (textBlocks.length < maxTextFiles) {
                    try {
                        const parsed = await parseFileOnServer(file);
                        const text = (parsed && parsed.text) || parsed || '';
                        if (text && text.trim()) {
                            textBlocks.push({
                                name: file.name,
                                content: text.slice(0, 12000)
                            });
                        } else {
                            skipped.push(`${file.name}（文件内容为空）`);
                        }
                        // 收集 PDF 渲染出的首页图（含校名 logo），供 AI 视觉识别校名等信息
                        if (parsed && Array.isArray(parsed.pageImages)) {
                            pdfImages.push(...parsed.pageImages);
                        }
                    } catch (err) {
                        skipped.push(`${file.name}（解析失败：${err.message}）`);
                    }
                } else {
                    skipped.push(`${file.name}（超出文件数量上限）`);
                }
                continue;
            }

            if (isTextLikeFile(file)) {
                if (textBlocks.length < maxTextFiles) {
                    const text = await file.text();
                    if (text.trim()) {
                        textBlocks.push({
                            name: file.name,
                            content: text.slice(0, 12000)
                        });
                    }
                } else {
                    skipped.push(`${file.name}（超出文本附件数量上限）`);
                }
                continue;
            }

            skipped.push(`${file.name}（当前仅支持图片、PDF、TXT、MD、JSON、CSV）`);
        }

        return {
            images: [...pdfImages, ...(await Promise.all(imageFiles.map(fileToDataUrl)))],
            textBlocks,
            skipped
        };
    }

    async function request(path, body) {
        const response = await fetch(getApiUrl(path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.error || 'AI 请求失败');
        }
        return payload.data;
    }

    window.aiClient = {
        prepareFiles,
        request,
        setApiBaseUrl
    };
})();
