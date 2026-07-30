import OpenAI from 'openai';

const MODEL = 'doubao-seed-2-0-lite';
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';

let openai = null;

function getOpenai(context) {
    if (openai) return openai;
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseUrl = process.env.DASHSCOPE_BASE_URL;
    const model = process.env.DASHSCOPE_MODEL;
    if (apiKey) {
        openai = new OpenAI({
            apiKey,
            baseURL: baseUrl || BASE_URL
        });
    }
    return openai;
}

const JSON_ONLY_SYSTEM_PROMPT = [
    '你是一个用于教辅报告生成的后端 AI 助手。',
    '你的任务是根据输入材料输出严格合法的 JSON。',
    '不要输出 Markdown、不要输出代码块、不要输出解释性文字。',
    '如果信息不足，可以留空字符串、空数组，但不要编造具体分数、日期、课时或事实。',
    '输出字段必须和用户要求的 JSON 结构一致。'
].join('');

export function createResponse(data, statusCode = 200) {
    return new Response(JSON.stringify(data), {
        status: statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

export function createError(message, statusCode = 500) {
    return createResponse({ error: message }, statusCode);
}

export async function parseBody(request) {
    if (request.method === 'OPTIONS') return null;
    if (request.method === 'GET') return null;
    try {
        const text = await request.text();
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStringArray(items) {
    return Array.isArray(items)
        ? items.map(normalizeString).filter(Boolean)
        : [];
}

export function normalizeAssessmentArray(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            name: normalizeString(item?.name),
            type: normalizeString(item?.type),
            ddl: normalizeString(item?.ddl),
            summary: normalizeString(item?.summary)
        }))
        .filter(item => item.name || item.type || item.ddl || item.summary);
}

export function normalizeWeekPlans(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            week: normalizeString(item?.week),
            focus: normalizeString(item?.focus),
            activities: normalizeString(item?.activities),
            assessment: normalizeString(item?.assessment)
        }))
        .filter(item => item.week || item.focus || item.activities || item.assessment);
}

export function normalizeScheduleRows(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            courseName: normalizeString(item?.courseName),
            startTime: normalizeString(item?.startTime),
            endTime: normalizeString(item?.endTime),
            duration: normalizeString(item?.duration)
        }))
        .filter(item => item.courseName || item.startTime || item.endTime || item.duration);
}

export function formatTextBlocks(textBlocks = []) {
    return Array.isArray(textBlocks)
        ? textBlocks
            .map(block => `附件名: ${normalizeString(block?.name)}\n附件内容:\n${normalizeString(block?.content)}`)
            .filter(Boolean)
            .join('\n\n---\n\n')
        : '';
}

function extractJsonObject(text) {
    if (!text) throw new Error('AI 未返回内容');
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (error) {
        const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch) {
            return JSON.parse(fenceMatch[1].trim());
        }
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        throw error;
    }
}

function toMessageText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map(item => {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (item.type === 'text') return item.text || '';
                return '';
            })
            .join('\n')
            .trim();
    }
    return '';
}

export async function askQwenForJson(context, { prompt, images = [], textBlocks = [] }) {
    const client = getOpenai(context);
    if (!client) {
        const error = new Error('服务端缺少 DASHSCOPE_API_KEY，请先配置环境变量。');
        error.statusCode = 500;
        throw error;
    }

    const textParts = [prompt];
    if (textBlocks && textBlocks.length > 0) {
        textParts.push('\n\n以下是上传文档提取的文本内容：');
        textBlocks.forEach((block, idx) => {
            textParts.push(`\n【文档${idx + 1}：${block.name || '未命名'}】\n${block.content || ''}`);
        });
    }

    const content = [{ type: 'text', text: textParts.join('\n') }];
    images.slice(0, 8).forEach(url => {
        if (typeof url === 'string' && url.startsWith('data:image/')) {
            content.push({
                type: 'image_url',
                image_url: { url }
            });
        }
    });

    const completion = await client.chat.completions.create({
        model: process.env.DASHSCOPE_MODEL || MODEL,
        temperature: 0.2,
        messages: [
            { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
            { role: 'user', content }
        ]
    });

    return extractJsonObject(toMessageText(completion.choices?.[0]?.message?.content));
}

export { MODEL, BASE_URL };
