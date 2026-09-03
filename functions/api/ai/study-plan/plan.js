// Cloudflare Pages Functions - 学习规划 模板②「课程规划方案」
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

// 不可见字符全量清理：控制符(\p{Cc})、格式符(\p{Cf}，含零宽空格/双向控制/BOM/标签字符)、
// 变体选择符(\uFE00-\uFE0F)。保留 \n \r \t（换行与缩进语义），其余一律剥离。
const INVISIBLE_CHARS_RE = /[\p{Cc}\p{Cf}\uFE00-\uFE0F]/gu;
function stripInvisibleChars(value) {
    return String(value).replace(INVISIBLE_CHARS_RE, ch => (ch === '\n' || ch === '\r' || ch === '\t') ? ch : '');
}

function normalizeString(value) {
    return typeof value === 'string' ? stripInvisibleChars(value).trim() : '';
}

// 多行字段：AI 可能返回数组或字符串，统一规整为「每行一条」的换行字符串
function normalizeMultiLine(value) {
    if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean).join('\n');
    return normalizeString(value);
}

// 模板②「课程规划方案」字段规整
function normalizeStudyPlanPlan(data = {}) {
    const course = (c) => {
        const introVal = normalizeMultiLine(c?.intro);
        let analysisVal = normalizeMultiLine(c?.analysis);
        // 兼容：若 AI 仍返回 intro（旧格式/不遵守提示词），将其并入 analysis
        if (introVal) {
            analysisVal = analysisVal ? `${introVal}\n${analysisVal}` : introVal;
        }
        return {
            code: normalizeString(c?.code),
            name: normalizeString(c?.name),
            credits: normalizeString(c?.credits),
            analysis: analysisVal,
            keyPoints: normalizeMultiLine(c?.keyPoints),
            assessment: normalizeMultiLine(c?.assessment),
            other: normalizeMultiLine(c?.other),
            recommend: normalizeMultiLine(c?.recommend)
        };
    };
    return {
        schoolZh: normalizeString(data.schoolZh),
        schoolEn: normalizeString(data.schoolEn),
        majorFullName: normalizeString(data.majorFullName),
        degreeName: normalizeString(data.degreeName),
        intro: Array.isArray(data.intro)
            ? data.intro.map(r => ({ title: normalizeString(r?.title), content: normalizeMultiLine(r?.content) })).filter(r => r.title || r.content)
            : (normalizeString(data.intro) ? [{ title: '', content: normalizeString(data.intro) }] : []),
        requirement: Array.isArray(data.requirement)
            ? data.requirement.map(r => ({ title: normalizeString(r?.title), content: normalizeMultiLine(r?.content) })).filter(r => r.title || r.content)
            : (normalizeString(data.requirement) ? [{ title: '', content: normalizeString(data.requirement) }] : []),
        coreCourses: Array.isArray(data.coreCourses) ? data.coreCourses.map(course).filter(c => c.code || c.name) : [],
        electiveCourses: Array.isArray(data.electiveCourses) ? data.electiveCourses.map(course).filter(c => c.code || c.name) : [],
        advice: Array.isArray(data.advice) ? data.advice.map(a => ({ title: normalizeString(a?.title), content: normalizeString(a?.content) })).filter(a => a.title || a.content) : []
    };
}

