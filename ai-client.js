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
// 从 CDN 加载
let pdfjsLib = null;

async function loadPdfJs() {
    if (pdfjsLib) return pdfjsLib;
    if (typeof window['pdfjsLib'] !== 'undefined') {
        pdfjsLib = window['pdfjsLib'];
        return pdfjsLib;
    }
    // 动态加载
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
        pdfjsLib = window['pdfjsLib'];
    };
    document.head.appendChild(script);
    // 等待加载
    while (!pdfjsLib) {
        await new Promise(r => setTimeout(r, 50));
    }
    return pdfjsLib;
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
        return fullText;
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
                        const text = await parseFileOnServer(file);
                        if (text && text.trim()) {
                            textBlocks.push({
                                name: file.name,
                                content: text.slice(0, 12000)
                            });
                        } else {
                            skipped.push(`${file.name}（文件内容为空）`);
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
            images: await Promise.all(imageFiles.map(fileToDataUrl)),
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
