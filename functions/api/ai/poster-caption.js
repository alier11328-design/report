// Cloudflare Pages Functions - 朋友圈海报 AI 文案生成
const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = 'qwen3-vl-flash';

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

// 海报文案无图硬校验：识别文案里是否出现具体分数/等级字样。
// 只用于「本次没有附带识图图片」的场景——有图时分数来自真实识图，不做拦截。
function hasFabricatedGrade(text) {
    // 字母等级：Distinction/HD 全词匹配；单字母等级（A/A-等）要求紧跟在中文字后面（避免误伤 Plan B 这类英文搭配）
    const gradePattern = /(?:High\s*Distinction|Distinction|(?:^|[^\p{L}\p{N}])HD(?:$|[^\p{L}\p{N}])|[\u4e00-\u9fff]\s*[ABCDF][+\-]?)/iu;
    // 数字分数：78分 / 78 分 / 78/100（「30分钟」不误伤）
    const scorePattern = /\d{2,3}\s*(?:分(?!钟)|\/\s*100)/u;
    return gradePattern.test(text) || scorePattern.test(text);
}

async function callAI({ prompt, images = [], withThinking = true }, env) {
    // 注意：线上 DASHSCOPE_* 变量名下暂存的是火山引擎旧值（其他接口还在用），
    // 文案接口改用 POSTER_AI_* 专属变量，缺省值即阿里云百炼 DashScope。
    const apiKey = env.POSTER_AI_API_KEY;
    const model = env.POSTER_AI_MODEL || MODEL;
    const baseUrl = env.POSTER_AI_BASE_URL || BASE_URL;
    if (!apiKey) throw new Error('缺少 POSTER_AI_API_KEY 环境变量');

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
            ? { model, temperature: 0.8, enable_thinking: false,
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

    // 部分模型不支持 enable_thinking 参数，失败时自动退回普通调用
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

// 性别指向称呼归一化：提示词拦不住模型偶发的「姐妹们」，直接替换成中性称呼。
// 先替换长词再替换短词，避免「姐妹们」被拆成「朋友们」。
function normalizeGenderedAddress(text) {
    return text
        .replace(/姐妹们|兄弟们|集美们|帅哥美女/g, '大家')
        .replace(/小姐姐|小哥哥/g, '同学')
        .replace(/姐妹|兄弟/g, '朋友')
        .replace(/宝妈|宝爸/g, '家长');
}

// 老师名去重：完整「名字 + 老师」在一条文案里只保留第一次出现，其余替换成「老师」，
// 避免同一条里老师名出现两三遍显得像模板。
function dedupeTeacherMentions(text, teacher) {
    const base = String(teacher || '').replace(/老师\s*$/, '').trim();
    if (!base) return text;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped + '\\s*老师', 'g');
    let seen = false;
    return text.replace(pattern, match => {
        if (!seen) { seen = true; return match; }
        return '老师';
    });
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

请输出 JSON：{ "captions": ["", "", ""] }

【文案结构（标题行规则只约束第 1 条「品牌经典风」）】
1. 第 1 条的第一行（标题行）必须严格等于：1 个贴合语义的 emoji + 「${productType}」+「${materialType}」，顺序固定，不得写成其它产品类型或素材类型的字样（例如本次产品类型=毕业论文、素材类型=课后答疑 时，标题写成「💬毕业论文课后答疑」）。标题内不要空格、不要加 # 号。第 2、3 条的第一行自由发挥，完全不受标题行规则约束。
2. 标题行之后写 4-5 行短句，每行 12-20 字。整个 caption 是一个多行字符串，行与行之间用换行符分隔。

【图片识图】
- 本条消息可能附带用户上传的课堂图片；如果附带了图片，请先读图，把图中“真实可见”的分数、等级（例如 78/100、Distinction、A）写进文案。
- 分数和等级只能来自图片；图片里没有分数就不要写具体分数，严禁编造。
- 没有附带图片时，正文里严禁出现任何具体分数或等级字样（78、89、A、A-、Distinction、HD 等都不行），无论写成已发生、承诺还是目标（「拿下」「锁死」「稳拿」「冲个 A」都算违规）；只能用「上岸」「高分」「拿捏」这类不落到具体分数等级的说法。

【必须融入的信息】
- 已填写辅导老师：整条文案里完整的「名字 + 老师」只出现 1 次（只占一行），同一行或后面再提到时一律只用「老师」两个字泛指，严禁把完整老师名写两遍。英文名与「老师」之间保留一个空格（例如给到「Tilley」就写「Tilley 老师」；若给到的名字本身已含「老师」则直接照用）。这是用户提供的事实，可以放心写；没有填写就一律不要编造。
- 严禁在文案里出现课程名称、课程代码（哪怕图片里能看到），一律用「这门课」「课程」泛指。

【一次生成 3 条风格明显不同的文案】
captions 数组必须按顺序给出 3 条，风格定义如下，差异必须一眼能看出来：
1. 第 1 条「品牌经典风」：严格参照下方 6 条品牌示例的语气、节奏和分行方式，4-5 行短句，稳重耐看。
2. 第 2 条「元气热情风」：情绪更饱满、更有号召感（如「闭眼冲」「稳了」「直接锁死」），节奏更跳跃，emoji 可用足 4 个，感叹号可以更多；第一行不用标题行，直接用情绪钩子或喊话开头；行数与第 1 条不同（3-4 行），至少有一行把两件事写进同一句；严禁用「姐妹们」「兄弟们」这类性别称呼，喊人就用「大家」「同学们」。
3. 第 3 条「干货攻略风」：按下面的行骨架逐行写，不得增删调换：
   第 1 行（钩子）：一个提问或痛点句，如「final 前一周还能翻盘吗？」；
   第 2-4 行（干货点）：用 ✔ 或 ①② 开头，列 3 个干货点（怎么做、怎么安排、找谁帮忙），贴合本次产品类型和素材类型的真实场景；
   第 5 行（收束）：一句短收束。
   严禁编造具体分数、份数、天数等数字。

【打破公式化结构（非常重要，三条都要做到）】
1. 三条的行数、断句位置、信息出现顺序必须各不相同，严禁三条共用「标题→事件→老师→感叹」这一个顺序模板。
2. 辅导老师在三条里出现的行位置要错开，不要三条都在同一行位置提老师。
3. 三条的第一句正文开头方式必须不同（不能用同一个句式只换词）。
4. 无论有没有附带图片，严禁出现「没图」「无图」「有图吗」「图呢」「没分数」这类元描述。
每条都要独立满足下面所有硬性文风要求和信息要求。

【风格参考：以下 6 条是品牌真实发布过的文案，是第 1 条「品牌经典风」的参照基准，其余两条可借鉴分行习惯】
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
4. 不要在文案里出现课程名称或课程代码，泛指就用「这门课」「课程」。
5. 整条最多 3 个 emoji（标题 1 个 + 正文 0-2 个），常用 ✅🔥💗✨🤩👍🤝💯⚡。
6. 禁止公文腔（不要「致力于」「为您提供」「全方位」「专业团队」这类词）。
7. 示例中的老师名（Sofia/kate/Pengpeng/Jerrie）、课程名、分数均来自真实案例，严禁照抄或编造；只允许使用本次提供的辅导老师，课程名一律不写。
8. 禁止任何性别指向单一的称呼词（姐妹们、姐妹、兄弟们、兄弟、妹子、小姐姐、帅哥美女、宝妈等都不行）；需要称呼时用「大家」「同学们」这类中性词，或者干脆不称呼直接说话。

【素材类型对应的内容方向】
- 课堂展示：课堂讲解、知识点或公式拆解、课堂互动与节奏
- 好评分享：学生或家长的好评反馈、满意与认可
- 讲师产出：老师的讲义、笔记、批注、思维导图等产出物
- 高分喜报：出分、提分、拿到理想成绩的喜报（若附带成绩截图，必须写出图中真实分数/等级）
- 课后答疑：课后群内答疑、随时响应、疑难问题解决
- 客户复购：老学员继续续课、复购与长期陪伴

【语气】
真诚、口语化、有画面感，像老师或学生的真实分享；单条正文最多点缀 2 个 emoji（如 ✅🔥💗🤝✨），「元气热情风」按其风格定义放宽到 4 个。

【硬性要求】
1. 只输出 JSON，不要 markdown、不要代码块、不要任何解释；captions 数组必须恰好 3 个元素。
2. 除已提供的辅导老师，以及图片中真实可见的分数/等级外，严禁编造具体人名、学校名、专业名、课程代码、分数、日期；需要泛指时用「老师」「这门课」。
3. 不要出现「素材」「产品类型」「文案」「（未填写）」等内部术语或占位文字；严禁出现「没图」「无图」「没分数」等元描述。
4. 不要输出 JSON 以外的任何字段。
5. 输出前对 3 条文案逐条自检：第 1 条第一行是否恰为「emoji + ${productType} + ${materialType}」（第 2、3 条不受此约束）；辅导老师「${teacher || '（未填写）'}」在每条里是否只完整出现 1 次（第二次提及只用「老师」）；全文是否没有出现任何课程名称或课程代码。最后再做一次三条横向对比：行数、开头句式、老师出现位置是否互不相同，有雷同就重写雷同的那条。`;

        const result = await callAI({ prompt, images, withThinking: true }, env);
        // 兼容：优先取 captions 数组；老格式 caption 字段也兜底接住
        let captions = (Array.isArray(result.captions) ? result.captions : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        if (!captions.length) {
            const legacy = String(result.caption || '').trim();
            if (legacy) captions.push(legacy);
        }
        // 兜底清洗：性别指向称呼直接替换成中性词（无论有没有图都不允许）
        captions = captions.map(normalizeGenderedAddress);
        // 老师名去重：同一条里完整老师名只保留第一次出现，其余替换成「老师」
        captions = captions.map(caption => dedupeTeacherMentions(caption, teacher));
        // 课程名硬过滤：产品要求文案不出现课程名（防止识图图片里带出的课程名漏进文案）
        if (courseName && courseName.length >= 4 && captions.length) {
            const escaped = courseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
            const coursePattern = new RegExp(escaped, 'i');
            captions = captions.filter(caption => !coursePattern.test(caption));
        }
        // 无图硬校验：提示词禁不住高温下偶发的编造，凡含具体分数/等级字样的一律剔除
        if (!hasImages && captions.length) {
            captions = captions.filter(caption => !hasFabricatedGrade(caption));
        }
        if (!captions.length) return createResponse({ error: 'AI 未返回文案，请重试' }, 502);

        return createResponse({ data: { captions } });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 文案生成失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
