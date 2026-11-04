import dotenv from 'dotenv';
import express from 'express';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { Buffer } from 'buffer';
import multer from 'multer';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.DASHSCOPE_MODEL || 'doubao-seed-2.1-lite';
const BASE_URL = process.env.DASHSCOPE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/plan/v3';

const app = express();
app.set('trust proxy', true);

// CORS support for cross-origin requests (Cloudflare Pages frontend + separate backend)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

app.use(express.json({ limit: '40mb' }));
app.use(express.static(__dirname));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: '50mb' }
});

const openai = process.env.DASHSCOPE_API_KEY
    ? new OpenAI({
        apiKey: process.env.DASHSCOPE_API_KEY,
        baseURL: BASE_URL
    })
    : null;

const JSON_ONLY_SYSTEM_PROMPT = [
    '你是一个用于教辅报告生成的后端 AI 助手。',
    '你的任务是根据输入材料输出严格合法的 JSON。',
    '不要输出 Markdown、不要输出代码块、不要输出解释性文字。',
    '如果信息不足，可以留空字符串、空数组，但不要编造具体分数、日期、课时或事实。',
    '输出字段必须和用户要求的 JSON 结构一致。'
].join('');

function ensureClient() {
    if (!openai) {
        const error = new Error('服务端缺少 DASHSCOPE_API_KEY，请先配置环境变量。');
        error.statusCode = 500;
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

function extractJsonObject(text) {
    if (!text) {
        throw new Error('AI 未返回内容');
    }

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

// 不可见字符全量清理：所有控制符(\p{Cc})、格式符(\p{Cf}，含零宽空格/双向控制/BOM/标签字符)、
// 变体选择符(\uFE00-\uFE0F)。这类字符 trim() 无法去除，整行只含它们时会渲染成「幽灵空行」。
// 保留 \n \r \t（换行与缩进语义），其余一律剥离。
const INVISIBLE_CHARS_RE = /[\p{Cc}\p{Cf}\uFE00-\uFE0F]/gu;
function stripInvisibleChars(value) {
    return String(value).replace(INVISIBLE_CHARS_RE, ch => (ch === '\n' || ch === '\r' || ch === '\t') ? ch : '');
}

function normalizeString(value) {
    return typeof value === 'string' ? stripInvisibleChars(value).trim() : '';
}

// 海报文案无图硬校验：识别文案里是否出现具体分数/等级字样。
// 只用于「本次没有附带识图图片」的场景——有图时分数来自真实识图，不做拦截。
function hasFabricatedGrade(text) {
    // 字母等级：Distinction/HD 全词匹配；单字母等级（A/A-等）要求紧跟在中文字后面（避免误伤 Plan B 这类英文搭配）
    const gradePattern = /(?:High\s*Distinction|Distinction|(?:^|[^\p{L}\p{N}])HD(?:$|[^\p{L}\p{N}])|[\u4e00-\u9fff]\s*[ABCDF][+\-]?)/iu;
    // 数字分数：78分 / 78 分 / 78/100（「30分钟」不误伤）
    const scorePattern = /\d{2,3}\s*(?:分(?!钟)|\/\s*100)/u;
    return gradePattern.test(text) || scorePattern.test(text);
}

// 性别指向称呼归一化：提示词拦不住模型偶发的「姐妹们」，直接替换成中性称呼。
// 先替换长词再替换短词，避免「姐妹们」被拆成「朋友们」。
function normalizeGenderedAddress(text) {
    return text
        .replace(/姐妹们|兄弟们|集美们|帅哥美女/g, '大家')
        .replace(/小姐姐|小哥哥/g, '同学')
        .replace(/姐妹|兄弟/g, '朋友')
        .replace(/宝妈|宝爸/g, '家长');
}

// 老师名去重：完整「名字 + 老师」在一条文案里只保留第一次出现，其余替换成「老师」，
// 避免同一条里老师名出现两三遍显得像模板。
function dedupeTeacherMentions(text, teacher) {
    const base = String(teacher || '').replace(/老师\s*$/, '').trim();
    if (!base) return text;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    const pattern = new RegExp(escaped + '\\s*老师', 'g');
    let seen = false;
    return text.replace(pattern, match => {
        if (!seen) { seen = true; return match; }
        return '老师';
    });
}

function normalizeStringArray(items) {
    return Array.isArray(items)
        ? items.map(normalizeString).filter(Boolean)
        : [];
}

function normalizeAssessmentArray(items) {
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

function normalizeWeekPlans(items) {
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

function scheduleSortKey(value) {
    const s = normalizeString(value);
    // 匹配 "26-09-27 17:56" / "2026-09-27 17:56" / "2026/9/27 17:56" 等；两位年份按 20YY 处理
    const m = s.match(/(\d{2,4})[-/年.](\d{1,2})[-/月.](\d{1,2})[日]?\s+(\d{1,2}):(\d{2})/);
    if (!m) return { hasDate: false, key: s };
    const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    return {
        hasDate: true,
        key: year * 1e8 + Number(m[2]) * 1e6 + Number(m[3]) * 1e4 + Number(m[4]) * 100 + Number(m[5])
    };
}

function normalizeScheduleRows(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            courseName: normalizeString(item?.courseName),
            startTime: normalizeString(item?.startTime),
            endTime: normalizeString(item?.endTime),
            duration: normalizeString(item?.duration)
        }))
        .filter(item => item.courseName || item.startTime || item.endTime || item.duration)
        // 强制按开始时间从早到晚排序（不能依赖模型自觉）
        .sort((a, b) => {
            const ka = scheduleSortKey(a.startTime);
            const kb = scheduleSortKey(b.startTime);
            if (ka.hasDate && kb.hasDate) return ka.key - kb.key;
            return normalizeString(a.startTime).localeCompare(normalizeString(b.startTime));
        });
}

function formatTextBlocks(textBlocks = []) {
    return Array.isArray(textBlocks)
        ? textBlocks
            .map(block => `附件名: ${normalizeString(block?.name)}\n附件内容:\n${normalizeString(block?.content)}`)
            .filter(Boolean)
            .join('\n\n---\n\n')
        : '';
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
        schoolAbbr: normalizeString(data.schoolAbbr),
        majorZh: normalizeString(data.majorZh),
        majorEn: normalizeString(data.majorEn),
        courseAbbr: normalizeString(data.courseAbbr),
        courseCode: normalizeString(data.courseCode),
        admissionCode: normalizeString(data.admissionCode),
        mode: normalizeString(data.mode),
        language: normalizeString(data.language),
        credits: normalizeString(data.credits),
        fieldTrip: normalizeString(data.fieldTrip),
        internship: normalizeString(data.internship),
        intro: Array.isArray(data.intro)
            ? data.intro.map(r => ({ title: normalizeString(r?.title), content: normalizeMultiLine(r?.content) })).filter(r => r.title || r.content)
            : (normalizeString(data.intro) ? [{ title: '', content: normalizeString(data.intro) }] : []),
        structureDesc: normalizeString(data.structureDesc),
        structureRows: Array.isArray(data.structureRows)
            ? data.structureRows.map(r => ({ category: normalizeString(r?.category), credits: normalizeString(r?.credits) })).filter(r => r.category || r.credits)
            : [],
        specializations: Array.isArray(data.specializations)
            ? data.specializations.map(r => ({ name: normalizeString(r?.name), content: normalizeString(r?.content) })).filter(r => r.name || r.content)
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
        specializationOptions: Array.isArray(data.specializationOptions)
            ? data.specializationOptions.map(r => ({ direction: normalizeString(r?.direction), suitableFor: normalizeString(r?.suitableFor), development: normalizeString(r?.development) })).filter(r => r.direction || r.suitableFor || r.development)
            : [],
        internshipCredits: normalizeString(data.internshipCredits),
        internshipYear1: normalizeString(data.internshipYear1),
        internshipSenior: normalizeString(data.internshipSenior),
        internshipAdvice: normalizeString(data.internshipAdvice),
        crossSchoolCourses: normalizeMultiLine(data.crossSchoolCourses),
        resources: normalizeMultiLine(data.resources),
        advice: Array.isArray(data.advice)
            ? data.advice.map(a => ({ title: normalizeString(a?.title), content: normalizeMultiLine(a?.content) })).filter(a => a.title || a.content)
            : [],
        prospectTable: Array.isArray(data.prospectTable)
            ? data.prospectTable.map(r => ({ field: normalizeString(r?.field), direction: normalizeString(r?.direction) })).filter(r => r.field || r.direction)
            : [],
        furtherStudy: normalizeMultiLine(data.furtherStudy),
        qualification: normalizeString(data.qualification),
        furtherStudyAdvice: normalizeMultiLine(data.furtherStudyAdvice)
    };
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
        schoolAbbr: normalizeString(data.schoolAbbr),
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
        advice: Array.isArray(data.advice) ? data.advice.map(a => ({ title: normalizeString(a?.title), content: normalizeMultiLine(a?.content) })).filter(a => a.title || a.content) : []
    };
}

