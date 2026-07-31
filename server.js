import dotenv from 'dotenv';
import express from 'express';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
import { Buffer } from 'buffer';
import multer from 'multer';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.DASHSCOPE_MODEL || 'doubao-seed-2-0-lite';
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

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
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

function normalizeScheduleRows(items) {
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

function formatTextBlocks(textBlocks = []) {
    return Array.isArray(textBlocks)
        ? textBlocks
            .map(block => `附件名: ${normalizeString(block?.name)}\n附件内容:\n${normalizeString(block?.content)}`)
            .filter(Boolean)
            .join('\n\n---\n\n')
        : '';
}

async function askQwenForJson({ prompt, images = [], textBlocks = [] }) {
    ensureClient();

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

    const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
            { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
            { role: 'user', content }
        ]
    });

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
        if (!images.length && !textBlocks.length) {
            return res.status(400).json({ error: '请先上传图片或PDF文件' });
        }

        const prompt = `
你是一位资深的课程规划专家。请根据提供的课程大纲图片和文档，输出符合以下规范的结构化课程规划。

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
   - 必须包含以下结构要素：
     ① 课程核心定位：说明课程整合了哪些学科视角（如"行为金融学与心理学视角"）
     ② 能力培养目标：具体列出3-4项能力（如"提供有意义的财务规划建议能力"）
     ③ 关键框架/方法论：保留英文原名（如"Whole-life Compass"全生命周期罗盘）
     ④ 框架作用说明：解释该框架如何帮助学生
     ⑤ 核心知识领域：列出3-5个具体知识模块（如"税务规划、住房所有权、资产配置、保险、退休规划"）
     ⑥ 课程价值：说明课程覆盖的专业领域和职业关联
   - 参考示例（仅作结构参考，实际内容根据大纲生成）：
     "本课程整合了行为金融学与心理学视角下的幸福感、繁荣发展和伦理道德，旨在培养学生提供有意义的财务规划和财富管理建议的能力。课程核心框架为'Whole-life Compass'（全生命周期罗盘），帮助学生理解财务决策的复杂性、行为偏差、客户参与策略以及监管合规要求。课程覆盖的主要知识领域包括：税务规划与澳大利亚税务环境、住房所有权与消费信贷、资产配置与投资组合构建、保险（人寿与一般保险）、退休规划与社会保障体系、职业道德与专业标准。"

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

7. plans（辅导规划，固定15次课）：
   - 【核心要求】每次课必须联动考核项备考！
   - content格式："知识点名称（Week X）+ 考核联动内容"
   - 考核联动规则：
     * Quiz前1-2次课：末尾加"+ QuizX备考"
     * Blog截止周的课：末尾加"+ BlogX辅导"
     * Assignment前1-2次课：末尾加"+ Assignment专项辅导"
     * 无考核的课：只写"知识点名称（Week X）"
   - goal格式：明确可达成的学习目标，如"掌握监管地图"、"理解混合策略"、"能独立完成测验题型"
   - hours：格式为"1h"或"1.5h"或"2h"，每次1-2小时
   - 内容分配：前12-13次课覆盖知识点，最后2-3次课总复习+备考
   - 参考示例：
     * session4: "住房所有权与消费信贷（Week 4）+ Quiz1备考"
     * session6: "期中复盘 + Learning Blog1辅导"
     * session10: "职业道德与专业标准（Week 10）+ Quiz3备考"
     * session11: "整合作业专项辅导（Assignment Prep）"
     * session12: "总复习 + 期末答疑"
     * session13-15: 考前冲刺 + Assignment答疑 + 查漏补缺

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
1. 尽量保留原始课程名、开始时间、结束时间、时长。
2. 无法识别的字段留空字符串。
3. 不要补造不存在的排课记录。`;

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
请根据这些课堂反馈/聊天截图或PDF文件，整理成阶段性反馈报告中的四段文字。

当前表单上下文：
${JSON.stringify(req.body?.context || {}, null, 2)}

请输出 JSON：
{
  "performance": "",
  "progress": "",
  "mastery": "",
  "suggestion": ""
}

要求：
1. 使用正式、自然、可直接给家长/学生查看的中文。
2. 每个字段 1-3 句话为宜。
3. 不要编造截图中没有体现的具体成绩或时长。`;

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
