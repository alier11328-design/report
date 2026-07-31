// Cloudflare Pages Functions - 课程规划(新版)
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
        const { images = [], textBlocks = [], context: formContext = {} } = body;

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传图片或PDF文件' }, 400);
        }

        const prompt = `
请根据下面的图片和文档材料，识别并提取课程规划信息。

当前表单上下文：
${JSON.stringify(formContext, null, 2)}

请输出 JSON，必须包含所有字段：
{
  "courseCode": "课程代码，如FINS2643",
  "courseName": "课程名称（英文）",
  "courseDesc": "课程介绍（50-100字）",
  "focusPoints": "重点，每行一条",
  "difficultyPoints": "难点，每行一条",
  "assessments": [{"seq":"1","name":"考核名称","detail":"详情","weight":"占比","ddl":"截止日期"}],
  "plans": [{"session":"1","content":"课程内容","goal":"学习目标","hours":"2h"}],
  "advices": "学习建议，每行一条"
}

要求：
1. assessments 提取考核方式，每项包含序号、名称、详情、占比、DDL
2. plans 提取周度/课次规划，每课次包含课次号、内容、目标、预计课时，最多12课次
3. focusPoints 和 difficultyPoints 各3-6条
4. advices 3-6条学习建议
5. 不要编造不存在的信息，信息不足时留空`;

        const result = await callAI({ prompt, images, textBlocks }, env);

        return createResponse({
            data: {
                courseCode: result.courseCode || '',
                courseName: result.courseName || '',
                courseDesc: result.courseDesc || '',
                focusPoints: result.focusPoints || '',
                difficultyPoints: result.difficultyPoints || '',
                assessments: Array.isArray(result.assessments) ? result.assessments : [],
                plans: Array.isArray(result.plans) ? result.plans : [],
                advices: result.advices || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}