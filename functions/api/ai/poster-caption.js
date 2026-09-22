// Cloudflare Pages Functions - 朋友圈海报 AI 文案生成
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

async function callAI({ prompt, images = [], withThinking = true }, env) {
    const apiKey = env.DASHSCOPE_API_KEY;
    const model = env.DASHSCOPE_MODEL || MODEL;
    const baseUrl = env.DASHSCOPE_BASE_URL || BASE_URL;
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    const content = [{ type: 'text', text: prompt }];
    images.slice(0, 3).forEach(url => {
        if (typeof url === 'string' && url.startsWith('data:image/')) {
            content.push({ type: 'image_url', image_url: { url } });
        }
    });

    let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(withThinking
            ? { model, temperature: 0.8, thinking: { type: 'disabled' },
                messages: [
                    { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                    { role: 'user', content }
                ] }
            : { model, temperature: 0.8,
                messages: [
                    { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                    { role: 'user', content }
                ] })
    });

    // 部分模型不支持 thinking 参数，失败时自动退回普通调用
    if (!response.ok && withThinking) {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ model, temperature: 0.8,
                messages: [
                    { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                    { role: 'user', content }
                ] })
        });
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI API 错误 (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return extractJsonObject(data.choices?.[0]?.message?.content || '');
}

export async function onRequestPost(context) {
    const { request, env } = context;
    try {
        const body = await request.json();
        const productType = String(body.productType || '').trim();
        const materialType = String(body.materialType || '').trim();
        const teacher = String(body.teacher || '').trim();
        const courseName = String(body.courseName || '').trim();
        const images = Array.isArray(body.images)
            ? body.images.filter(url => typeof url === 'string' && url.startsWith('data:image/')).slice(0, 3)
            : [];

        if (!productType || !materialType) {
            return createResponse({ error: '缺少产品类型或素材类型' }, 400);
        }

        const hasImages = images.length > 0;
        const prompt = `你是「万能班长」留学课业辅导品牌的社媒文案，负责写朋友圈可以直接发布的成品文案。

产品类型：${productType}
素材类型：${materialType}
辅导老师：${teacher || '（未填写）'}
课程名称：${courseName || '（未填写）'}

请输出 JSON：{ "caption": "" }

【文案结构】
1. 标题行必须严格等于：1 个贴合语义的 emoji + 「${productType}」+「${materialType}」，顺序固定，不得写成其它产品类型或素材类型的字样（例如本次产品类型=毕业论文、素材类型=课后答疑 时，标题写成「💬毕业论文课后答疑」）。标题内不要空格、不要加 # 号。
2. 第二行起写 4-5 行短句，每行 12-20 字。整个 caption 是一个多行字符串，行与行之间用换行符分隔。

【图片识图】
- 本条消息可能附带用户上传的课堂图片；如果附带了图片，请先读图，把图中“真实可见”的分数、等级（例如 78/100、Distinction、A）写进文案。
- 分数和等级只能来自图片；图片里没有分数就不要写具体分数，严禁编造。
- 没有附带图片时一律不要出现任何具体分数。

【必须融入的信息】
- 已填写辅导老师：文案中至少出现一次该老师，统一写成「名字 + 老师」，英文名与「老师」之间保留一个空格（例如给到「Tilley」就写「Tilley 老师」，给到「Sofia」就写「Sofia 老师」；若给到的名字本身已含「老师」则直接照用）。
- 已填写课程名称：文案中必须自然带上这门课；英文原名保留英文，不要翻译。
- 这两项都是用户提供的事实，可以放心写；没有填写的字段一律不要编造。

【风格参考：以下 6 条是品牌真实发布过的文案，必须严格参照它们的语气、节奏、分行方式和用词习惯】
示例1）
💬毕业论文课后答疑
课后有疑问 老师随时出现！
Sofia 老师细致清晰的答疑
解决写作过程中大小难题
毕业论文全包的安全感谁懂💗

示例2）
🪶包课辅导课堂展示
VIP 的包课辅导跟进服务
课上对知识点和公式的详细拆分
课后耐心仔细的答疑
占比再大的 final 也不在话下✅

示例3）
📚毕业论文教师产出
保姆全包式毕业论文辅导谁能不爱✨
outline 像剥洋葱一样层层清晰
老师批改更是细致到“像素级”
跟着老师全程清晰规划拿下大论文✅

示例4）
🏔️修改润色教师产出
教育学论文 5 月扎堆来临⚡
Pengpeng 老师精致化修改润色
直观可见的细致程度
论文想不拿高分都难👍

示例5）
🔔包课辅导课后答疑
课程 & 作业总是有大小问题？
kate 老师带你度过每一场考核
上课规划辅导➕课后答疑
再也不怕任何学业困难了🤞

示例6）
✔️课时卡好评分享
Jerrie 老师又收获好评咯～
不愧是会计王牌专业🤩
结课之后的满分好评
谁辅导谁知道的可见效果 [社会社会]

【从示例中提炼的硬性文风要求（全部必须做到）】
1. 每行 8-20 字，短句独立成行，行末不加句号；可用 ！？ 和空格来断句。
2. 多用口语钩子：谁懂 / 谁不爱 / 谁能不爱 / 谁辅导谁知道 / 安排得明明白白 / 保姆式 / 拿捏 / 一键 / 一眼 / 太…了。
3. 提到老师时写成「老师名字 + 动作」（如「Sofia 老师细致清晰的答疑」「kate 老师带你度过每一场考核」）。
4. 课程名称直接嵌进句子，英文原名保留英文，不翻译。
5. 整条最多 3 个 emoji（标题 1 个 + 正文 0-2 个），常用 ✅🔥💗✨🤩👍🤝💯⚡。
6. 禁止公文腔（不要「致力于」「为您提供」「全方位」「专业团队」这类词）。
7. 示例中的老师名（Sofia/kate/Pengpeng/Jerrie）、课程名、分数均来自真实案例，严禁照抄或编造；只允许使用本次提供的辅导老师与课程名称。

【素材类型对应的内容方向】
- 课堂展示：课堂讲解、知识点或公式拆解、课堂互动与节奏
- 好评分享：学生或家长的好评反馈、满意与认可
- 讲师产出：老师的讲义、笔记、批注、思维导图等产出物
- 高分喜报：出分、提分、拿到理想成绩的喜报（若附带成绩截图，必须写出图中真实分数/等级）
- 课后答疑：课后群内答疑、随时响应、疑难问题解决
- 客户复购：老学员继续续课、复购与长期陪伴

【语气】
真诚、口语化、有画面感，像老师或学生的真实分享；整体最多点缀 2 个 emoji（如 ✅🔥💗🤝✨）。

【硬性要求】
1. 只输出 JSON，不要 markdown、不要代码块、不要任何解释。
2. 除已提供的辅导老师、课程名称，以及图片中真实可见的分数/等级外，严禁编造具体人名、学校名、专业名、课程代码、分数、日期；需要泛指时用「老师」「这门课」。
3. 不要出现「素材」「产品类型」「文案」「（未填写）」等内部术语或占位文字。
4. 不要输出 JSON 以外的任何字段。
5. 输出前自检：第一行是否恰为「emoji + ${productType} + ${materialType}」；辅导老师「${teacher || '（未填写）'}」是否已按「名字 + 老师」写进正文；课程名称「${courseName || '（未填写）'}」是否已自然带上（未填写的字段则不要出现具体老师名或课程名）。`;

        const result = await callAI({ prompt, images, withThinking: true }, env);
        const caption = String(result.caption || '').trim();
        if (!caption) return createResponse({ error: 'AI 未返回文案，请重试' }, 502);

        return createResponse({ data: { caption } });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 文案生成失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