// disableThinking 默认 true：与线上 functions 的无条件 arkThinking(baseUrl) 保持一致。
// 火山 doubao-seed 2.x 默认开深度思考，单个请求要 60~95s，会撞 Cloudflare 边缘 100s 超时（524）；
// 关掉后实测 5~20s，输出质量相当。需要思考的个别场景再显式传 false。
async function askQwenForJson({ prompt, images = [], textBlocks = [], temperature = 0.2, disableThinking = true }) {
    ensureClient();

    const textParts = [prompt];
    if (textBlocks && textBlocks.length > 0) {
        textParts.push('\n\n以下是用户提供的文本内容：');
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

    const requestParams = {
        model: MODEL,
        temperature,
        max_tokens: 8192,
        messages: [
            { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
            { role: 'user', content }
        ]
    };
    // 思考开关按供应商分支：
    // - 火山方舟 doubao-seed 2.x 用 thinking:{type:'disabled'}，默认开思考会让长任务超过 Cloudflare 边缘 100s 超时（524）
    // - 百炼 qwen3 系列用 enable_thinking:false（布尔），非流式请求不关会因「思考模式仅支持流式」直接报错
    const isVolces = /volces\.com/i.test(String(BASE_URL));
    if (disableThinking) {
        if (isVolces) requestParams.thinking = { type: 'disabled' };
        else requestParams.enable_thinking = false;
    }

    // 若所选模型不支持思考开关参数，自动退回普通调用
    const createCompletion = async params => {
        try {
            return await openai.chat.completions.create(params);
        } catch (error) {
            if (params.thinking === undefined && params.enable_thinking === undefined) throw error;
            const fallback = { ...params };
            delete fallback.thinking;
            delete fallback.enable_thinking;
            return await openai.chat.completions.create(fallback);
        }
    };

    const completion = await createCompletion(requestParams);

    return extractJsonObject(toMessageText(completion.choices?.[0]?.message?.content));
}

app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        model: MODEL,
        configured: Boolean(process.env.DASHSCOPE_API_KEY)
    });
});

