import { createResponse, createError, parseBody, askQwenForJson, normalizeString, normalizeStringArray, normalizeAssessmentArray, normalizeWeekPlans } from '../utils.js';

export default async function onRequest(context) {
    const request = context.request;
    
    if (request.method === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (request.method !== 'POST') {
        return createError('Method not allowed', 405);
    }

    try {
        const body = await parseBody(context);
        const extractedText = normalizeString(body?.extractedText);
        
        if (!extractedText) {
            return createError('缺少大纲文本内容', 400);
        }

        const prompt = `
请根据下面的课程大纲/课程说明内容，提炼并补全课程规划表单。

当前表单上下文：
${JSON.stringify(body?.context || {}, null, 2)}

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

        const result = await askQwenForJson(context, { prompt });

        return createResponse({
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
        return createError(error.message || 'AI 识别失败', error.statusCode || 500);
    }
}