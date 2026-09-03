// Cloudflare Pages Functions - 学习规划 模板①「学习指南」
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

// 模板①「学习指南」字段规整
function normalizeStudyPlanGuide(data = {}) {
    return {
        schoolZh: normalizeString(data.schoolZh),
        schoolEn: normalizeString(data.schoolEn),
        majorZh: normalizeString(data.majorZh),
        majorEn: normalizeString(data.majorEn),
        mode: normalizeString(data.mode),
        language: normalizeString(data.language),
        credits: normalizeString(data.credits),
        internship: normalizeString(data.internship),
        intro: Array.isArray(data.intro)
            ? data.intro.map(r => ({ title: normalizeString(r?.title), content: normalizeMultiLine(r?.content) })).filter(r => r.title || r.content)
            : (normalizeString(data.intro) ? [{ title: '', content: normalizeString(data.intro) }] : []),
        structureDesc: normalizeString(data.structureDesc),
        structureRows: Array.isArray(data.structureRows)
            ? data.structureRows.map(r => ({ category: normalizeString(r?.category), credits: normalizeString(r?.credits) })).filter(r => r.category || r.credits)
            : [],
        coreGroups: Array.isArray(data.coreGroups)
            ? data.coreGroups.map(g => ({
                grade: normalizeString(g?.grade),
                courses: Array.isArray(g?.courses)
                    ? g.courses.map(c => ({
                        code: normalizeString(c?.code),
                        name: normalizeString(c?.name),
                        desc: normalizeString(c?.desc),
                        meta: normalizeString(c?.meta)
                    })).filter(c => c.code || c.name || c.desc)
                    : []
            })).filter(g => g.grade || g.courses.length)
            : [],
        specCredits: normalizeString(data.specCredits),
        specRequirement: normalizeString(data.specRequirement),
        specDesc: normalizeString(data.specDesc),
        resources: normalizeMultiLine(data.resources),
        prospect: normalizeMultiLine(data.prospect)
    };
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
        const { images = [], textBlocks = [] } = body;

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传专业手册或课程目录（图片或PDF）' }, 400);
        }

        const prompt = `
你是一位资深的留学学业规划专家。请仔细阅读提供的专业手册 / 课程目录（图片或文档），提取该专业的真实信息，输出符合以下规范的结构化「学习指南」数据。

【重要】所有输出必须基于上传文件中的实际内容。文件信息不足时可合理推断，但优先使用文件中明确提供的内容，不要编造具体的课程代码、学分数字等。

【输出格式】严格的JSON，字段如下：
{
  "schoolZh": "学校中文名",
  "schoolEn": "学校英文名",
  "majorZh": "专业中文全称",
  "majorEn": "专业英文全称/缩写",
  "mode": "修读模式（如：全日制，四年）",
  "language": "授课语言",
  "credits": "毕业总学分",
  "internship": "实习要求（如：须完成至少两周实习）",
  "intro": [{"title":"小标题","content":"正文内容"}],
  "structureDesc": "学分结构说明（一句话概括整体学分构成）",
  "structureRows": [{"category":"学分范畴（如：必修课程）","credits":"学分数（如：60学分）"}],
  "coreGroups": [
    {"grade":"年级（如：一年级）","courses":[{"code":"课程代码（英文原文）","name":"课程名称（英文原文）","desc":"课程描述（中文）","meta":"备注（如：仅一年级入学）"}]}
  ],
  "specCredits": "专修/实习学分",
  "specRequirement": "专修/实习要求",
  "specDesc": "专修方向说明",
  "resources": "学习资源与规划建议，多段，每段用换行符\\n分隔",
  "prospect": "毕业前景与深造，多段，每段用换行符\\n分隔"
}

【各字段生成规范】
1. schoolZh/schoolEn/majorZh/majorEn：提取学校与专业的正式名称；schoolZh/schoolEn 为「大学/学院本身」的名称（如「布里斯托大学」/「University of Bristol」），须从文档标题或专业全称中提取，不要将「所属学院为XX」「所在学院：XX」这类描述性句子整体当作学校名，也不要带上「所属学院」「学院」等前缀词；majorEn 可保留英文缩写，如 "BSocSc(Psy)"。
2. mode/language/credits/internship：提取修读模式、授课语言、毕业总学分、实习要求；如文件未明确，可合理推断并在描述中体现。
3. intro：按文档中的小标题+正文结构完整提取，输出为 title（小标题）+ content（正文）数组；文档有几条就输出几条，不要概括或删减。
4. structureRows：按文件中的学分结构，拆分「范畴 + 学分」若干行（如必修/选修/通识/实习等），每行一条。
5. coreGroups：按年级分组（一年级/二年级/三年级/四年级），每组列出核心课程；每门课的 code、name 保留英文原文，desc 用中文简述课程内容与目标。
6. resources：学习资源（教材、平台、方法）与规划建议，2-3段。
7. prospect：毕业就业方向与深造路径，2-3段。

【语言规则】
- 学校名、专业名、课程代码（code）、课程名（name）保留英文原文
- 其余字段全部中文输出
- 专业术语可保留英文

【质量要求】
- 输出必须是合法JSON，不包含任何JSON外的解释性文字
- 不要编造不存在的课程代码或学分数字，信息不足时合理推断`;

        const result = await callAI({ prompt, images, textBlocks }, env);
        return createResponse({ data: normalizeStudyPlanGuide(result) });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
