import { createResponse, callAI } from '../../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const images = Array.isArray(body.images) ? body.images : [];
        const textBlocks = Array.isArray(body.textBlocks) ? body.textBlocks : [];

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传反馈截图或PDF文件' }, 400);
        }

        const prompt = `
请根据这些课堂反馈/聊天截图或PDF文件，整理成阶段性反馈报告中的四段文字。

当前表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

请输出 JSON：
{
  "performance": "", "progress": "", "mastery": "", "suggestion": ""
}

要求：使用正式、自然、可直接给家长/学生查看的中文。每个字段 1-3 句话。`;

        const result = await callAI({ prompt, images, textBlocks }, env);
        return createResponse({
            data: {
                performance: result.performance || '',
                progress: result.progress || '',
                mastery: result.mastery || '',
                suggestion: result.suggestion || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