async function callAI({ prompt, images = [], textBlocks = [] }, env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    const model = env.DASHSCOPE_MODEL || MODEL;
    const baseUrl = env.DASHSCOPE_BASE_URL || BASE_URL;
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    const textParts = [prompt];
    if (textBlocks.length > 0) {
        textParts.push('\n\n以下是用户提供的文本内容：');
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
            model, temperature: 0.2, max_tokens: 8192,
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
        const { images = [], textBlocks = [] } = body;

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传专业手册或课程目录（图片或PDF）' }, 400);
        }

        const prompt = `
你是一位资深的留学学业规划专家。请仔细阅读提供的专业手册 / 课程目录（图片或文档），提取该专业的真实课程信息，输出符合以下规范的结构化「课程规划方案」数据。

【重要】所有输出必须基于上传文件中的实际内容。文件信息不足时可合理推断，但优先使用文件中明确提供的内容，不要编造具体的课程代码。

【输出格式】严格的JSON，字段如下：
{
  "schoolZh": "学校中文名",
  "schoolEn": "学校英文名",
  "majorFullName": "专业全称（英文，如：Archaeology and Anthropology BA）",
  "degreeName": "学位名称（中文，如：考古学与人类学学士学位）",
  "intro": [{"title":"小标题","content":"正文内容"}],
  "requirement": [
    {"title":"专业要求标题（如：学术成绩要求、语言成绩要求）","content":"要求内容（中文）"}
  ],
  "coreCourses": [
    {"code":"课程代码（英文原文）","name":"课程名称（英文原文）","credits":"学分（如：5 ECTS / 10 CATS）","analysis":"课程解析（中文，含课程简介内容）","keyPoints":"重难点，每行一条，用\\n分隔","assessment":"考核项，每行一条，用\\n分隔","other":"其他信息，每行一条，用\\n分隔"}
  ],
  "electiveCourses": [
    {"code":"课程代码","name":"课程名称","credits":"学分（如：5 ECTS / 10 CATS）","analysis":"课程解析（含课程简介）","keyPoints":"重难点\\n...","assessment":"考核项\\n...","other":"其他信息\\n...","recommend":"推荐建议，每行一条，用\\n分隔"}
  ],
  "advice": [
    {"title":"学术建议标题（如：选课策略）","content":"建议内容（中文）"}
  ]
}

【各字段生成规范】
1. schoolZh/schoolEn/majorFullName/degreeName：提取学校与专业的正式名称；schoolZh/schoolEn 为「大学/学院本身」的名称（如「布里斯托大学」/「University of Bristol」），须从文档标题或专业全称中提取，不要将「所属学院为XX」「所在学院：XX」这类描述性句子整体当作学校名，也不要带上「所属学院」「学院」等前缀词；majorFullName 保留英文原文，degreeName 输出中文。
2. intro：按文档中的小标题+正文结构完整提取，输出为 title（小标题）+ content（正文）数组；文档有几条就输出几条，不要概括或删减。
3. requirement：按文档实际内容完整提取所有专业要求（如学术成绩要求、语言成绩要求、先修课程要求、升学要求、学位授予要求等），不要删减条目，每条含 title 与 content。
4. coreCourses：列出文档中实际出现的全部必修课程，每门课包含 code、name（英文原文）+ credits（学分，如 5 ECTS / 10 CATS，优先从文档提取，格式统一）+ analysis（中文课程解析，须按文档实际内容完整提取，涵盖课程简介内容：专业定位、核心内容、培养目标，不要概括或删减）+ keyPoints、assessment、other（均按文档实际条目完整提取，每行一条，用\\n分隔）。
5. electiveCourses：列出文档中实际出现的全部选修课程，字段同 coreCourses（含 credits），额外含 recommend（按文档实际内容完整提取，不要概括或删减）。
6. advice：按文档实际内容完整提取所有学术建议，不要删减条目，每条含 title 与 content。

【语言规则】
- 课程代码（code）、课程名（name）、majorFullName 保留英文原文
- 其余字段全部中文输出
- 专业术语可保留英文

【质量要求】
- 输出必须是合法JSON，不包含任何JSON外的解释性文字
- 不要编造不存在的课程代码，信息不足时合理推断
- 所有列表型字段（advice、requirement、coreCourses、electiveCourses 以及每门课内的 keyPoints、assessment、other 等）必须按文档实际条目逐条提取，不得合并、删减或遗漏；文档有几条就输出几条`;

        const result = await callAI({ prompt, images, textBlocks }, env);
        return createResponse({ data: normalizeStudyPlanPlan(result) });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
