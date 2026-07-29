import { createResponse, createError, parseBody } from './utils.js';
import { Buffer } from 'buffer';

export default async function onRequest(context) {
    const request = context.request;
    
    if (request.method === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (request.method !== 'POST') {
        return createError('Method not allowed', 405);
    }

    try {
        const body = await parseBody(context);
        
        if (!body || !body.file || !body.filename) {
            return createError('缺少文件数据或文件名', 400);
        }

        const { file: base64File, filename, fileType } = body;
        const buffer = Buffer.from(base64File, 'base64');

        if (buffer.length > 3 * 1024 * 1024) {
            return createError('文件过大，限制约 3MB', 413);
        }

        const path = await import('path');
        const ext = path.extname(filename).toLowerCase();
        let text = '';

        if (fileType === 'application/pdf' || ext === '.pdf') {
            try {
                const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
                const uint8Array = new Uint8Array(buffer);
                const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
                const textParts = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    const pageText = content.items.map(item => item.str).join(' ');
                    textParts.push(pageText);
                }
                text = textParts.join('\n');
            } catch (pdfError) {
                console.error('PDF 解析失败:', pdfError.message);
                return createError(`PDF 解析失败: ${pdfError.message}`, 400);
            }
        } else if (['.txt', '.md', '.json', '.csv'].includes(ext)) {
            text = buffer.toString('utf-8');
        } else {
            return createError(`不支持的文件类型: ${ext}，当前支持 PDF 和文本文件`, 400);
        }

        return createResponse({ text: text.slice(0, 20000) });
    } catch (error) {
        console.error('文件解析错误:', error);
        return createError(error.message || '文件解析失败', 500);
    }
}