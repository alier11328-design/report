import { createResponse, callAI } from '../../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const images = Array.isArray(body.images) ? body.images : [];
        const pdfExtraText = body.context?.pdfExtraText || '';

        if (!images.length && !pdfExtraText) {
            return createResponse({ error: '请至少上传一张截图或 PDF 文档' }, 400);
        }

        const prompt = `
请根据以下材料为结课报告表单生成可直接回填的内容。

当前表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

${pdfExtraText ? `以下是 PDF 文档提取的文本内容（请以其为主要分析依据）：\n${pdfExtraText.slice(0, 8000)}\n` : ''}

请输出 JSON，必须包含所有字段且每个字段都必须有具体内容（不能为空字符串）：
{
  "reportOverview": "报告综述",
  "learningGoal": "学习目标",
  "achievementSummary": "学习成果总结（至少50字）",
  "finalGrade": "总成绩",
  "gradeComment": "成绩评语",
  "teacherMessage": "讲师寄语（至少50字）",
  "futureSuggestions": "下学期学习建议",
  "assistantMessage": "教辅寄语（至少50字）",
  "performanceDesc": "学习表现描述"
}

要求：
1. 输出适合正式中文报告的语气。
2. 每个字段都必须有实质内容，不能留空。
3. teacherMessage 和 assistantMessage 必须是完整的寄语段落，至少50字。
4. 若截图中没有明确成绩，finalGrade 可写"良好"或"合格"。
5. ${pdfExtraText ? '优先根据 PDF 文本内容分析。' : '根据截图内容分析生成。'}`;

        const result = await callAI({ prompt, images }, env);

        return createResponse({
            data: {
                reportOverview: result.reportOverview || '',
                learningGoal: result.learningGoal || '',
                achievementSummary: result.achievementSummary || '',
                finalGrade: result.finalGrade || '',
                gradeComment: result.gradeComment || '',
                teacherMessage: result.teacherMessage || '',
                futureSuggestions: result.futureSuggestions || '',
                assistantMessage: result.assistantMessage || '',
                performanceDesc: result.performanceDesc || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
