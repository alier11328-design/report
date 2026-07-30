// Cloudflare Pages Functions - 复习报告原因分析
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const MODEL = 'doubao-seed-2-0-lite';

const JSON_ONLY_SYSTEM_PROMPT = [
    '你是一个用于教辅报告生成的后端 AI 助手。',
    '你的任务是根据输入材料输出严格合法的 JSON。',
    '不要输出 Markdown、不要输出代码块、不要输出解释性文字。',
    '如果信息不足，可以留空字符串、空数组，但不要编造具体分数、日期、课时或事实。',
    '输出字段必须和用户要求的 JSON 结构一致。'
].join('');

function createResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

function extractJsonObject(text) {
    if (!text) throw new Error('AI 未返回内容');
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        throw new Error('无法解析 AI 返回的 JSON');
    }
}

async function callAI({ prompt, images = [], textBlocks = [] }, env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    const model = env.DASHSCOPE_MODEL || MODEL;
    const baseUrl = env.DASHSCOPE_BASE_URL || BASE_URL;
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    const textParts = [prompt];
    if (textBlocks.length > 0) {
        textParts.push('\n\n以下是上传文档提取的文本内容：');
        textBlocks.forEach((block, idx) => {
            textParts.push(`\n【文档${idx + 1}：${block.name || '未命名'}】\n${block.content || ''}`);
        });
    }

    const content = [{ type: 'text', text: textParts.join('\n') }];
    images.slice(0, 8).forEach(url => {
        if (typeof url === 'string' && url.startsWith('data:image/')) {
            content.push({ type: 'image_url', image_url: { url } });
        }
    });

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model, temperature: 0.2,
            messages: [
                { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                { role: 'user', content }
            ]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return extractJsonObject(text);
}

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
