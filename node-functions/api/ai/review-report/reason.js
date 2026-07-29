import { createResponse, createError, parseBody, askQwenForJson, normalizeString, normalizeStringArray, formatTextBlocks } from '../../utils.js';

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
        const images = Array.isArray(body?.images) ? body.images : [];
        const textBlocks = formatTextBlocks(body?.textBlocks);
        const skippedFiles = normalizeStringArray(body?.skippedFiles);
        const existingReason = normalizeString(body?.context?.existingReason);

        if (!images.length && !textBlocks && !existingReason) {
            return createError('请先提供原因分析材料或文本', 400);
        }

        const prompt = `
请根据售后复盘材料，为"原因分析"字段输出可直接回填的正式中文内容。

表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

当前文本材料：
${textBlocks || '无'}

当前已填写原因分析：
${existingReason || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

请输出 JSON：
{
  "reason": ""
}

要求：
1. 聚焦问题成因、沟通断点、流程缺口。
2. 使用 2-5 段、适合正式复盘报告。
3. 不要输出结构外字段。`;

        const result = await askQwenForJson(context, { prompt, images });
        return createResponse({ data: { reason: normalizeString(result.reason) } });
    } catch (error) {
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}