app.post('/api/ai/course-plan', async (req, res, next) => {
    try {
        const extractedText = normalizeString(req.body?.extractedText);
        if (!extractedText) {
            return res.status(400).json({ error: '缺少大纲文本内容' });
        }

        const prompt = `
请根据下面的课程大纲/课程说明内容，提炼并补全课程规划表单。

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

原始材料：
${extractedText.slice(0, 20000)}

请输出 JSON，结构如下：
{
  "courseCode": "",
  "courseName": "",
  "teacherName": "",
  "courseIntro": "",
  "difficulty": {
    "knowledgeDepth": "",
    "practicalReq": "",
    "assessmentDifficulty": "",
    "workload": ""
  },
  "learningOutcomes": ["", ""],
  "assessments": [
    {
      "name": "",
      "type": "",
      "ddl": "",
      "summary": ""
    }
  ],
  "weekPlans": [
    {
      "week": "",
      "focus": "",
      "activities": "",
      "assessment": ""
    }
  ],
  "learningSuggest": ""
}

要求：
1. courseIntro 用自然中文概括课程介绍。
2. learningOutcomes 输出 3-8 条适合直接展示的中文学习成果。
3. assessments 尽量从材料中提取考核方式；没有明确 ddl 就留空。
4. weekPlans 可基于课程节奏合理整理为最多 12 周的周计划。
5. 不要输出结构外字段。`;

        const result = await askQwenForJson({ prompt });

        res.json({
            data: {
                courseCode: normalizeString(result.courseCode),
                courseName: normalizeString(result.courseName),
                teacherName: normalizeString(result.teacherName),
                courseIntro: normalizeString(result.courseIntro),
                difficulty: {
                    knowledgeDepth: normalizeString(result?.difficulty?.knowledgeDepth),
                    practicalReq: normalizeString(result?.difficulty?.practicalReq),
                    assessmentDifficulty: normalizeString(result?.difficulty?.assessmentDifficulty),
                    workload: normalizeString(result?.difficulty?.workload)
                },
                learningOutcomes: normalizeStringArray(result.learningOutcomes),
                assessments: normalizeAssessmentArray(result.assessments),
                weekPlans: normalizeWeekPlans(result.weekPlans),
                learningSuggest: normalizeString(result.learningSuggest)
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/course-plan-new', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        const formContext = req.body?.context || {};
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传图片或PDF文件' });
        }

        const lessonCount = Number(formContext.lessonCount) || 15;
        const plannedHours = formContext.plannedHours || '15小时';
        const tutorType = formContext.tutorType || '包课辅导';

        const prompt = `
你是一位资深的课程规划专家。请仔细阅读提供的课程大纲图片和文档，提取其中的实际内容，输出符合以下规范的结构化课程规划。

【重要】所有输出内容必须基于上传文件中的实际课程信息，不要套用统一模板。如果文件中信息不足，可以合理推断，但优先使用文件中明确提供的内容。

【当前规划上下文】
- 辅导类型：${tutorType}
- 规划课时：${plannedHours}
- 课节数：${lessonCount}次课

【输出格式】严格的JSON，字段如下：
{
  "courseCode": "课程代码（英文原文）",
  "courseName": "课程名称（英文原文）",
  "courseDesc": "课程介绍（中文120-180字）",
  "focusPoints": "重点领域（中文，每行一条）",
  "difficultyPoints": "难点分析（中文，每行一条）",
  "assessments": [{"seq":"1","name":"考核名称（英文原文）","detail":"考核详情（中文，含权重、DDL、AI政策）","weight":"占比","ddl":"截止日期"}],
  "plans": [{"session":"1","content":"课程内容（中文，含Week周次+考核联动）","goal":"学习目标（中文）","hours":"1h"}],
  "advices": "学习建议（中文，分条目）"
}

【各字段生成规范】

1. courseCode：直接提取课程代码，如FINS2643，保持英文
2. courseName：直接提取课程名称英文原文，不要翻译
3. courseDesc（课程介绍，120-180字，至少4个完整句子）：
   - 【重要】必须基于上传文件中的实际课程内容，直接反映该课程的真实定位和内容，不要套用通用模板或示例中的固定内容
   - 根据文件中提供的课程信息组织内容，突出该课程的独特性
   - 如果文件信息有限，可以基于课程名称和代码合理推断，但不要编造具体的框架名、知识领域等
   - 可以包含：课程定位、培养目标、核心内容领域、课程价值等要素，但具体结构应根据文件实际内容灵活调整

4. focusPoints（重点领域，必须4条，无法提取时合理推断）：
   - 【重要】无论材料是否完整，必须输出4条重点！如果材料信息不足，基于课程名称和类型合理推断核心重点
   - 每条格式："领域+核心动作"，如"澳大利亚财务规划的法律与监管框架"
   - 聚焦维度：核心知识模块、监管框架、技术方法、道德标准
   - 示例："财务规划的法律与合规框架"、"行为金融学在客户沟通中的应用"、"税务与养老金规划核心规则"、"保险产品分析与配置方法"

5. difficultyPoints（难点分析，必须4条，无法提取时合理推断）：
   - 【重要】无论材料是否完整，必须输出4条难点！如果材料信息不足，基于课程类型推断学生可能的学习难点
   - 每条格式："高阶认知动作+复杂任务"，如"整合多领域知识制定合规的个人财务计划"
   - 聚焦维度：知识整合、理论转化、批判性思维、框架应用
   - 示例："整合税务、保险、养老金制定综合财务计划"、"将行为金融学理论转化为客户沟通策略"、"在约束条件下权衡不同财务决策方案"、"理解并应用全生命周期罗盘框架"

6. assessments（考核项，按大纲提取）：
   - name：保留考核名称英文原文，如"Quizzes"、"Blog"、"Assignment"
   - detail：中文描述，必须按优先级包含以下要素：
     ① 【优先】字数要求或考试时长：如果材料中提到字数（如"800字"、"1500 words"、"2000字"）或时长（如"40分钟"、"2小时"），必须首先写入
     ② 考核形式：如"在线测验"、"个人博客"、"期末论文"
     ③ 权重占比：如"占20%"
     ④ 具体安排：如次数、时间分布
     ⑤ AI政策说明：如"禁用AI"、"允许简单编辑"
     - 示例1：{"name":"Quizzes","detail":"共3次在线测验，每次40分钟。Quiz1(7%) Week4；Quiz2(7%) Week8；Quiz3(6%) Week10。禁用AI。","weight":"20%"}
     - 示例2：{"name":"Blog","detail":"两次博客，每次800-1000字。Blog1(15%) Week4提交；Blog2(15%) Week8提交。允许简单编辑，禁用AI生成。","weight":"30%"}
     - 示例3：{"name":"Assignment","detail":"期末论文，2500-3000字，2小时限时。占20%，Week11提交。禁用AI。","weight":"20%"}
   - weight：占比格式如"20%"
   - ddl：截止日期，格式规则：
     * 如果有具体日期+周次：写"日期 + Week X"，如"3月15日 Week 4 周五5pm"
     * 如果只有周次：写"Week 4 周五5pm"
     * 如果只有日期：写"3月15日"
     * 如果无法提取：填写"TBD"

7. plans（辅导规划，固定${lessonCount}次课，对应${plannedHours}总课时）：
   ${tutorType === '考前突击' ? `
   - 【考前突击模式】不联动考核项，采用三段式冲刺结构
   - 三段式课时分配（必须严格遵循）：
     ① 知识点梳理：前${Math.ceil(lessonCount * 0.4)}次课——按模块快速梳理全部核心知识点，建立完整知识框架
     ② 重难点讲解：中间${Math.ceil(lessonCount * 0.3)}次课——针对高频考点和易错难点深度剖析，配合典型例题
     ③ 习题练习：最后${lessonCount - Math.ceil(lessonCount * 0.4) - Math.ceil(lessonCount * 0.3)}次课——真题实战+模拟测试+查漏补缺
   - content格式："标签：内容A+内容B+内容C"，标签根据所属阶段使用"知识点梳理"、"重难点讲解"或"习题练习"，用"+"连接该课涉及的多个具体内容
   - goal格式："掌握/能做..."，聚焦应试能力，如"能独立完成综合题"、"掌握XX题型的解题套路"
   - hours：格式为"1h"或"1.5h"或"2h"，每次1-2小时
   - 参考示例：
     * session1: "知识点梳理：监管框架基础+行为金融学概念+合规要求"
     * session${Math.ceil(lessonCount * 0.4)}: "重难点讲解：税务抵扣规则+养老金计算+保险配置策略"
     * session${lessonCount - 1}: "习题练习：综合真题模拟+案例分析题+计算题实战"
     * session${lessonCount}: "习题练习：考前冲刺+高频错题复盘+押题预测"` : `
   - 【核心要求】每次课必须联动考核项备考！
   - content格式："知识点名称（Week X）+ 考核联动内容"
   - 考核联动规则：
     * Quiz前1-2次课：末尾加"+ QuizX备考"
     * Blog截止周的课：末尾加"+ BlogX辅导"
     * Assignment前1-2次课：末尾加"+ Assignment专项辅导"
     * 无考核的课：只写"知识点名称（Week X）"
   - goal格式：明确可达成的学习目标，如"掌握监管地图"、"理解混合策略"、"能独立完成测验题型"
   - hours：格式为"1h"或"1.5h"或"2h"，每次1-2小时
   - 内容分配：前${Math.max(1, lessonCount - 3)}-${Math.max(1, lessonCount - 2)}次课覆盖知识点，最后2-3次课总复习+备考
   - 参考示例：
     * session4: "住房所有权与消费信贷（Week 4）+ Quiz1备考"
     * session6: "期中复盘 + Learning Blog1辅导"
     * session10: "职业道德与专业标准（Week 10）+ Quiz3备考"
     * session${lessonCount - 1}: "总复习 + 期末答疑"
     * session${lessonCount}: "考前冲刺 + 查漏补缺"`}

8. advices（学习建议，5-6条）：
   - 分三类组织：①资源推荐（教材名、作者、核心资源）②学习方法（费曼学习法、小组讨论、知识地图）③实战建议（关注行业新闻、定期复盘）
   - 每条以 emoji 开头增加可读性
   - 每条建议具体、可执行，避免空泛
   - 格式示例："🗺️ 建立'知识地图'：用 Whole-life Compass 框架将各模块串联，避免碎片化。"

【语言规则】
- courseCode、courseName、assessments[].name 保持英文原文
- 其余所有字段全部使用中文输出
- 专业术语可保留英文，如"Whole-life Compass"、"ASIC"、"APRA"

【质量要求】
- 不要编造不存在的信息，信息不足时基于课程类型合理推断
- plans必须严格联动考核项的时间节点
- 输出必须是合法JSON，不要包含任何JSON外的解释性文字`;

        const result = await askQwenForJson({ prompt, images, textBlocks });

        res.json({
            data: {
                courseCode: normalizeString(result.courseCode),
                courseName: normalizeString(result.courseName),
                courseDesc: normalizeString(result.courseDesc),
                focusPoints: normalizeString(result.focusPoints) || '核心知识模块与监管框架\n技术方法与应用实践\n合规标准与道德要求\n客户沟通与参与策略',
                difficultyPoints: normalizeString(result.difficultyPoints) || '整合多领域知识制定合规方案\n将理论转化为实践策略\n批判性思维与复杂决策\n框架应用与灵活调整',
                assessments: Array.isArray(result.assessments) ? result.assessments.map(a => ({
                    seq: normalizeString(a?.seq),
                    name: normalizeString(a?.name),
                    detail: normalizeString(a?.detail),
                    weight: normalizeString(a?.weight),
                    ddl: normalizeString(a?.ddl) || 'TBD'
                })) : [],
                plans: Array.isArray(result.plans) ? result.plans.map(p => ({
                    session: normalizeString(p?.session),
                    content: normalizeString(p?.content),
                    goal: normalizeString(p?.goal),
                    hours: normalizeString(p?.hours) || '1h'
                })) : [],
                advices: normalizeString(result.advices)
            }
        });
    } catch (error) {
        next(error);
    }
});

// 学习规划 - 模板①「学习指南」
app.post('/api/ai/study-plan/guide', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传专业手册或课程目录（图片或PDF）' });
        }

        const prompt = `
你是一位资深的留学学业规划专家。请仔细阅读提供的专业手册 / 课程目录（图片或文档），提取该专业的真实信息，输出符合以下规范的结构化「学习指南」数据。

【重要】所有输出必须基于上传文件中的实际内容。文件信息不足时可合理推断，但优先使用文件中明确提供的内容，不要编造具体的课程代码、学分数字等。

【输出格式】严格的JSON，字段如下：
{
  "schoolZh": "学校中文名",
  "schoolEn": "学校英文名",
  "schoolAbbr": "学校英文缩写（如：EdUHK、UCL、Leeds，信息不足可留空）",
  "majorZh": "专业中文全称",
  "majorEn": "专业英文全称/缩写",
  "courseAbbr": "课程简称（如：BSocSc(Psy)，信息不足可留空）",
  "courseCode": "课程编号（如：A4B075，信息不足可留空）",
  "admissionCode": "联招/招生编号（如：JS8651，信息不足可留空）",
  "mode": "修读模式（如：全日制，四年）",
  "language": "授课语言",
  "credits": "毕业总学分",
  "fieldTrip": "实地考察要求（信息不足可留空）",
  "internship": "实习要求（如：须完成至少两周实习）",
  "intro": [{"title":"小标题（如：课程定位与培养目标）","content":"正文内容，多段用换行符\\n分隔"}],
  "structureDesc": "学分结构说明（一句话概括整体学分构成）",
  "structureRows": [{"category":"学分范畴（如：必修课程）","credits":"学分数（如：60学分）"}],
  "specializations": [{"name":"专修范畴名","content":"核心内容"}],
  "coreGroups": [
    {"grade":"年级（如：一年级）","courses":[{"code":"课程代码（英文原文）","name":"课程名称（英文原文）","desc":"课程描述（中文）","meta":"备注（如：仅一年级入学）"}]}
  ],
  "specializationOptions": [{"direction":"专修方向","suitableFor":"适合对象","development":"发展方向"}],
  "internshipCredits": "实习学分",
  "internshipYear1": "一年级入学实习要求",
  "internshipSenior": "高年级入学实习要求",
  "internshipAdvice": "实习建议",
  "crossSchoolCourses": "跨学院核心课程（必修），每条一行，用换行符\\n分隔，格式如：组件一（CFA1001）：基本法与国家安全教育",
  "resources": "学习资源（课程主任/课程查询/教学地点等），多条用换行符\\n分隔",
  "advice": [{"title":"阶段标题（如：大一阶段：打好基础）","content":"该阶段建议，多条用换行符\\n分隔"}],
  "prospectTable": [{"field":"就业领域（如：教育领域）","direction":"具体方向"}],
  "furtherStudy": "深造路径，每条一行，用换行符\\n分隔",
  "qualification": "专业资格（可申请的专业学会/认证，信息不足可合理推断）",
  "furtherStudyAdvice": "深造准备建议，每条一行，用换行符\\n分隔"
}

【各字段生成规范】
1. schoolZh/schoolEn/schoolAbbr/majorZh/majorEn：提取学校与专业的正式名称；schoolZh/schoolEn 为「大学/学院本身」的名称（如「布里斯托大学」/「University of Bristol」），须从文档标题或专业全称中提取，不要将「所属学院为XX」「所在学院：XX」这类描述性句子整体当作学校名，也不要带上「所属学院」「学院」等前缀词；schoolAbbr 为学校英文缩写（如 EdUHK、UCL、Leeds），无法确定时留空；majorEn 可保留英文缩写，如 "BSocSc(Psy)"。
2. courseAbbr/courseCode/admissionCode：提取课程简称、课程编号、联招/招生编号；文件中未明确时留空字符串，不要编造编号。
3. mode/language/credits/fieldTrip/internship：提取修读模式、授课语言、毕业总学分、实地考察、实习要求；如文件未明确，可合理推断并在描述中体现。
4. intro：按文档中的小标题+正文结构完整提取，输出为 title（小标题）+ content（正文）数组；如文档有4个小标题则输出4条，不要概括或删减。
5. structureDesc/structureRows：structureDesc 一句话概括整体学分构成；structureRows 按文件中的学分结构拆分「范畴 + 学分」若干行。
6. specializations：提炼该专业的主要专修/学习范畴（2-4个），每个含 name（范畴名）与 content（核心内容）。
7. coreGroups：按年级分组（一年级/二年级/三年级/四年级），每组列出核心课程；每门课的 code、name 保留英文原文，desc 用中文简述课程内容与目标。
8. specializationOptions：列出该专业可选择的专修方向（通常3个），每个含 direction（专修方向）、suitableFor（适合对象）、development（发展方向）。优先从文档提取；文档未明确时，结合该专业性质合理生成典型专修方向（如心理学可分教育心理学/临床心理学/发展心理学），不要留空。
9. internshipCredits/internshipYear1/internshipSenior/internshipAdvice：实习学分、一年级入学实习要求、高年级入学实习要求、实习建议。优先从文档提取；文档未明确时，结合专业性质合理生成典型实习要求与建议，不要留空。
10. crossSchoolCourses：跨学院核心课程（必修）。每条一行，格式为「组件X（课程代码）：课程名称」，如「组件一（CFA1001）：基本法与国家安全教育」。优先从文档提取；文档未明确时，结合专业性质合理生成典型跨学院/通识必修课程，不要留空。
11. resources：学习资源（课程主任、课程查询、教学地点、第二主修等），每条一行。
12. advice：按学习阶段（大一/大二/大三/大四或通用阶段）给出规划建议，每条含 title 与 content（多条用换行分隔）。
13. prospectTable/furtherStudy/qualification/furtherStudyAdvice：就业前景表（领域+方向）、深造路径、专业资格、深造准备建议。

【语言规则】
- 学校名、专业名、课程代码（code）、课程名（name）保留英文原文
- 其余字段全部中文输出
- 专业术语可保留英文

【质量要求】
- 输出必须是合法JSON，不包含任何JSON外的解释性文字
- 不要编造不存在的课程代码或学分数字，信息不足时合理推断`;

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({ data: normalizeStudyPlanGuide(result) });
    } catch (error) {
        next(error);
    }
});

