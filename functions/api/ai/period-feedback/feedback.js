// Cloudflare Pages Functions - 周期反馈内容
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
            return createResponse({ error: '请先上传反馈截图或PDF文件' }, 400);
        }

        const prompt = `
请根据这些课堂反馈/聊天记录截图或PDF文件，为阶段性反馈报告撰写四段文字。

当前表单上下文：
${JSON.stringify(body.context || {}, null, 2)}

请输出 JSON：
{
  "performance": "", "progress": "", "mastery": "", "suggestion": ""
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

        const result = await callAI({ prompt, images, textBlocks }, env);
        return createResponse({
            data: {
                performance: result.performance || '',
                progress: result.progress || '',
                mastery: result.mastery || '',
                suggestion: result.suggestion || ''
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
