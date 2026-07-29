import { createResponse, createError, parseBody, askQwenForJson, normalizeString, normalizeStringArray, formatTextBlocks } from '../../utils.js';

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
        const textBlocks = formatTextBlocks(body?.textBlocks);
        const skippedFiles = normalizeStringArray(body?.skippedFiles);
        const existingProcess = normalizeString(body?.context?.existingProcess);
        const mode = normalizeString(body?.context?.processMode) || 'timeline';

        if (!images.length && !textBlocks && !existingProcess) {
            return createError('请先提供过程材料或文本', 400);
        }

        const prompt = `
请根据售后复盘材料，生成"过程复盘"内容。

表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

当前文本材料：
${textBlocks || '无'}

当前已填写过程复盘：
${existingProcess || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

当前展示模式：${mode}

请输出 JSON：
{
  "process": "",
  "conclusion": ""
}

要求：
1. 如果模式是 timeline，则 process 按"一行一个节点"输出，尽量带日期或阶段描述。
2. 如果模式是 text，则 process 输出自然段。
3. conclusion 输出复盘结论与后续建议，没有把握可留空。
4. 不要输出结构外字段。`;

        const result = await askQwenForJson(context, { prompt, images });
        return createResponse({
            data: {
                process: normalizeString(result.process),
                conclusion: normalizeString(result.conclusion)
            }
        });
    } catch (error) {
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}