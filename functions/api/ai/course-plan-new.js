// Cloudflare Pages Functions - 课程规划(新版)
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
        const { images = [], textBlocks = [], context: formContext = {} } = body;

        if (!images.length && !textBlocks.length) {
            return createResponse({ error: '请先上传图片或PDF文件' }, 400);
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

        const result = await callAI({ prompt, images, textBlocks }, env);

        return createResponse({
            data: {
                courseCode: result.courseCode || '',
                courseName: result.courseName || '',
                courseDesc: result.courseDesc || '',
                focusPoints: result.focusPoints || '核心知识模块与监管框架\n技术方法与应用实践\n合规标准与道德要求\n客户沟通与参与策略',
                difficultyPoints: result.difficultyPoints || '整合多领域知识制定合规方案\n将理论转化为实践策略\n批判性思维与复杂决策\n框架应用与灵活调整',
                assessments: Array.isArray(result.assessments) ? result.assessments.map(a => ({
                    seq: a.seq || '',
                    name: a.name || '',
                    detail: a.detail || '',
                    weight: a.weight || '',
                    ddl: a.ddl || 'TBD'
                })) : [],
                plans: Array.isArray(result.plans) ? result.plans.map(p => ({
                    session: p.session || '',
                    content: p.content || '',
                    goal: p.goal || '',
                    hours: p.hours || '1h'
                })) : [],
                advices: result.advices || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}