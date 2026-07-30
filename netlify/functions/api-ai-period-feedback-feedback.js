import { createResponse, createError, parseBody, askQwenForJson, normalizeString } from './_shared/utils.js';

export default async function handler(request, context) {
    if (request.method === 'OPTIONS') return createResponse({ ok: true });
    if (request.method !== 'POST') return createError('Method not allowed', 405);

    try {
        const body = await parseBody(request);
        const images = Array.isArray(body?.images) ? body.images : [];
        const textBlocks = Array.isArray(body?.textBlocks) ? body.textBlocks : [];

        if (!images.length && !textBlocks.length) return createError('请先上传反馈截图或PDF文件', 400);

        const prompt = `
请根据这些课堂反馈/聊天截图或PDF文件，整理成阶段性反馈报告中的四段文字。

当前表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

请输出 JSON：
{
  "performance": "",
  "progress": "",
  "mastery": "",
  "suggestion": ""
}

要求：
1. 使用正式、自然、可直接给家长/学生查看的中文。
2. 每个字段 1-3 句话为宜。
3. 不要编造截图中没有体现的具体成绩或时长。`;

        const result = await askQwenForJson({ prompt, images, textBlocks });
        return createResponse({
            data: {
                performance: normalizeString(result.performance),
                progress: normalizeString(result.progress),
                mastery: normalizeString(result.mastery),
                suggestion: normalizeString(result.suggestion)
            }
        });
    } catch (error) {
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}

export const config = { path: '/api/ai/period-feedback/feedback' };
