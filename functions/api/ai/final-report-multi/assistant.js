// Cloudflare Pages Functions - 结课报告（多门）· 教辅寄语生成（纯文本，无需上传材料）
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
            model, temperature: 0.8,
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
        const previousMessage = normalizeString(ctx.previousMessage);

        const prompt = `
请为「结课报告」生成一段教辅寄语（以教辅老师/学管师口吻写给学生的学期总结寄语）。

上下文信息：
${JSON.stringify({
    studentName: ctx.studentName || '',
    university: ctx.university || '',
    attendanceRate: ctx.attendanceRate || '',
    taskCompletionRate: ctx.taskCompletionRate || '',
    interactionRate: ctx.interactionRate || '',
    courses: Array.isArray(ctx.courses) ? ctx.courses : []
}, null, 2)}

要求：
1. 寄语写多段，用 \\n 分隔段落，总长度 150-300 字。
2. 风格：${normalizeString(ctx.style) || '亲切自然，鼓励为主'}。
3. ${previousMessage ? '用户对上一版不满意，请确保与之前的版本在语气、开头、用词上明显不同。之前版本：\n' + previousMessage.slice(0, 500) : '语气亲切，可适当使用 emoji。'}
4. 结合学生的学习表现与课程情况，给予肯定与下学期展望。
5. 上下文中为空的字段直接略过，不要在寄语里出现 [studentName]、[courses] 之类的占位符或方括号。
6. 请输出 JSON：{ "assistantMessage": "寄语内容" }，不要输出结构外字段。
`;

        const result = await callAI({ prompt }, env);

        return createResponse({
            data: {
                assistantMessage: normalizeString(result.assistantMessage)
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 生成失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
