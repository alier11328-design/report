(function () {
    const TEXT_FILE_EXTENSIONS = ['.txt', '.md', '.json', '.csv'];
    const PARSEABLE_FILE_EXTENSIONS = ['.pdf'];

    // API base URL configuration
    // Set to your backend URL when deploying frontend to Cloudflare Pages
    // Example: window.__API_BASE__ = 'https://your-backend.up.railway.app';
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

    async function parseFileOnServer(file) {
        // Convert file to base64 for Vercel Serverless compatibility
        // (multipart/form-data is not well supported in Vercel Serverless Functions)
        const base64 = await fileToBase64(file);
        
        const fileSizeBytes = file.size || 0;
        const maxSizeBytes = 3 * 1024 * 1024; // 3MB limit for Vercel Hobby plan
        if (fileSizeBytes > maxSizeBytes) {
            throw new Error(`文件过大（${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB），Vercel 免费版限制 3MB，请压缩后重试`);
        }
        
        const response = await fetch(getApiUrl('/api/parse-file'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                file: base64,
                filename: file.name,
                fileType: file.type || ''
            })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || '文件解析失败');
        }
        const result = await response.json();
        return result.text;
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