// 学习规划 - 模板②「课程规划方案」
app.post('/api/ai/study-plan/plan', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传专业手册或课程目录（图片或PDF）' });
        }

        const prompt = `
你是一位资深的留学学业规划专家。请仔细阅读提供的专业手册 / 课程目录（图片或文档），提取该专业的真实课程信息，输出符合以下规范的结构化「课程规划方案」数据。

【重要】所有输出必须基于上传文件中的实际内容。文件信息不足时可合理推断，但优先使用文件中明确提供的内容，不要编造具体的课程代码。

【输出格式】严格的JSON，字段如下：
{
  "schoolZh": "学校中文名",
  "schoolEn": "学校英文名",
  "schoolAbbr": "学校英文缩写（如：UCL、Leeds，信息不足可留空）",
  "majorFullName": "专业全称（英文，如：Archaeology and Anthropology BA）",
  "degreeName": "学位名称（中文，如：考古学与人类学学士学位）",
  "intro": [{"title":"小标题（如：课程定位与培养目标）","content":"正文内容，多段用换行符\\n分隔"}],
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
1. schoolZh/schoolEn/schoolAbbr/majorFullName/degreeName：提取学校与专业的正式名称；schoolZh/schoolEn 为「大学/学院本身」的名称（如「布里斯托大学」/「University of Bristol」），须从文档标题或专业全称中提取，不要将「所属学院为XX」「所在学院：XX」这类描述性句子整体当作学校名，也不要带上「所属学院」「学院」等前缀词；schoolAbbr 为学校英文缩写（如 UCL、Leeds），无法确定时留空；majorFullName 保留英文原文，degreeName 输出中文。
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

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({ data: normalizeStudyPlanPlan(result) });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/final-report', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const pdfExtraText = req.body?.context?.pdfExtraText || '';
        if (!images.length && !pdfExtraText) {
            return res.status(400).json({ error: '请至少上传一张截图或 PDF 文档' });
        }

        const prompt = `
请根据以下材料为结课报告表单生成可直接回填的内容。

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

${pdfExtraText ? `以下是 PDF 文档提取的文本内容（请以其为主要分析依据）：\n${pdfExtraText.slice(0, 8000)}\n` : ''}

请输出 JSON，必须包含所有字段且每个字段都必须有具体内容（不能为空字符串）：
{
  "learningGoal": "学习目标：描述学生本课程的学习目标",
  "achievementSummary": "学习成果总结：总结学生取得的学习成果和进步",
  "finalGrade": "总成绩：从材料中提取成绩，若无则写'良好'或'合格'",
  "gradeComment": "成绩评语：对成绩的评价说明",
  "teacherMessage": "讲师寄语：以讲师口吻给学生写一段寄语，鼓励继续努力",
  "futureSuggestions": "下学期学习建议：通用的成长鼓励类建议，侧重综合素养提升",
  "assistantMessage": "教辅寄语：以教辅老师口吻写一段寄语，肯定学生的学习态度",
  "performanceDesc": "学习表现描述：分析学生的学习态度、课堂参与度等表现"
}

