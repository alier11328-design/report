// Cloudflare Pages Functions - 结课报告（多门）· 下学期学习建议生成（基于整份报告已填内容，无需上传材料）
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

async function callAI({ prompt }, env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    const model = env.DASHSCOPE_MODEL || MODEL;
    const baseUrl = env.DASHSCOPE_BASE_URL || BASE_URL;
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            ...arkThinking(baseUrl),
            model, temperature: 0.6,
            messages: [
                { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                { role: 'user', content: prompt }
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
        const ctx = body.context || {};

        const prompt = `
请为「结课报告」撰写"下学期学习建议"部分，直接可用于正式报告回填。

上下文信息：
${JSON.stringify({
    studentName: ctx.studentName || '',
    university: ctx.university || '',
    periodStart: ctx.periodStart || '',
    periodEnd: ctx.periodEnd || '',
    attendanceRate: ctx.attendanceRate || '',
    attendanceDesc: ctx.attendanceDesc || '',
    taskCompletionRate: ctx.taskCompletionRate || '',
    taskCompletionDesc: ctx.taskCompletionDesc || '',
    interactionRate: ctx.interactionRate || '',
    interactionDesc: ctx.interactionDesc || '',
    reportOverview: ctx.reportOverview || '',
    courses: Array.isArray(ctx.courses) ? ctx.courses : []
}, null, 2)}

要求：
1. 先写一段"建议概述"（100-160 字），总体肯定本学期表现并点出下学期的成长方向。
2. 再写 3-5 条具体建议，每条含简洁小标题（6-10 字）与具体内容（60-120 字），要贴合上面课程的学习目标、成果与不足，可涉及知识巩固、学习习惯、时间管理、进阶方向等，避免空泛套话。
3. 语气正式、真诚、鼓励为主；不要编造上下文中没有的具体分数或事实。
4. 上下文中为空的字段直接略过，不要出现 [studentName]、[courses] 之类占位符或方括号。
5. 请输出 JSON：{ "suggestionsIntro": "建议概述", "suggestions": [ { "subtitle": "小标题", "content": "具体内容" } ] }，不要输出结构外字段。
`;

        const result = await callAI({ prompt }, env);

        return createResponse({
            data: {
                suggestionsIntro: normalizeString(result.suggestionsIntro),
                suggestions: normalizeOutcomeArray(result.suggestions)
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || '生成建议失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
