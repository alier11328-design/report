import { createResponse, callAI } from '../../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const images = Array.isArray(body.images) ? body.images : [];
        const textBlocks = Array.isArray(body.textBlocks) ? body.textBlocks : [];
        const skippedFiles = Array.isArray(body.skippedFiles) ? body.skippedFiles : [];
        const existingProcess = body.context?.existingProcess || '';
        const mode = body.context?.processMode || 'timeline';

        if (!images.length && !textBlocks.length && !existingProcess) {
            return createResponse({ error: '请先提供过程材料或文本' }, 400);
        }

        const textBlocksStr = textBlocks.length > 0
            ? textBlocks.map(b => `附件名: ${b.name}\n附件内容:\n${b.content}`).join('\n\n---\n\n')
            : '无';

        const prompt = `
请根据售后复盘材料，生成"过程复盘"内容。

表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

当前文本材料：
${textBlocksStr}

当前已填写过程复盘：
${existingProcess || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

当前展示模式：${mode}

请输出 JSON：{ "process": "", "conclusion": "" }
要求：timeline 模式 process 一行一节点；text 模式输出自然段。`;

        const result = await callAI({ prompt, images }, env);
        return createResponse({
            data: {
                process: result.process || '',
                conclusion: result.conclusion || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
