import { createResponse, createError, parseBody, askQwenForJson, normalizeString, normalizeScheduleRows } from '../../utils.js';

export default async function handler(event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (event.httpMethod !== 'POST') {
        return createError('Method not allowed', 405);
    }

    try {
        const body = parseBody(event);
        const images = Array.isArray(body?.images) ? body.images : [];
        const textBlocks = Array.isArray(body?.textBlocks) ? body.textBlocks : [];

        if (!images.length && !textBlocks.length) {
            return createError('请先上传排课截图或PDF文件', 400);
        }

        const prompt = `
请从这些排课截图或PDF文件中提取排课记录，返回 JSON：
{
  "rows": [
    {
      "courseName": "",
      "startTime": "",
      "endTime": "",
      "duration": ""
    }
  ]
}

当前表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

要求：
1. 尽量保留原始课程名、开始时间、结束时间、时长。
2. 无法识别的字段留空字符串。
3. 不要补造不存在的排课记录。`;

        const result = await askQwenForJson(context, { prompt, images, textBlocks });
        return createResponse({ data: { rows: normalizeScheduleRows(result.rows) } });
    } catch (error) {
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}