要求：
1. 输出适合正式中文报告的语气。
2. 每个字段都必须有实质内容，不能留空。
3. teacherMessage 和 assistantMessage 必须是完整的寄语段落，至少50字。
4. achievementSummary 必须详细总结学习成果，至少50字。
5. 若截图中没有明确成绩，finalGrade 可写"良好"或"合格"，不要编造具体分数。
6. performanceDesc 聚焦学习表现分析，不要和其他字段重复过多。
7. futureSuggestions：该课程已结束，请输出通用的成长鼓励类建议，侧重综合素养提升和未来学业展望。
8. 不要输出结构外字段。
9. ${pdfExtraText ? '优先根据 PDF 文本内容分析，截图和 PDF 信息冲突时以 PDF 为准。' : '根据截图内容分析生成。'}
`;

        const result = await askQwenForJson({ prompt, images });

        res.json({
            data: {
                learningGoal: normalizeString(result.learningGoal),
                achievementSummary: normalizeString(result.achievementSummary),
                finalGrade: normalizeString(result.finalGrade),
                gradeComment: normalizeString(result.gradeComment),
                teacherMessage: normalizeString(result.teacherMessage),
                futureSuggestions: normalizeString(result.futureSuggestions),
                assistantMessage: normalizeString(result.assistantMessage),
                performanceDesc: normalizeString(result.performanceDesc)
            }
        });
    } catch (error) {
        next(error);
    }
});

// 结课报告（多门）字段规整
function normalizeMultiCourseOutcomeArray(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map(item => ({
            subtitle: normalizeString(item?.subtitle),
            content: normalizeString(item?.content)
        }))
        .filter(item => item.subtitle || item.content);
}

function normalizeFinalReportMulti(data = {}) {
    return {
        studentName: normalizeString(data.studentName),
        university: normalizeString(data.university),
        periodStart: normalizeString(data.periodStart),
        periodEnd: normalizeString(data.periodEnd),
        attendanceRate: normalizeString(data.attendanceRate),
        attendanceDesc: normalizeString(data.attendanceDesc),
        taskCompletionRate: normalizeString(data.taskCompletionRate),
        taskCompletionDesc: normalizeString(data.taskCompletionDesc),
        interactionRate: normalizeString(data.interactionRate),
        interactionDesc: normalizeString(data.interactionDesc),
        reportOverview: normalizeString(data.reportOverview),
        courses: Array.isArray(data.courses)
            ? data.courses.map(c => ({
                courseName: normalizeString(c?.courseName),
                hours: normalizeString(c?.hours),
                orderNumber: normalizeString(c?.orderNumber),
                learningGoal: normalizeString(c?.learningGoal),
                outcomes: normalizeMultiCourseOutcomeArray(c?.outcomes),
                totalScore: normalizeString(c?.totalScore),
                teacherMessage: normalizeString(c?.teacherMessage)
            })).filter(c => c.courseName || c.orderNumber || c.learningGoal || c.outcomes.length || c.totalScore || c.teacherMessage)
            : [],
        suggestionsIntro: normalizeString(data.suggestionsIntro),
        suggestions: normalizeMultiCourseOutcomeArray(data.suggestions),
        assistantMessage: normalizeString(data.assistantMessage)
    };
}

app.post('/api/ai/final-report-multi', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请至少上传一张截图或 PDF 文档' });
        }

        const context = req.body?.context || {};
        const courseCount = Number(context.courseCount) > 0 ? Number(context.courseCount) : 1;

        const prompt = `
请根据以下材料为「结课报告（多门）」表单生成可直接回填的内容。该报告覆盖学生一个辅导周期内的多门课程。

当前表单上下文（已有信息，缺失的请补充）：
${JSON.stringify(context, null, 2)}

请输出 JSON，结构如下：
{
  "studentName": "学生姓名，若材料可识别则填，否则留空字符串",
  "university": "在读院校，若材料可识别则填，否则留空字符串",
  "periodStart": "辅导周期开始，如 2024.09，若可识别则填，否则留空字符串",
  "periodEnd": "辅导周期结束，如 2025.01，若可识别则填，否则留空字符串",
  "attendanceRate": "出勤率，如 100%，若可识别则填，否则留空字符串",
  "attendanceDesc": "出勤说明（一句话）",
  "taskCompletionRate": "任务完成率，若可识别则填，否则留空字符串",
  "taskCompletionDesc": "任务完成说明（一句话）",
  "interactionRate": "课堂互动率，若可识别则填，否则留空字符串",
  "interactionDesc": "课堂互动说明（一句话）",
  "reportOverview": "报告概述，总结学生在包课护航计划中的整体学习表现与服务成果，遵循学术诚信原则",
  "courses": [
    {
      "courseName": "课程名称",
      "hours": "该课程课时数，如 24，若不可识别留空",
      "orderNumber": "订单编号，若不可识别留空",
      "learningGoal": "学习目标回顾（一段完整描述）",
      "outcomes": [ { "subtitle": "成果小标题，如：数学基础与分析", "content": "该成果的具体内容描述" } ],
      "totalScore": "总成绩，如 60 / 100，若不可识别留空",
      "teacherMessage": "讲师寄语，以讲师口吻写至少两段，用 \\n 分隔段落，每段至少40字"
    }
  ],
  "suggestionsIntro": "下学期学习建议的整体概述（一段话）",
  "suggestions": [ { "subtitle": "建议小标题", "content": "具体建议内容" } ],
  "assistantMessage": "教辅寄语，以教辅老师口吻写多段，用 \\n 分隔段落，语气亲切可带 emoji"
}

要求：
1. courses 数组的课程数量以材料中实际能识别到的课程为准；材料未指明时输出 ${courseCount} 门课程的内容。
2. 每门课程的 learningGoal、outcomes（至少 3 条）、teacherMessage 必须有实质内容，不能留空。
3. 成绩、课时、订单编号等客观数据若材料中没有，留空字符串，不要编造。
4. 输出适合正式中文报告的语气，不要输出结构外字段。
5. ${textBlocks.length ? '优先根据 PDF/文本附件内容分析，截图和附件信息冲突时以附件为准。' : '根据截图内容分析生成。'}
`;

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({ data: normalizeFinalReportMulti(result) });
    } catch (error) {
        next(error);
    }
});

// 结课报告（多门）· 单门课程识别：只输出学习目标回顾 / 学习成果概述 / 讲师寄语
app.post('/api/ai/final-report-multi/course', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请至少上传一张截图或 PDF 文档' });
        }

        const context = req.body?.context || {};
        const prompt = `
请根据以下材料，为「结课报告」中这一门课程生成报告内容。

课程上下文（可能部分为空，可从材料中识别补充）：
${JSON.stringify(context, null, 2)}

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

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({
            data: {
                learningGoal: normalizeString(result.learningGoal),
                outcomes: normalizeMultiCourseOutcomeArray(result.outcomes),
                teacherMessage: normalizeString(result.teacherMessage)
            }
        });
    } catch (error) {
        next(error);
    }
});

