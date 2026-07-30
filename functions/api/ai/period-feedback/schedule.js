import { createResponse, callAI } from '../../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const images = Array.isArray(body.images) ? body.images : [];
        const textBlocks = Array.isArray(body.textBlocks) ? body.textBlocks : [];

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传排课截图或PDF文件' }, 400);
        }

        const prompt = `
请从这些排课截图或PDF文件中提取排课记录，返回 JSON：
{
  "rows": [{ "courseName": "", "startTime": "", "endTime": "", "duration": "" }]
}

当前表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

要求：尽量保留原始课程名、开始时间、结束时间、时长。`;

        const result = await callAI({ prompt, images, textBlocks }, env);
        return createResponse({ data: { rows: Array.isArray(result.rows) ? result.rows : [] } });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
