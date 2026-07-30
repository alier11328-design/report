// 客户端 PDF 解析完成后调用此接口进行 AI 分析
// 请求体中包含已解析的文本内容
import { createResponse, callAI } from './_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const { text, filename, fileType } = body;

        if (!text || !filename) {
            return createResponse({ error: '缺少文本内容或文件名' }, 400);
        }

        if (fileType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
            // 直接返回客户端解析的文本
            return createResponse({ text: text.slice(0, 20000) });
        }

        // 文本文件直接返回
        return createResponse({ text: text.slice(0, 20000) });
    } catch (error) {
        return createResponse({ error: error.message || '文件处理失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
