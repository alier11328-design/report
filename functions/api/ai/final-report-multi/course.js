// Cloudflare Pages Functions - 结课报告（多门）· 单门课程识别
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const MODEL = 'doubao-seed-2.1-lite';

// 火山方舟 doubao-seed 2.x 默认开启深度思考，长任务会超过 Cloudflare 边缘 100s 超时（返回 524），这里显式关闭。
// 注意：百炼 qwen 用的是 enable_thinking（布尔），与火山的 thinking:{type:'disabled'} 不是一回事，别混用。
function arkThinking(baseUrl) {
    return /volces\.com/i.test(String(baseUrl)) ? { thinking: { type: 'disabled' } } : {};
}

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

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeOutcomeArray(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            subtitle: normalizeString(item?.subtitle),
            content: normalizeString(item?.content)
        }))
        .filter(item => item.subtitle || item.content);
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
            ...arkThinking(baseUrl),
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

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请至少上传一张截图或 PDF 文档' }, 400);
        }

        const ctx = body.context || {};
        const prompt = `
请根据以下材料，为「结课报告」中这一门课程生成报告内容。

课程上下文（可能部分为空，可从材料中识别补充）：
${JSON.stringify(ctx, null, 2)}

请输出 JSON：
{
  "learningGoal": "学习目标回顾：一段完整描述（至少80字），概括这门课的学习目标与核心内容",
  "outcomes": [ { "subtitle": "成果小标题（6-10字）", "content": "该成果的具体内容描述" } ],
  "teacherMessage": "讲师寄语：以讲师口吻写至少两段，用 \\n 分隔段落，每段至少40字"
}

要求：
1. outcomes 至少 3 条，subtitle 简洁、content 具体详实。
2. 材料中没有的客观数据不要编造；寄语与学习目标要贴合课程内容。
3. 输出适合正式中文报告的语气，不要输出结构外字段。
4. ${textBlocks.length ? '优先根据 PDF/文本附件内容分析，截图和附件信息冲突时以附件为准。' : '根据截图内容分析生成。'}
`;

        const result = await callAI({ prompt, images, textBlocks }, env);

        return createResponse({
            data: {
                learningGoal: normalizeString(result.learningGoal),
                outcomes: normalizeOutcomeArray(result.outcomes),
                teacherMessage: normalizeString(result.teacherMessage)
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