// 结课报告（多门）· 教辅寄语生成（纯文本，无需上传材料）
app.post('/api/ai/final-report-multi/assistant', async (req, res, next) => {
    try {
        const context = req.body?.context || {};
        const previousMessage = normalizeString(context.previousMessage);

        const prompt = `
请为「结课报告」生成一段教辅寄语（以教辅老师/学管师口吻写给学生的学期总结寄语）。

上下文信息：
${JSON.stringify({
    studentName: context.studentName || '',
    university: context.university || '',
    attendanceRate: context.attendanceRate || '',
    taskCompletionRate: context.taskCompletionRate || '',
    interactionRate: context.interactionRate || '',
    courses: Array.isArray(context.courses) ? context.courses : []
}, null, 2)}

要求：
1. 寄语写多段，用 \\n 分隔段落，总长度 150-300 字。
2. 风格：${normalizeString(context.style) || '亲切自然，鼓励为主'}。
3. ${previousMessage ? '用户对上一版不满意，请确保与之前的版本在语气、开头、用词上明显不同。之前版本：\n' + previousMessage.slice(0, 500) : '语气亲切，可适当使用 emoji。'}
4. 结合学生的学习表现与课程情况，给予肯定与下学期展望。
5. 上下文中为空的字段直接略过，不要在寄语里出现 [studentName]、[courses] 之类的占位符或方括号。
6. 请输出 JSON：{ "assistantMessage": "寄语内容" }，不要输出结构外字段。
`;

        const result = await askQwenForJson({ prompt });
        res.json({ data: { assistantMessage: normalizeString(result.assistantMessage) } });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/period-feedback/schedule', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传排课截图或PDF文件' });
        }

        const prompt = `
请从这些排课截图或PDF文件中提取排课记录，返回 JSON：
{
  "rows": [
    {
      "courseName": "",
      "startTime": "",
      "endTime": "",
      "duration": ""
    }
  ]
}

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

要求：
1. 课程名、开始时间、结束时间、时长均按截图/文档原样提取，不要改写。开始时间和结束时间必须包含日期（如 "26-09-27 17:56" 或 "2026-09-27 17:56"），不要只保留时刻。
2. rows 必须按「开始时间」的日期+时间从早到晚升序排列：先比日期、再比时刻，不要只按时刻排序。
3. 时长优先取表格中的「实际时长」列；只有当表中不存在实际时长列时才取「预计时长」。原样保留时长字符串（如 "0hr43.10min"）。
4. 截图里有多少条记录就输出多少条，不要合并、不要省略、不要补造不存在的排课记录；无法识别的字段留空字符串。`;

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({ data: { rows: normalizeScheduleRows(result.rows) } });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/period-feedback/feedback', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传反馈截图或PDF文件' });
        }

        const prompt = `
请根据这些课堂反馈/聊天记录截图或PDF文件，为阶段性反馈报告撰写四段文字。

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

请输出 JSON：
{
  "performance": "",
  "progress": "",
  "mastery": "",
  "suggestion": ""
}

各字段定位与写法：
- performance（平时课堂表现）：先一句概括整个阶段的互动状态（答疑接话、跟推导、专注度等），再用 1-2 个具体课堂场景佐证——把课次/周次自然揉进句子里（如「第四周讲两种存货系统时」「两次复习课上」），像老师写评语，不要写成「第X课：…」的清单。
- progress（当前辅导进度）：一段连贯的推进概述，**严禁写成「第X周（主题）→第X周（主题）」的逐周链条**。正确结构依次是：①一句总体跨度与完成状态（如「本阶段按 XX 课程的顺序推进，八次课从第1周 Lecture1 讲到了第7周 Lecture7A，各章核心内容已全部讲解完成」）；②一句平铺列举覆盖的知识点名称——「覆盖知识点包括 A、B、C、D」，只列名称本身，不加括号注释、不标周次；③一句交代特殊课型（如「其中两次是考前复习课，做了第1讲到第6讲的串讲」）；④一句说明考试安排是否确认。全段只允许出现「从第X讲到第X」这一个跨度锚点。
- mastery（课程掌握情况）：分「掌握扎实的部分」和「薄弱环节」两半连贯叙述，以能力表现为主线，不要按课次推进。扎实部分列举具体知识点并说明凭什么判断（「当堂就能接住」「能一步步推下去」「能独立写出」）；薄弱环节集中写具体卡点和表现（会判断错/书写不熟练/记忆模糊/尚未开始刷题）。周次/课次锚点全文最多 1-2 个且必须揉在句中（如「第三周的调整分录、第四周的 Inventory error 影响推导，当堂就能接住」），禁止「第X课后能…」「第X课后虽…」这种逐条挂课次的句式。
- suggestion（后续学习建议）：按优先级写成一串具体动作流（不用序号，用「先…，再…；…；最后…」衔接）：每个动作锚定材料里出现的具体名称（练习名、案例名、题库来源、章节），写明动作类型（补齐/重做/刷/背下来/重新走一遍/预习），需要记忆的明确说「要背」，最后可带一条考试相关提醒（如留意考试通知、尽早刷往年题）。

风格要求：
A. 每个字段都是连贯的书面散文段落，信息密度要高，每段约 100-180 字；全文禁止使用「→」箭头符号和「周次（主题注释）」式的括号配对；除 suggestion 可用「先/再/最后」衔接外，一律不用序号、不用分点符号、不用链式列举。
B. 专有名词、课程名、章节名、案例名保留原文（英文照写），这正是专业感的来源。
C. 语气是任课老师在写给家长/学生的阶段评语：肯定要具体（好在哪、凭什么），批评也要具体（卡在哪、什么表现），不用「表现良好」「继续努力」这类空话。

硬性约束：
一、严禁脑补：所有数字、用时、正确率、日期、专有名词、事例必须能在截图/文档中找到原文依据，材料没提的绝对不写（材料没说正确率就不能写正确率，没提格式规范就不能提）。可以重组语言、补充解释，但不得新增事实。
二、直接陈述事实与观点，正文中不要出现「截图」「材料」「隐含时间线」这类元叙述措辞。
三、以材料实际信息量为准：材料内容少时每段写 1-3 句即可，宁短勿编。
四、使用正式、自然、可直接给家长/学生查看的中文。`;

        const result = await askQwenForJson({ prompt, images, textBlocks });
        res.json({
            data: {
                performance: normalizeString(result.performance),
                progress: normalizeString(result.progress),
                mastery: normalizeString(result.mastery),
                suggestion: normalizeString(result.suggestion)
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/review-report/reason', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = formatTextBlocks(req.body?.textBlocks);
        const skippedFiles = normalizeStringArray(req.body?.skippedFiles);
        const existingReason = normalizeString(req.body?.context?.existingReason);

        if (!images.length && !textBlocks && !existingReason) {
            return res.status(400).json({ error: '请先提供原因分析材料或文本' });
        }

        const prompt = `
请根据售后复盘材料，为“原因分析”字段输出可直接回填的正式中文内容。

表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

当前文本材料：
${textBlocks || '无'}

当前已填写原因分析：
${existingReason || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

请输出 JSON：
{
  "reason": ""
}

要求：
1. 聚焦问题成因、沟通断点、流程缺口。
2. 使用 2-5 段、适合正式复盘报告。
3. 不要输出结构外字段。`;

        const result = await askQwenForJson({ prompt, images });
        res.json({ data: { reason: normalizeString(result.reason) } });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/review-report/process', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = formatTextBlocks(req.body?.textBlocks);
        const skippedFiles = normalizeStringArray(req.body?.skippedFiles);
        const existingProcess = normalizeString(req.body?.context?.existingProcess);
        const mode = normalizeString(req.body?.context?.processMode) || 'timeline';

        if (!images.length && !textBlocks && !existingProcess) {
            return res.status(400).json({ error: '请先提供过程材料或文本' });
        }

        const prompt = `
请根据售后复盘材料，生成“过程复盘”内容。

表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

当前文本材料：
${textBlocks || '无'}

当前已填写过程复盘：
${existingProcess || '无'}

未自动解析的附件：
${skippedFiles.join('；') || '无'}

当前展示模式：${mode}

请输出 JSON：
{
  "process": "",
  "conclusion": ""
}

要求：
1. 如果模式是 timeline，则 process 按“一行一个节点”输出，尽量带日期或阶段描述。
2. 如果模式是 text，则 process 输出自然段。
3. conclusion 输出复盘结论与后续建议，没有把握可留空。
4. 不要输出结构外字段。`;

        const result = await askQwenForJson({ prompt, images });
        res.json({
            data: {
                process: normalizeString(result.process),
                conclusion: normalizeString(result.conclusion)
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/essay-review', async (req, res, next) => {
    try {
        const images = Array.isArray(req.body?.images) ? req.body.images : [];
        const textBlocks = Array.isArray(req.body?.textBlocks) ? req.body.textBlocks : [];
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传论文截图或PDF文件' });
        }

        const prompt = `
你是一位资深的学术论文辅导专家。请根据上传的文件分析论文存在的问题并给出优化建议。

【输入说明】
上传的文件可能包含以下类型：
- 论文要求/评分标准：说明论文的写作要求、评分维度和标准
- 论文终稿：学生提交的论文原文
- 老师评语/Feedback：老师对论文的具体评价（可选）
- 学生分数/等级：可选

【分析逻辑】
原因分析(reasons)的依据：
- 主要依据：论文要求、评分标准（如有）、老师Feedback（如有）
- 对照对象：论文终稿的实际内容
- 分析方式：将论文终稿与要求/标准/反馈进行对比，找出差距和问题

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

【输出格式】严格的JSON，字段如下：
{
  "reasons": [{"title":"问题标题","desc":"问题描述","quote":"原文例证"}],
  "directions": [{"tag":"优化方向标签","desc":"具体优化建议"}],
  "reuseItems": [{"title":"可复用优化点标题","desc":"详细说明"}]
}

【各字段生成规范】

1. reasons（原因分析，3-5项）：
   - title：简明概括问题，如"论文结构缺乏逻辑主线"、"文献综述停留在描述层面"
   - desc：详细分析问题成因和影响，2-3句话
   - quote：【重要】从论文终稿中提取的有问题的具体语句/段落（如有），用于佐证问题；如果论文终稿中有明显问题，引用原文中的问题语句；如无明确原文例证则留空
   - 聚焦维度：结构逻辑、文献综述、论证深度、语言表达、格式规范
   - 分析依据：论文要求+评分标准+Feedback对照论文终稿

2. directions（优化方向，4-6项）：
   - tag：2-4字标签，如"逻辑架构"、"文献整合"、"论据强化"、"语言润色"
   - desc：具体的、可操作的优化建议，1-2句话
   - 每个方向应对应原因分析中的问题

3. reuseItems（后续写作可复用优化点，5-9项）：
   - title：方法论名称，如"文献聚类方法"、"论证三角法"、"批判性句式模板"
   - desc：详细说明该方法的操作方式和适用场景，1-2句话
   - 聚焦：可迁移到未来写作的通用方法和技巧

【质量要求】
- 所有内容使用中文输出
- 分析要具体、有针对性，避免空泛
- 不要编造论文中不存在的内容
- quote字段引用的必须是论文终稿中的原文，不是反馈意见
- 输出必须是合法JSON`;

        const result = await askQwenForJson({ prompt, images, textBlocks });

        res.json({
            data: {
                reasons: Array.isArray(result.reasons) ? result.reasons.map(r => ({
                    title: normalizeString(r?.title),
                    desc: normalizeString(r?.desc),
                    quote: normalizeString(r?.quote)
                })).filter(r => r.title || r.desc) : [],
                directions: Array.isArray(result.directions) ? result.directions.map(d => ({
                    tag: normalizeString(d?.tag),
                    desc: normalizeString(d?.desc)
                })).filter(d => d.tag || d.desc) : [],
                reuseItems: Array.isArray(result.reuseItems) ? result.reuseItems.map(item => ({
                    title: normalizeString(item?.title),
                    desc: normalizeString(item?.desc)
                })).filter(item => item.title || item.desc) : []
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/ai/poster-caption', async (req, res, next) => {
    try {
        const productType = normalizeString(req.body?.productType);
        const materialType = normalizeString(req.body?.materialType);
        const teacher = normalizeString(req.body?.teacher);
        const courseName = normalizeString(req.body?.courseName);
        const images = Array.isArray(req.body?.images)
            ? req.body.images.filter(url => typeof url === 'string' && url.startsWith('data:image/')).slice(0, 3)
            : [];
        if (!productType || !materialType) {
            return res.status(400).json({ error: '缺少产品类型或素材类型' });
        }

        const hasImages = images.length > 0;
        const prompt = `你是「万能班长」留学课业辅导品牌的社媒文案，负责写朋友圈可以直接发布的成品文案。

产品类型：${productType}
素材类型：${materialType}
辅导老师：${teacher || '（未填写）'}

请输出 JSON：{ "captions": ["", "", ""] }

【文案结构（标题行规则只约束第 1、3 条「品牌经典风」）】
1. 第 1、3 条的第一行（标题行）必须严格等于：1 个贴合语义的 emoji + 「${productType}」+「${materialType}」，顺序固定，不得写成其它产品类型或素材类型的字样（例如本次产品类型=毕业论文、素材类型=课后答疑 时，标题写成「💬毕业论文课后答疑」）。标题内不要空格、不要加 # 号。第 2 条的第一行自由发挥，完全不受标题行规则约束。
2. 品牌经典风（第 1、3 条）标题行之后写 4 行短句（整条共 5 行，与下方示例一致），每行 8-20 字。整个 caption 是一个多行字符串，行与行之间用换行符分隔。

【图片识图】
- 本条消息可能附带用户上传的课堂图片；如果附带了图片，请先读图，把图中“真实可见”的分数、等级（例如 78/100、Distinction、A）写进文案。
- 分数和等级只能来自图片；图片里没有分数就不要写具体分数，严禁编造。
- 没有附带图片时，正文里严禁出现任何具体分数或等级字样（78、89、A、A-、Distinction、HD 等都不行），无论写成已发生、承诺还是目标（「拿下」「锁死」「稳拿」「冲个 A」都算违规）；只能用「上岸」「高分」「拿捏」这类不落到具体分数等级的说法。

【必须融入的信息】
- 已填写辅导老师：整条文案里完整的「名字 + 老师」只出现 1 次（只占一行），同一行或后面再提到时一律只用「老师」两个字泛指，严禁把完整老师名写两遍。老师名字必须与提供的一字不差，不得漏字母、改拼或缩写（给到「Russell Feng 冯」就只能写「Russell Feng 冯老师」）。英文名直接连着「老师」写，不加空格（与下方示例一致，例如给到「Tilley」就写「Tilley老师」；若给到的名字本身已含「老师」则直接照用）。这是用户提供的事实，可以放心写；没有填写就一律不要编造。
- 严禁在文案里出现课程名称、课程代码（哪怕图片里能看到），一律用「这门课」「课程」泛指。

【一次生成 3 条文案：两条品牌经典风 + 一条元气热情风】
captions 数组必须按顺序给出 3 条，风格定义如下：
1. 第 1 条「品牌经典风」：严格参照下方品牌示例的语气、节奏和分行方式，标题行 + 4 行短句，稳重耐看。
2. 第 2 条「元气热情风」：情绪更饱满、更有号召感（如「闭眼冲」「稳了」「直接锁死」），节奏更跳跃，emoji 可用足 4 个，感叹号可以更多；第一行不用标题行，直接用情绪钩子或喊话开头；行数与品牌经典风不同（3-4 行），至少有一行把两件事写进同一句；严禁用「姐妹们」「兄弟们」这类性别称呼，喊人就用「大家」「同学们」。措辞必须尊重老师：严禁出现「甩锅」「丢给」「扔给」「推给」「包给」老师这类把功课、难题、责任推到老师身上的说法——老师是接住问题、带着学生解决的一方，不是被甩锅的一方。
3. 第 3 条「品牌经典风」：风格与第 1 条相同（标题行 + 4 行短句，同样参照下方示例），但内容必须和第 1 条完全不同——换一个切入角度（例如第 1 条从老师的动作/服务切入，第 3 条从学生的收获/场景切入），开头句式、用词、各行内容都不得与第 1 条雷同，严禁只换几个词交差。

【打破公式化结构（非常重要，三条都要做到）】
1. 第 2 条的行数、断句位置、信息出现顺序必须与两条品牌经典风明显不同，严禁三条共用同一个顺序模板。
2. 两条品牌经典风虽然同为「标题行 + 4 行」，但每行的内容、切入角度、开头句式必须完全不同，两条放在一起读不能有「同一篇换皮」的感觉。
3. 辅导老师在三条里出现的行位置要错开，不要三条都在同一行位置提老师。
4. 三条的第一句正文开头方式必须不同（不能用同一个句式只换词）。
5. 无论有没有附带图片，严禁出现「没图」「无图」「有图吗」「图呢」「没分数」这类元描述。
每条都要独立满足下面所有硬性文风要求和信息要求。

【风格参考：以下 7 条是品牌真实发布过的文案，是第 1、3 条「品牌经典风」的参照基准，第 2 条可借鉴分行习惯】
示例1）
💬毕业论文课后答疑
课后有疑问 老师随时出现！
Sofia老师细致清晰的答疑
解决写作过程中大小难题
毕业论文全包的安全感谁懂💗

示例2）
🎶包课辅导课堂展示
VIP的包课辅导跟进服务
课上对知识点和公式的详细拆分
课后耐心仔细的答疑
占比再大的final也不在话下✅

示例3）
🌞论文辅导高分反馈
wy老师辅导的商业管理
再带学生轻松斩获68分🔥
内容逐句精修 密密麻麻的批注
学生对wy老师的好评直接拉满！

示例4）
📚毕业论文教师产出
保姆全包式毕业论文辅导谁能不爱✨
outline像剥洋葱一样层层清晰
老师批改更是细致到“像素级”
跟着老师全程清晰规划拿下大论文✅

示例5）
📖修改润色教师产出
教育学论文5月扎堆来临⚡
Pengpeng老师精致化修改润色
直观可见的细致程度
论文想不拿高分都难[好的]

示例6）
🔔包课辅导课后答疑
课程&作业总是有大小问题？
kate老师带你度过每一场考核
上课规划辅导➕课后答疑
再也不怕任何学业困难了🤞

示例7）
📦毕业论文课后答疑
dissertation高峰期来临
Luna老师群内进行详细答疑
过于复杂的问题直接上课解决
全包辅导无需担心任何难题✅

注意：示例3 是历史旧文，其中「wy老师」出现了两次——现在的新规则是每条只出现 1 次，不要模仿这一点。
示例3 的「68分」是当时素材里的真实成绩：本次只有附带图片且图中真实可见分数时才可以这样写，否则严禁出现任何分数。

【从示例中提炼的硬性文风要求（全部必须做到）】
1. 每行 8-20 字，短句独立成行，行末不加句号；可用 ！？ 和空格来断句。
2. 多用口语钩子：谁懂 / 谁不爱 / 谁能不爱 / 谁辅导谁知道 / 安排得明明白白 / 保姆式 / 拿捏 / 一键 / 一眼 / 太…了。
3. 提到老师时写成「老师名字 + 动作」（如「Sofia老师细致清晰的答疑」「kate老师带你度过每一场考核」）。
4. 不要在文案里出现课程名称或课程代码，泛指就用「这门课」「课程」。
5. 整条最多 3 个 emoji（标题 1 个 + 正文 0-2 个），常用 ✅🔥💗✨🤩👍🤝💯⚡；行末收束也可以用微信表情文字（如示例5 的 [好的]）。
6. 禁止公文腔（不要「致力于」「为您提供」「全方位」「专业团队」这类词）。
7. 示例中的老师名（Sofia/wy/Pengpeng/kate/Luna）、课程名、分数均来自真实案例，严禁照抄或编造；只允许使用本次提供的辅导老师，课程名一律不写。
8. 禁止任何性别指向单一的称呼词（姐妹们、姐妹、兄弟们、兄弟、妹子、小姐姐、帅哥美女、宝妈等都不行）；需要称呼时用「大家」「同学们」这类中性词，或者干脆不称呼直接说话。
9. 禁止低俗、粗俗或油腻的网络梗、脏话和谐音（如「稳如老狗」「老铁」「YYDS」「绝绝子」「拴Q」「牛马」「内卷到吐」以及任何脏话谐音都不行）；语言可以活泼有梗，但必须干净体面，符合品牌调性。

【素材类型对应的内容方向】
- 课堂展示：课堂讲解、知识点或公式拆解、课堂互动与节奏
- 好评分享：学生或家长的好评反馈、满意与认可
- 讲师产出：老师的讲义、笔记、批注、思维导图等产出物
- 高分喜报：出分、提分、拿到理想成绩的喜报（若附带成绩截图，必须写出图中真实分数/等级）
- 课后答疑：课后群内答疑、随时响应、疑难问题解决
- 客户复购：老学员继续续课、复购与长期陪伴

【语气】
真诚、口语化、有画面感，像老师或学生的真实分享；单条正文最多点缀 2 个 emoji（如 ✅🔥💗🤝✨），「元气热情风」按其风格定义放宽到 4 个。

【硬性要求】
1. 只输出 JSON，不要 markdown、不要代码块、不要任何解释；captions 数组必须恰好 3 个元素。
2. 除已提供的辅导老师，以及图片中真实可见的分数/等级外，严禁编造具体人名、学校名、专业名、课程代码、分数、日期；需要泛指时用「老师」「这门课」。
3. 不要出现「素材」「产品类型」「文案」「（未填写）」等内部术语或占位文字；严禁出现「没图」「无图」「没分数」等元描述。
4. 不要输出 JSON 以外的任何字段。
5. 输出前对 3 条文案逐条自检：第 1、3 条第一行是否恰为「emoji + ${productType} + ${materialType}」（第 2 条不受此约束）；第 3 条与第 1 条的切入角度、开头、用词是否完全不同；辅导老师「${teacher || '（未填写）'}」在每条里是否只完整出现 1 次（第二次提及只用「老师」）；全文是否没有出现任何课程名称或课程代码、没有任何「甩锅/丢给老师」式措辞。最后再做一次三条横向对比：开头句式、老师出现位置是否互不相同，有雷同就重写雷同的那条。`;

        const result = await askQwenForJson({ prompt, images, temperature: 0.9, disableThinking: true });
        // 兼容：优先取 captions 数组；老格式 caption 字段也兜底接住
        let captions = (Array.isArray(result?.captions) ? result.captions : [])
            .map(item => normalizeString(item).trim())
            .filter(Boolean);
        if (!captions.length) {
            const legacy = normalizeString(result?.caption).trim();
            if (legacy) captions.push(legacy);
        }
        // 兜底清洗：性别指向称呼直接替换成中性词（无论有没有图都不允许）
        captions = captions.map(normalizeGenderedAddress);
        // 老师名去重：同一条里完整老师名只保留第一次出现，其余替换成「老师」
        captions = captions.map(caption => dedupeTeacherMentions(caption, teacher));
        // 课程名硬过滤：产品要求文案不出现课程名（防止识图图片里带出的课程名漏进文案）
        if (courseName && courseName.length >= 4 && captions.length) {
            const escaped = courseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
            const coursePattern = new RegExp(escaped, 'i');
            captions = captions.filter(caption => !coursePattern.test(caption));
        }
        // 无图硬校验：提示词禁不住高温下偶发的编造，凡含具体分数/等级字样的一律剔除
        if (!hasImages && captions.length) {
            captions = captions.filter(caption => !hasFabricatedGrade(caption));
        }
        if (!captions.length) {
            return res.status(502).json({ error: 'AI 未返回文案，请重试' });
        }

        res.json({ data: { captions } });
    } catch (error) {
        next(error);
    }
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/parse-file', upload.single('file'), async (req, res, next) => {
    try {
        let buffer, filename, fileType;

        // 支持 multipart/form-data (multer) 方式
        if (req.file) {
            buffer = req.file.buffer;
            filename = req.body.filename || req.file.originalname;
            fileType = req.body.fileType || req.file.mimetype || '';
            console.log(`[parse-file] 收到 multipart 上传: ${filename}, 大小: ${buffer.length} bytes`);
        } 
        // 回退支持 JSON base64 方式
        else if (req.body && req.body.file) {
            const { file, filename: fn, fileType: ft } = req.body;
            if (!file || !fn) {
                return res.status(400).json({ error: '缺少文件数据或文件名' });
            }
            buffer = Buffer.from(file, 'base64');
            filename = fn;
            fileType = ft || '';
            console.log(`[parse-file] 收到 base64 上传: ${filename}, 大小: ${buffer.length} bytes`);
        } else {
            return res.status(400).json({ error: '缺少文件数据' });
        }

        const ext = path.extname(filename).toLowerCase();
        let text = '';

        if (fileType === 'application/pdf' || ext === '.pdf') {
            try {
                const uint8Array = new Uint8Array(buffer);
                const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;
                const textParts = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    const pageText = content.items.map(item => item.str).join(' ');
                    textParts.push(pageText);
                }
                text = textParts.join('\n');
                console.log(`[parse-file] PDF 解析成功，提取 ${text.length} 字节文本`);
            } catch (pdfError) {
                console.error('[parse-file] PDF 解析失败:', pdfError.message);
                return res.status(400).json({ error: `PDF 解析失败: ${pdfError.message}` });
            }
        } else if (ext === '.docx' || ext === '.doc') {
            if (ext === '.doc') {
                return res.status(400).json({ error: '暂不支持 .doc 格式，请另存为 .docx' });
            }
            try {
                const result = await mammoth.extractRawText({ buffer });
                text = result.value;
                console.log(`[parse-file] Word 解析成功，提取 ${text.length} 字节文本`);
            } catch (docxError) {
                console.error('[parse-file] Word 解析失败:', docxError.message);
                return res.status(400).json({ error: `Word 文件解析失败: ${docxError.message}` });
            }
        } else if (['.txt', '.md', '.json', '.csv'].includes(ext)) {
            text = buffer.toString('utf-8');
            console.log(`[parse-file] 文本文件读取成功，${text.length} 字节`);
        } else {
            return res.status(400).json({ error: `不支持的文件类型: ${ext}` });
        }

        res.json({ text: text.slice(0, 20000) });
    } catch (error) {
        console.error('[parse-file] 未知错误:', error);
        next(error);
    }
});

app.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
        error: error.message || '服务内部错误'
    });
});

app.listen(PORT, HOST, () => {
    console.log(`AI report server running at http://${HOST}:${PORT}`);
});
