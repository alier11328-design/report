import { createResponse, createError, parseBody, askQwenForJson, normalizeString } from './_shared/utils.js';

export default async function handler(request, context) {
    if (request.method === 'OPTIONS') return createResponse({ ok: true });
    if (request.method !== 'POST') return createError('Method not allowed', 405);

    try {
        const body = await parseBody(request);
        const images = Array.isArray(body?.images) ? body.images : [];
        const pdfExtraText = body?.context?.pdfExtraText || '';

        if (!images.length && !pdfExtraText) return createError('请至少上传一张截图或 PDF 文档', 400);

        const prompt = `
请根据以下材料为结课报告表单生成可直接回填的内容。

当前表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

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

export const config = { path: '/api/ai/final-report' };
