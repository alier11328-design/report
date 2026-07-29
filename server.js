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
  "reportOverview": "报告综述：概述学生的学习历程和整体表现",
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
                reportOverview: normalizeString(result.reportOverview),
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
