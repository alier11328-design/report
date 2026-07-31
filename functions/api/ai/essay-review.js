// Cloudflare Pages Functions - 论文复盘
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
            return createResponse({ error: '请先上传论文截图或PDF文件' }, 400);
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
${JSON.stringify(formContext, null, 2)}

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

        const result = await callAI({ prompt, images, textBlocks }, env);

        return createResponse({
            data: {
                reasons: Array.isArray(result.reasons) ? result.reasons.map(r => ({
                    title: r.title || '',
                    desc: r.desc || '',
                    quote: r.quote || ''
                })).filter(r => r.title || r.desc) : [],
                directions: Array.isArray(result.directions) ? result.directions.map(d => ({
                    tag: d.tag || '',
                    desc: d.desc || ''
                })).filter(d => d.tag || d.desc) : [],
                reuseItems: Array.isArray(result.reuseItems) ? result.reuseItems.map(item => ({
                    title: item.title || '',
                    desc: item.desc || ''
                })).filter(item => item.title || item.desc) : []
            }
        });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 识别失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
