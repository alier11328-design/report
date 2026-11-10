// Cloudflare Pages Functions - 朋友圈海报「课程信息」截图识图
// 前端把 1~4 张图片压成长边 2000 内的 data URI 一起传进来，模型综合多张图只做字段抽取，不做文案创作。
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const MODEL = 'doubao-seed-2.1-lite';
const MAX_IMAGE_CHARS = 16 * 1024 * 1024;       // 单张 data URI 字符数上限，防止把边缘节点打爆
const MAX_TOTAL_IMAGE_CHARS = 24 * 1024 * 1024; // 多张合计上限
const MAX_IMAGES = 4;

const FIELD_LIMITS = {
    region: 18,
    school: 30,
    major: 24,
    courseCode: 20,
    teacher: 24,
    courseName: 70
};

const JSON_ONLY_SYSTEM_PROMPT = [
    '你是一个用于教辅报告生成的后端 AI 助手。',
    '你的任务是根据输入材料输出严格合法的 JSON。',
    '不要输出 Markdown、不要输出代码块、不要输出解释性文字。',
    '如果信息不足，可以留空字符串，但不要编造任何事实。',
    '输出字段必须和用户要求的 JSON 结构一致。'
].join('');

const OCR_PROMPT = `请读取下面这些图片里的文字（可能是同一份课程信息的多张截图，每张可能是聊天记录、课程表、订单截图、学校系统页面或课程信息卡片），综合所有图片，提取用于制作朋友圈海报的 6 项课程信息。

只输出严格合法的 JSON，键名固定为：
{ "region": "", "school": "", "major": "", "courseCode": "", "teacher": "", "courseName": "" }

【字段含义】
- region：国家或地区（例如 澳洲、英国、美国、加拿大、新加坡）。只写地区名，不要写学校名。
- school：学校名称，保留图片里的原文（中英文都可以）。
- major：专业名称。
- courseCode：课程代码，通常是「字母 + 数字」的编号（如 BIOL1020、COMP1000、ACCT1101）。不要把学号、订单号、手机号、日期、时间、金额当成课程代码。
- teacher：辅导老师姓名。不要把学生姓名、群昵称、客服当成老师；图中写成「XX老师」时去掉「老师」二字，只留名字。
- courseName：课程名称。英文课程名保留英文原文，不要翻译成中文；不要和 courseCode 拼在一起。

【硬性规则】
1. 只能填写图片中确实看得见的信息；所有图片里都没有、看不清、不确定的字段一律留空字符串 ""，严禁根据常识推测、补全或编造。
2. 值里不要带标签文字（如「学校：」「课程代码」「Course:」）、引号、换行、emoji、括号注释，只给值本身。
3. 同一字段出现多个候选值时，取最像「本次课程」的那一个：优先课程卡片 / 订单主体 / 本次安排，其次才是聊天正文；不要取聊天里举例或历史消息里的旧信息。多张图片里同一字段取值冲突时按同一原则取舍；不同字段分散在不同图片里时，分别取出来合并成一份结果。
4. 值要简短：region ≤ 18 字，school ≤ 30 字，major ≤ 24 字，courseCode ≤ 20 字，teacher ≤ 24 字，courseName ≤ 70 字。
5. 如果所有图片里完全没有课程相关信息，6 个字段全部返回空字符串。
6. 只输出 JSON，不要任何解释。`;

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

// 模型偶尔会把「学校：」这类标签或占位词带进值里，这里统一兜底清洗
function cleanValue(value, limit) {
    let text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 2; i += 1) {
        text = text.replace(/^(?:国家或地区|地区|国家|学校|院校|大学|专业|课程代码|课程编号|课程号|辅导老师|老师|课程名称|课程名|课程|region|school|major|course\s*code|teacher|course\s*name)\s*[:：]\s*/iu, '');
    }
    text = text.replace(/^["'「『【（(\[]+|["'」』】）)\]]+$/gu, '').trim();
    if (/^(?:未填写|无|没有|未知|暂无|null|none|n\/a|nan|undefined|（未填写）|\(未填写\))$/iu.test(text)) return '';
    return text.slice(0, limit);
}

function cleanFields(raw) {
    const fields = {};
    Object.entries(FIELD_LIMITS).forEach(([key, limit]) => {
        fields[key] = cleanValue(raw?.[key], limit);
    });
    return fields;
}

async function callAI(images, env) {
    // 全站统一走 DASHSCOPE_*（火山方舟 agent plan）。POSTER_AI_* 只在 key + baseUrl 成对配齐时覆盖。
    const posterKey = env.POSTER_AI_API_KEY;
    const posterBase = env.POSTER_AI_BASE_URL;
    const usePosterOverride = Boolean(posterKey && posterBase);
    const apiKey = usePosterOverride ? posterKey : env.DASHSCOPE_API_KEY;
    const baseUrl = usePosterOverride ? posterBase : (env.DASHSCOPE_BASE_URL || BASE_URL);
    const model = usePosterOverride
        ? (env.POSTER_AI_MODEL || MODEL)
        : (env.DASHSCOPE_MODEL || MODEL);
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    // 火山方舟用 thinking:{type:'disabled'} 关思考；百炼 qwen 用 enable_thinking:false，不能混发
    const isArk = /volces\.com/i.test(String(baseUrl));
    const thinkingParams = isArk ? { thinking: { type: 'disabled' } } : { enable_thinking: false };
    const messages = [
        { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
        {
            role: 'user',
            content: [
                { type: 'text', text: OCR_PROMPT },
                ...images.map(image => ({ type: 'image_url', image_url: { url: image } }))
            ]
        }
    ];

    let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, temperature: 0.1, ...thinkingParams, messages })
    });

    // 部分模型不支持思考开关参数，失败时自动退回普通调用
    if (!response.ok && Object.keys(thinkingParams).length) {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ model, temperature: 0.1, messages })
        });
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return extractJsonObject(data.choices?.[0]?.message?.content || '');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        // 新版前端传 images 数组（一次看多张截图）；image 单图字段保留给旧前端兜底
        const single = typeof body?.image === 'string' ? body.image : '';
        const images = (Array.isArray(body?.images) ? body.images : [])
            .filter(url => typeof url === 'string' && url.startsWith('data:image/'))
            .slice(0, MAX_IMAGES);
        if (!images.length && single.startsWith('data:image/')) images.push(single);
        if (!images.length) {
            return createResponse({ error: '缺少课程信息图片' }, 400);
        }
        if (images.some(image => image.length > MAX_IMAGE_CHARS)) {
            return createResponse({ error: '图片过大，请换一张更小的截图' }, 413);
        }
        if (images.reduce((total, image) => total + image.length, 0) > MAX_TOTAL_IMAGE_CHARS) {
            return createResponse({ error: '图片总大小超出限制，请减少张数或换更小的截图' }, 413);
        }

        const raw = await callAI(images, env);
        return createResponse({ data: cleanFields(raw) });
    } catch (error) {
        return createResponse({ error: error.message || '课程信息识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
