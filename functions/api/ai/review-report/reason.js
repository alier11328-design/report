import { createResponse, callAI } from '../../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const images = Array.isArray(body.images) ? body.images : [];
        const textBlocks = Array.isArray(body.textBlocks) ? body.textBlocks : [];
        const skippedFiles = Array.isArray(body.skippedFiles) ? body.skippedFiles : [];
        const existingReason = body.context?.existingReason || '';

        if (!images.length && !textBlocks.length && !existingReason) {
            return createResponse({ error: '请先提供原因分析材料或文本' }, 400);
        }

        const textBlocksStr = textBlocks.length > 0
            ? textBlocks.map(b => `附件名: ${b.name}\n附件内容:\n${b.content}`).join('\n\n---\n\n')
            : '无';

        const prompt = `
请根据售后复盘材料，为"原因分析"字段输出可直接回填的正式中文内容。

表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

当前文本材料：
${textBlocksStr}

当前已填写原因分析：
${existingReason || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

请输出 JSON：{ "reason": "" }
要求：聚焦问题成因、沟通断点、流程缺口。使用 2-5 段。`;

        const result = await callAI({ prompt, images }, env);
        return createResponse({ data: { reason: result.reason || '' } });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
