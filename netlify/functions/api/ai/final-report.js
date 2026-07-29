import { createResponse, createError, parseBody, askQwenForJson, normalizeString } from '../utils.js';

export default async function handler(event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (event.httpMethod !== 'POST') {
        return createError('Method not allowed', 405);
    }

    try {
        const body = parseBody(event);
        const images = Array.isArray(body?.images) ? body.images : [];
        const pdfExtraText = body?.context?.pdfExtraText || '';

        if (!images.length && !pdfExtraText) {
            return createError('请至少上传一张截图或 PDF 文档', 400);
        }

        const prompt = `
请根据以下材料为结课报告表单生成可直接回填的内容。

当前表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

${pdfExtraText ? `以下是 PDF 文档提取的文本内容（请以其为主要分析依据）：\n${pdfExtraText.slice(0, 8000)}\n` : ''}

请输出 JSON：
{
  "reportOverview": "",
  "learningGoal": "",
  "achievementSummary": "",
  "finalGrade": "",
  "gradeComment": "",
  "teacherMessage": "",
  "futureSuggestions": "",
  "assistantMessage": "",
  "performanceDesc": ""
}

要求：
1. 输出适合正式中文报告的语气。
2. 若截图中没有明确成绩，不要编造具体分数，可留空或写模糊等级描述。
3. performanceDesc 聚焦学习表现分析，不要和其他字段重复过多。
4. 不要输出结构外字段。
5. futureSuggestions（下学期学习建议）: 该课程已结束，学生不会再继续学习此课程。请输出通用的成长鼓励类套话，不要涉及具体课程内容或后续学习建议，侧重于综合素养提升和未来学业展望。
6. ${pdfExtraText ? '优先根据 PDF 文本内容分析，截图和 PDF 信息冲突时以 PDF 为准。' : ''}`;

        const result = await askQwenForJson(context, { prompt, images });

        return createResponse({
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
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}