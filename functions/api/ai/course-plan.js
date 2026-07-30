import { createResponse, callAI } from '../_shared.js';

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const { extractedText, context: formContext } = body;

        if (!extractedText) {
            return createResponse({ error: '缺少大纲文本内容' }, 400);
        }

        const prompt = `
请根据下面的课程大纲/课程说明内容，提炼并补全课程规划表单。

当前表单上下文：
${JSON.stringify(formContext || {}, null, 2)}

原始材料：
${extractedText.slice(0, 20000)}

请输出 JSON：
{
  "courseCode": "", "courseName": "", "teacherName": "",
  "courseIntro": "",
  "difficulty": { "knowledgeDepth": "", "practicalReq": "", "assessmentDifficulty": "", "workload": "" },
  "learningOutcomes": ["", ""],
  "assessments": [{ "name": "", "type": "", "ddl": "", "summary": "" }],
  "weekPlans": [{ "week": "", "focus": "", "activities": "", "assessment": "" }],
  "learningSuggest": ""
}

要求：courseIntro 概括课程介绍；learningOutcomes 输出3-8条；assessments 提取考核方式；weekPlans 最多12周。`;

        const result = await callAI({ prompt }, env);

        return createResponse({
            data: {
                courseCode: result.courseCode || '',
                courseName: result.courseName || '',
                teacherName: result.teacherName || '',
                courseIntro: result.courseIntro || '',
                difficulty: result.difficulty || {},
                learningOutcomes: Array.isArray(result.learningOutcomes) ? result.learningOutcomes.filter(Boolean) : [],
                assessments: Array.isArray(result.assessments) ? result.assessments : [],
                weekPlans: Array.isArray(result.weekPlans) ? result.weekPlans : [],
                learningSuggest: result.learningSuggest || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
