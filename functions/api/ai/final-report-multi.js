// Cloudflare Pages Functions - 结课报告（多门）
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
            ...arkThinking(baseUrl),
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
        const images = Array.isArray(body.images) ? body.images : [];
        const textBlocks = Array.isArray(body.textBlocks) ? body.textBlocks : [];

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请至少上传一张截图或 PDF 文档' }, 400);
        }

        const ctx = body.context || {};
        const courseCount = Number(ctx.courseCount) > 0 ? Number(ctx.courseCount) : 1;

        const prompt = `
请根据以下材料为「结课报告（多门）」表单生成可直接回填的内容。该报告覆盖学生一个辅导周期内的多门课程。

当前表单上下文（已有信息，缺失的请补充）：
${JSON.stringify(ctx, null, 2)}

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

        const result = await callAI({ prompt, images, textBlocks }, env);

        const courses = Array.isArray(result.courses)
            ? result.courses.map(c => ({
                courseName: normalizeString(c?.courseName),
                hours: normalizeString(c?.hours),
                orderNumber: normalizeString(c?.orderNumber),
                learningGoal: normalizeString(c?.learningGoal),
                outcomes: normalizeOutcomeArray(c?.outcomes),
                totalScore: normalizeString(c?.totalScore),
                teacherMessage: normalizeString(c?.teacherMessage)
            })).filter(c => c.courseName || c.orderNumber || c.learningGoal || c.outcomes.length || c.totalScore || c.teacherMessage)
            : [];

        return createResponse({
            data: {
                studentName: normalizeString(result.studentName),
                university: normalizeString(result.university),
                periodStart: normalizeString(result.periodStart),
                periodEnd: normalizeString(result.periodEnd),
                attendanceRate: normalizeString(result.attendanceRate),
                attendanceDesc: normalizeString(result.attendanceDesc),
                taskCompletionRate: normalizeString(result.taskCompletionRate),
                taskCompletionDesc: normalizeString(result.taskCompletionDesc),
                interactionRate: normalizeString(result.interactionRate),
                interactionDesc: normalizeString(result.interactionDesc),
                reportOverview: normalizeString(result.reportOverview),
                courses,
                suggestionsIntro: normalizeString(result.suggestionsIntro),
                suggestions: normalizeOutcomeArray(result.suggestions),
                assistantMessage: normalizeString(result.assistantMessage)
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
