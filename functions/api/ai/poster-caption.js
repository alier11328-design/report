// Cloudflare Pages Functions - 朋友圈海报 AI 文案生成
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const MODEL = 'doubao-seed-2.1-lite';

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

// ===== 文案条数稳定化 =====
// 模型偶尔会把「每一行」当成 captions 的一个元素（实测出现过 13~14 个单行元素），
// 前端只取前 3 个元素时就剩几行碎片，看起来像「只生成 1~2 条」。
// 另外旧逻辑遇到课程名 / 无图具体分数会整条剔除，也会让条数变少。
// 这里：① 把扁平行数组重组回 3 条完整文案；② 违规内容就地改写，最多只丢一行；③ 缺位定向补一次。
const CAPTION_SLOT_COUNT = 3;
const CAPTION_SLOT_STYLES = ['品牌经典风', '元气热情风', '专业输出风'];

// 品牌经典风的标题行 = 1 个 emoji + 产品类型 + 素材类型（允许中间有空白）
function isBrandTitleLine(line, productType, materialType) {
    const plain = String(line).trim()
        .replace(/^[\p{Extended_Pictographic}\u2600-\u27BF\uFE0F\s]+/u, '')
        .replace(/\s+/g, '');
    const expected = String(productType).replace(/\s+/g, '') + String(materialType).replace(/\s+/g, '');
    return Boolean(plain) && plain === expected;
}

function isFlatLineArray(items) {
    if (items.length < 6) return false;
    const singleLine = items.filter(item => !String(item).includes('\n')).length;
    return singleLine / items.length >= 0.7;
}

// 扁平数组本身仍有序：品牌风 5 行 → 元气风 3~4 行 → 专业输出风 5~6 行。
// 第 3 条改成清单式、不再有标题行，所以只用第 1 条标题行定位起点，再按行数结构切后两段。
function regroupFlatCaptions(items, productType, materialType) {
    const firstTitle = items.findIndex(line => isBrandTitleLine(line, productType, materialType));
    if (firstTitle < 0) return null;
    const first = items.slice(firstTitle, firstTitle + 5);
    if (first.length < 5) return null;
    const rest = items.slice(firstTitle + 5);
    if (rest.length < 7) return null;
    // 第 3 条的清单行以符号开头：用第一个清单行定位，前一行是场景钩子则一并归入第 3 条
    const bulletAt = rest.findIndex(line => /^[✅📋📑🔍📄📌]/u.test(String(line).trim()));
    const looksLikeHook = line => /[?？!！👇：:]$/u.test(String(line).trim())
        || /这门课|不知道|听不懂|从哪下手|倒计时/u.test(String(line));
    let split = -1;
    if (bulletAt >= 3) split = looksLikeHook(rest[bulletAt - 1]) ? bulletAt - 1 : bulletAt;
    if (split < 0 || rest.length - split < 4) {
        // 兜底：元气风 3~4 行、专业输出风 4~7 行
        for (const size of [4, 3]) {
            const tail = rest.length - size;
            if (tail >= 4 && tail <= 7) { split = size; break; }
        }
        if (split < 0 || rest.length - split < 4) split = rest.length >= 9 ? 4 : 3;
    }
    const groups = [first, rest.slice(0, split), rest.slice(split)];
    if (groups.some(group => !group.length)) return null;
    return groups.map(group => group.join('\n'));
}

// 无图时把具体分数/等级改写成泛化说法，保住这一行、也保住这一条文案
function neutralizeGrade(text) {
    return text
        .replace(/High\s*Distinction/gi, '好成绩')
        .replace(/Distinction/gi, '好成绩')
        .replace(/(^|[^\p{L}\p{N}])HD(?=$|[^\p{L}\p{N}])/gu, '$1好成绩')
        .replace(/\d{2,3}\s*\/\s*100/g, '理想成绩')
        .replace(/\d{2,3}\s*分(?!钟)/g, '高分')
        .replace(/([\u4e00-\u9fff]\s*)[ABCDF][+\-]?(?=$|[^\p{L}\p{N}])/gu, '$1高分');
}

function neutralizeCourseName(text, courseName) {
    const name = String(courseName || '').replace(/\s+/g, ' ').trim();
    if (name.replace(/\s/g, '').length < 4) return text;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    return text.replace(new RegExp(escaped, 'gi'), '这门课');
}

// 逐行清洗：优先改写，实在改不干净才丢「这一行」，绝不丢整条
function sanitizeCaptionLines(caption, ctx) {
    const lines = String(caption || '').replace(/\r/g, '')
        .split('\n').map(line => line.trim()).filter(Boolean);
    const kept = [];
    // 图里连一个分数/等级都没有时，沿用「无图」清洗，防止模型顺手编一个分数出来
    const imageHasGrade = Boolean(String(ctx.visibleFacts || '')
        .match(/\d{2,3}\s*(?:分(?!钟)|\/\s*\d{2,3})|Distinction|\bHD\b|\b[A-F][+-]?\b/iu));
    const strictGrade = !ctx.hasImages || !imageHasGrade;
    lines.forEach(line => {
        let cleaned = neutralizeCourseName(line, ctx.courseName);
        if (strictGrade) {
            cleaned = neutralizeGrade(cleaned);
            if (hasFabricatedGrade(cleaned)) return;
        }
        kept.push(cleaned);
    });
    return kept.join('\n');
}

// 返回固定 3 个位置（缺失为 null），保证前端的风格标签不会错位
function collectCaptionSlots(raw, ctx) {
    let items = (Array.isArray(raw?.captions) ? raw.captions : [])
        .map(item => String(item || '').replace(/\r/g, '').trim())
        .filter(Boolean);
    if (!items.length) {
        const legacy = String(raw?.caption || '').trim();
        if (legacy) items = [legacy];
    }
    if (isFlatLineArray(items)) {
        const grouped = regroupFlatCaptions(items, ctx.productType, ctx.materialType);
        if (grouped && grouped.length >= CAPTION_SLOT_COUNT) items = grouped;
    }
    const slots = Array(CAPTION_SLOT_COUNT).fill(null);
    items.slice(0, CAPTION_SLOT_COUNT).forEach((item, index) => {
        let text = sanitizeCaptionLines(item, ctx);
        text = normalizeGenderedAddress(text);
        text = dedupeTeacherMentions(text, ctx.teacher);
        slots[index] = text || null;
    });
    return slots;
}

function finalizeCaptions(slots) {
    const captions = [];
    const captionStyles = [];
    slots.forEach((text, index) => {
        if (!text) return;
        captions.push(text);
        captionStyles.push(CAPTION_SLOT_STYLES[index]);
    });
    return { captions, captionStyles };
}

// ===== 图中标注重点：让文案落地到这张成品图 =====
// 旧版只有「高分喜报」传图、且提示词只让模型读分数，结果所有文案都在套示例里的空话。
// 现在所有素材类型都传图：先让模型把红框 / 红底白字标注抄成 highlights，
// 服务端再逐条检查文案是否真的提到其中任一重点，没提到就定向重生成那一条。
function cleanCaptionHighlights(raw) {
    const items = Array.isArray(raw?.highlights) ? raw.highlights : [];
    const unique = [];
    items.forEach(item => {
        const text = String(item || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 24);
        if (text && !unique.includes(text)) unique.push(text);
    });
    return unique.slice(0, 8);
}

function cleanVisibleScores(raw) {
    const items = Array.isArray(raw?.visibleScores) ? raw.visibleScores : [];
    return items.map(item => String(item || '').trim()).filter(Boolean).slice(0, 6);
}

// 中文 3 字滑窗：允许把「基础情况评估」改写成「基础情况先摸清」也算命中
function captionGrounded(text, highlights) {
    if (!highlights.length) return true;
    const flat = String(text || '').replace(/\s+/g, '');
    return highlights.some(item => {
        const key = String(item).replace(/[^\p{L}\p{N}]/gu, '');
        if (!key) return false;
        if (key.length <= 3) return flat.includes(key);
        for (let i = 0; i <= key.length - 3; i += 1) {
            if (flat.includes(key.slice(i, i + 3))) return true;
        }
        return false;
    });
}

function parseCaptionAI(raw, ctx) {
    const highlights = cleanCaptionHighlights(raw);
    const visibleScores = cleanVisibleScores(raw);
    const enriched = { ...ctx, visibleFacts: [...visibleScores, ...highlights].join(' ') };
    const slots = collectCaptionSlots(raw, enriched);
    return { slots, highlights, grounded: slots.map(text => captionGrounded(text, highlights)) };
}

async function callAI({ prompt, images = [], withThinking = true }, env) {
    // 全站统一走 DASHSCOPE_*（火山方舟 agent plan），文案接口不再单独指向阿里云百炼。
    // POSTER_AI_* 只作为「成对覆盖」保留：必须 key 和 baseUrl 同时配齐才生效，
    // 否则会出现「火山端点 + 阿里云 key」的 401（线上曾经只配了 POSTER_AI_API_KEY）。
    const posterKey = env.POSTER_AI_API_KEY;
    const posterBase = env.POSTER_AI_BASE_URL;
    const usePosterOverride = Boolean(posterKey && posterBase);
    const apiKey = usePosterOverride ? posterKey : env.DASHSCOPE_API_KEY;
    const baseUrl = usePosterOverride ? posterBase : (env.DASHSCOPE_BASE_URL || BASE_URL);
    const model = usePosterOverride
        ? (env.POSTER_AI_MODEL || MODEL)
        : (env.DASHSCOPE_MODEL || MODEL);
    if (!apiKey) throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');

    const content = [{ type: 'text', text: prompt }];
    images.slice(0, 3).forEach(url => {
        if (typeof url === 'string' && url.startsWith('data:image/')) {
            content.push({ type: 'image_url', image_url: { url } });
        }
    });

    // 百炼 qwen 用 enable_thinking 关思考；火山方舟用 thinking:{type:'disabled'}，两者不能混发
    const isArk = /volces\.com/i.test(String(baseUrl));
    const thinkingParams = isArk
        ? { thinking: { type: 'disabled' } }
        : (withThinking ? { enable_thinking: false } : {});

    let response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, temperature: 0.8, ...thinkingParams,
            messages: [
                { role: 'system', content: JSON_ONLY_SYSTEM_PROMPT },
                { role: 'user', content }
            ] })
    });

    // 部分模型不支持思考开关参数，失败时自动退回普通调用
    if (!response.ok && Object.keys(thinkingParams).length) {
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
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
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
        const imageBrief = hasImages
            ? `本条消息附带了用户做好的成品图截图（共 ${images.length} 张）。这类图里通常有人工加的红色 / 橙色标注：红底白字的大标签、红框圈出的段落、红色箭头指向的对象、划线或加粗的关键词、聊天记录里被圈出的时间安排。这些标注就是这张海报想传达的卖点，也是本次文案唯一该紧扣的内容。`
            : '本条消息没有附带成品图，请按下方品牌语气写泛化文案，不得编造任何具体事实、分数、日期或人名。';

        const prompt = `你是「万能班长」留学课业辅导品牌的社媒文案，负责写朋友圈可以直接发布的成品文案。

产品类型：${productType}
素材类型：${materialType}
辅导老师：${teacher || '（未填写）'}

${imageBrief}

请输出 JSON：{ "highlights": [], "visibleScores": [], "captions": ["", "", ""] }

【第一步：先读图，再动笔（决定文案像不像「这张图」）】
1. ${hasImages ? '逐张看图，把「被人特意标注出来的重点」用图上的原词抄进 highlights，最多 8 条、每条 4-18 字。优先级：红底 / 橙底白字大标签 > 红框圈出的段落要点 > 红箭头指向的对象 > 加粗高亮的小标题 > 普通正文里最关键的一句。' : '没有图片时 highlights 给空数组 []。'}
2. highlights 只写图上真实可见的字，严禁脑补，严禁写「老师很负责」这类评价；图里没有标注就退而求其次，抄图上最醒目的标题或关键词。
3. 不要把课程名、课程代码、学校名、专业名、老师名放进 highlights，这些一律不许出现在文案里。
4. visibleScores 只填图中真实可见的分数 / 等级原词（如 "68分"、"78/100"、"Distinction"、"A-"）；图里没有就给空数组 []。
5. 多张图时 highlights 要覆盖不同图，不要全从第一张里挑；同一个意思不要重复列。

【第二步：按 highlights 写文案（最重要，做不到就等于没看图）】
1. 每条文案至少 2 行直接落到 highlights 的具体信息：可以直接把标注原词写进行里，也可以贴着原词改写，但必须让读过图的人一眼认出说的是这张图。做法示例：把标注原词嵌进短句（「XX评估先做在前面」「XX清单每周一发」「XX时间已经敲定」）；反面例子是笼统写「老师梳理了考点」「带着学生逐题刷练」，这种换任何一张图都成立的句子不算数。
2. 三条要分工、各挑不同重点，不要三条都写同一件事：第 1 条写「图里展示了什么 / 老师做了什么」，第 2 条写「学生拿到什么 / 问题怎么被解决」，第 3 条把剩下的标注重点写成「交付物清单」（每个清单条目对应一个标注重点）。
3. 严禁只靠下面这些放之四海皆准的空话凑行数（除非紧跟在图中具体信息后面）：全程带练、梳理考点、逐题拆解、思路不卡壳、稳稳拿捏、考前冲分、高效上岸、安排得明明白白、把时间用在刀刃上、跟着节奏走、安全感拉满、稳住考试、直接拉满。判断方法：把一行删掉后换任何一张图都照样成立，这行就是废话，必须重写。
4. 下方 7 条示例只用来学「分行节奏、口语感、emoji 用量」，严禁照搬示例里的具体句子、句式和内容；本次文案的具体名词必须来自 highlights。
5. 没有附带图片时跳过本段第 1-2 条，但仍要遵守第 3-4 条：写不出具体信息就写场景和感受，不要编造图里才有的细节。

【数组结构（最容易出错，必须严格遵守）】
captions 数组必须「恰好 3 个元素」，每个元素是「一整条完整文案」：一条内部的 5 行 / 3-4 行 / 5-6 行必须用 \\n 换行符连成同一个字符串。
严禁把每一行拆成单独的数组元素（历史错误：返回过 13~14 个单行元素），也不要返回多于或少于 3 个元素。
结构示意（\\n 表示换行，实际输出时是 JSON 字符串里的换行转义；第 3 个元素的实际结构以【专业输出风】规则为准）：
{"captions":["标题行\\n第二行\\n第三行\\n第四行\\n第五行","情绪钩子开头！\\n第二行\\n第三行","场景钩子👇\\n✅清单条目一\\n📋清单条目二\\n📑清单条目三\\n想了解可以私信🌻"]}

【文案结构（标题行规则只约束第 1 条「品牌经典风」）】
1. 只有第 1 条的第一行（标题行）必须严格等于：1 个贴合语义的 emoji + 「${productType}」+「${materialType}」，顺序固定，不得写成其它产品类型或素材类型的字样（例如本次产品类型=毕业论文、素材类型=课后答疑 时，标题写成「💬毕业论文课后答疑」）。标题内不要空格、不要加 # 号。**第 2、3 条都严禁写这个标题行**，第 3 条尤其不能把产品类型和素材类型拼成第一行。
2. 第 1 条品牌经典风：标题行之后写 4 行短句（整条共 5 行），每行 8-20 字。
3. 第 2 条元气热情风：3-4 个短句，每行 8-20 字。
4. 第 3 条专业输出风：整条 5-6 行，结构固定为「1 行场景钩子 + 3-4 行清单条目 + 1 行 CTA 收尾」，清单条目每行 12-32 字（信息密度高，允许长句）。详见下方【专业输出风参考】。整个 caption 是一个多行字符串，行与行之间用换行符分隔。

【分数与等级】
- 只有图中真实可见、且已填进 visibleScores 的分数 / 等级才可以写进文案；visibleScores 为空时，正文里严禁出现任何具体分数或等级字样（78、89、A、A-、Distinction、HD 等都不行），无论写成已发生、承诺还是目标（「拿下」「锁死」「稳拿」「冲个 A」都算违规）；只能用「上岸」「高分」「拿捏」这类不落到具体分数等级的说法。
- 没有附带图片时同上，严禁编造分数。
- 图中可见的分数 / 等级最多在一条文案里写 1 次，不要三条都堆同一个数字。

【必须融入的信息】
- 已填写辅导老师：整条文案里完整的「名字 + 老师」只出现 1 次（只占一行），同一行或后面再提到时一律只用「老师」两个字泛指，严禁把完整老师名写两遍。老师名字必须与提供的一字不差，不得漏字母、改拼或缩写（给到「Russell Feng 冯」就只能写「Russell Feng 冯老师」）。英文名直接连着「老师」写，不加空格（与下方示例一致，例如给到「Tilley」就写「Tilley老师」；若给到的名字本身已含「老师」则直接照用）。这是用户提供的事实，可以放心写；没有填写就一律不要编造。
- 严禁在文案里出现课程名称、课程代码（哪怕图片里能看到），一律用「这门课」「课程」泛指。

【一次生成 3 条文案：品牌经典风 + 元气热情风 + 专业输出风】
captions 数组必须按顺序给出 3 条，风格定义如下：
1. 第 1 条「品牌经典风」：严格参照下方品牌示例的语气、节奏和分行方式，标题行 + 4 行短句，稳重耐看。
2. 第 2 条「元气热情风」：情绪更饱满、更有号召感（如「闭眼冲」「稳了」「直接锁死」），节奏更跳跃，emoji 可用足 4 个，感叹号可以更多；第一行不用标题行，直接用情绪钩子或喊话开头；行数与品牌经典风不同（必须 3-4 个短句、每句独立成行、每行 8-20 字，严禁写成一整段长句，也严禁把两三件事塞进一个 30 字以上的超长行）；严禁用「姐妹们」「兄弟们」这类性别称呼，喊人就用「大家」「同学们」。措辞必须尊重老师：严禁出现「甩锅」「丢给」「扔给」「推给」「包给」老师这类把功课、难题、责任推到老师身上的说法——老师是接住问题、带着学生解决的一方，不是被甩锅的一方。
3. 第 3 条「专业输出风」：不写标题行，改用「机构介绍服务交付」的口吻，专业、具体、信息密度高，像一份能给家长看的交付清单。结构固定：
   - 第 1 行：场景 / 痛点钩子，点出图里那个具体难题，句末可用 👇 或？！（例如「这门课的 Case Study 不知道从哪下手？」）；严禁出现课程名、课程代码、学校名，一律用「这门课」「这次辅导」泛指。
   - 中间 3-4 行：每行以 1 个清单符号开头（✅ / 📋 / 📑 / 🔍 / 📄 / 📌，任选，可重复），写**一个具体的交付物、动作或结果**：把 highlights 里的标注重点改写成「做了什么 + 给到什么」的条目。例如图上标了「基础情况评估」就写「✅ 基础情况评估报告：先摸清跨专业背景与学科基础」，标了「每周课程内容详细梳理」就写「📋 每周课程内容梳理成导图，第二到第十二周进度一目了然」。允许用「+」并列两项、用括号补充细节，但**每条都必须能在图里找到依据**，严禁凭空写「无限回放」「Past paper」「MOCK 题」这类图上没有的服务。
   - 最后 1 行：一句克制的转化引导（「想了解同款辅导可以私信」「需要同款规划，私信占座」「想看完整交付清单，私信了解」三选一或同类表达），可带 1 个 emoji，不要喊口号、不要堆感叹号。
   - 禁止「谁懂 / 稳稳拿捏 / 直接拉满 / 闭眼冲 / 安全感」这类情绪化口语，也禁止「致力于」「为您提供」「专业团队」这类公文腔；整条最多 6 个 emoji（清单符号计入）。
   - 三条里只有这一条用清单符号开头，第 1、2 条不得以 ✅ / 📋 / 📑 / 🔍 / 📄 开头。内容必须与第 1 条完全不同，严禁只换几个词交差。

【打破公式化结构（非常重要，三条都要做到）】
1. 三条的行数、断句位置、信息出现顺序必须明显不同：第 1 条 5 行短句、第 2 条 3-4 行短句、第 3 条 5-6 行清单，严禁三条共用同一个顺序模板。
2. 第 1 条与第 3 条的内容、切入角度、开头句式必须完全不同：第 1 条是口语化分享，第 3 条是交付物清单，两条放在一起读不能有「同一篇换皮」的感觉。
3. 辅导老师在三条里出现的行位置要错开，不要三条都在同一行位置提老师。
4. 三条的第一句正文开头方式必须不同（不能用同一个句式只换词）。
5. 无论有没有附带图片，严禁出现「没图」「无图」「有图吗」「图呢」「没分数」这类元描述。
6. 有图时三条引用的 highlights 重点不能重复：同一件事只在一条里写，另两条必须换别的标注重点。
7. 有图时第 1、2 条的最后一行不许是纯情绪 / 纯口号（「稳稳冲刺」「直接拉满」「安排得明明白白」「跟着节奏走」「安全感拉满」「踏实感」这类都算），必须落到一个具体的图中信息上；第 3 条的 CTA 收尾行按专业输出风规则处理，但 CTA 前一行必须是具体交付物。
每条都要独立满足下面所有硬性文风要求和信息要求。

【风格参考：以下 7 条只用来学分行节奏与口语语气，具体内容、句式严禁照搬（本次文案的具体名词必须来自上方 highlights）】
示例1）
💬毕业论文课后答疑
课后有疑问 老师随时出现！
Sofia老师细致清晰的答疑
解决写作过程中大小难题
毕业论文全包的安全感谁懂💗

示例2）
🎶包课辅导课堂展示
VIP的包课辅导跟进服务
课上对知识点和公式的详细拆分
课后耐心仔细的答疑
占比再大的final也不在话下✅

示例3）
🌞论文辅导高分反馈
wy老师辅导的商业管理
再带学生轻松斩获68分🔥
内容逐句精修 密密麻麻的批注
学生对wy老师的好评直接拉满！

示例4）
📚毕业论文教师产出
保姆全包式毕业论文辅导谁能不爱✨
outline像剥洋葱一样层层清晰
老师批改更是细致到“像素级”
跟着老师全程清晰规划拿下大论文✅

示例5）
📖修改润色教师产出
教育学论文5月扎堆来临⚡
Pengpeng老师精致化修改润色
直观可见的细致程度
论文想不拿高分都难[好的]

示例6）
🔔包课辅导课后答疑
课程&作业总是有大小问题？
kate老师带你度过每一场考核
上课规划辅导➕课后答疑
再也不怕任何学业困难了🤞

示例7）
📦毕业论文课后答疑
dissertation高峰期来临
Luna老师群内进行详细答疑
过于复杂的问题直接上课解决
全包辅导无需担心任何难题✅

注意：示例3 是历史旧文，其中「wy老师」出现了两次——现在的新规则是每条只出现 1 次，不要模仿这一点。
示例3 的「68分」是当时素材里的真实成绩：本次只有图里真实可见、且已填进 visibleScores 才可以这样写，否则严禁出现任何分数。
示例里「课后耐心仔细的答疑」「知识点和公式的详细拆分」正是典型的模板句，本次严禁照搬；要写就写图里被标出来的那件具体的事。

【专业输出风参考：以下 3 条只用来学「清单式交付物」的结构与专业语气，具体内容严禁照搬】
参考A）
这门课听不懂？看我们的硬核包课辅导👇
✅ 手搓课件 + 手写笔记，原理掰碎讲
✅ 无限回放 + 配套纪要，复习不迷路
✅ 课后群在线答疑，老师亲自作业兜底
从课上到课后全流程护航，想了解可以私信🌻

参考B）
这门课的 Case Study 不知道该从哪下手？
别慌，看老师怎么把它拆开👇
🔍 别人让你死磕文献，我们带你拆解关键点
📄 别人让你自己想对策，我们直接拆成 Action 1/2/3/4
从海量 reading 到答题框架，逻辑理得清清楚楚

参考C）
考前冲刺倒计时，看看什么叫保姆级突击👇
📋 精准到天的 Study Plan（重难点 + 例题 + 模拟题）
📑 课后复习建议细化到每个知识点的复盘顺序
📌 时间表与易错点清单一并同步，按清单推进不慌
需要同款规划，私信占座🔥

注意：参考里的课程名、学校名、老师名，以及「无限回放」「手写笔记」「Study Plan」等交付物都只是展示结构，**本次一律不许照抄**；第 3 条的每个清单条目必须换成上方 highlights 里图中真实标注的那件事。参考里出现的 A/B+ 之类等级也不许写，除非图里可见并已填进 visibleScores。

【从示例中提炼的硬性文风要求（全部必须做到）】
1. 第 1、2 条每行 8-20 字；第 3 条清单行放宽到 12-32 字（钩子行 10-24 字），短句独立成行，行末不加句号；可用 ！？ 和空格来断句。
2. 第 1、2 条多用口语钩子：谁懂 / 谁不爱 / 谁能不爱 / 谁辅导谁知道 / 保姆式 / 拿捏 / 一键 / 一眼 / 太…了；第 3 条专业输出风禁用这些情绪词。
3. 提到老师时写成「老师名字 + 动作」（如「Sofia老师细致清晰的答疑」「kate老师带你度过每一场考核」）。
4. 不要在文案里出现课程名称或课程代码，泛指就用「这门课」「课程」。
5. 第 1、2 条整条最多 3 个 emoji（标题 1 个 + 正文 0-2 个），常用 ✅🔥💗✨🤩👍🤝💯⚡；行末收束也可以用微信表情文字（如示例5 的 [好的]）。第 3 条按专业输出风规则放宽到 6 个（其中 3-4 个是清单符号）。
6. 禁止公文腔（不要「致力于」「为您提供」「全方位」「专业团队」这类词）。
7. 示例中的老师名（Sofia/wy/Pengpeng/kate/Luna）、课程名、分数均来自真实案例，严禁照抄或编造；只允许使用本次提供的辅导老师，课程名一律不写；示例里的整句文案也严禁照搬。
8. 禁止任何性别指向单一的称呼词（姐妹们、姐妹、兄弟们、兄弟、妹子、小姐姐、帅哥美女、宝妈等都不行）；需要称呼时用「大家」「同学们」这类中性词，或者干脆不称呼直接说话。
9. 禁止低俗、粗俗或油腻的网络梗、脏话和谐音（如「稳如老狗」「老铁」「YYDS」「绝绝子」「拴Q」「牛马」「内卷到吐」以及任何脏话谐音都不行）；语言可以活泼有梗，但必须干净体面，符合品牌调性。

【素材类型对应的内容方向】
- 课堂展示：课堂讲解、知识点或公式拆解、课堂互动与节奏
- 好评分享：学生或家长的好评反馈、满意与认可
- 讲师产出：老师的讲义、笔记、批注、思维导图等产出物
- 高分喜报：出分、提分、拿到理想成绩的喜报（若附带成绩截图，必须写出图中真实分数/等级）
- 课后答疑：课后群内答疑、随时响应、疑难问题解决
- 客户复购：老学员继续续课、复购与长期陪伴
- 辅导下单：学生咨询后完成辅导下单、付款报名的截图或记录
- 辅导展示：辅导过程与辅导成果的展示，如讲解片段、辅导记录、答疑过程

【语气】
整体往「专业、有信息量」靠：少用纯情绪感叹，多写图里看得见的具体动作和交付物。第 1、2 条真诚口语化、像老师或学生的真实分享，单条正文最多点缀 2 个 emoji（元气热情风放宽到 4 个）；第 3 条专业输出风用机构说明的口吻，清单符号见其专属规则。

【硬性要求】
1. 只输出 JSON，不要 markdown、不要代码块、不要任何解释；captions 数组必须恰好 3 个元素，每个元素是一整条多行文案（内部用 \\n 分行），严禁把每一行拆成单独的数组元素。
2. 除已提供的辅导老师、highlights 里的图中原词、以及 visibleScores 中图里真实可见的分数 / 等级外，严禁编造具体人名、学校名、专业名、课程代码、分数、日期；需要泛指时用「老师」「这门课」。
3. 不要出现「素材」「产品类型」「文案」「（未填写）」等内部术语或占位文字；严禁出现「没图」「无图」「没分数」「图中标注」等元描述。
4. 只允许 highlights、visibleScores、captions 三个字段，不要输出其它字段。
5. 输出前逐条自检：有图时每条是否至少 2 行来自 highlights（没有图片时跳过）；是否只有第 1 条第一行恰为「emoji + ${productType} + ${materialType}」、第 3 条没有标题行；第 3 条是否为「1 行钩子 + 3-4 行清单符号条目 + 1 行 CTA」且每个清单条目都能在图里找到依据；三条是否各写不同的重点、第 3 条与第 1 条的切入角度和用词是否完全不同；辅导老师「${teacher || '（未填写）'}」在每条里是否只完整出现 1 次（第二次提及只用「老师」）；全文是否没有出现任何课程名称或课程代码、没有任何「甩锅/丢给老师」式措辞。最后再做一次三条横向对比：开头句式、老师出现位置是否互不相同，有雷同就重写雷同的那条。`;

        const ctx = { productType, materialType, teacher, courseName, hasImages };
        const callCaptionAI = () => callAI({ prompt, images, withThinking: true }, env);
        let result = parseCaptionAI(await callCaptionAI(), ctx);
        // 缺条、或某条完全没提到图里标注的重点时，只重生成不合格的位置，最多重试一次
        if (result.slots.some((slot, index) => !slot || !result.grounded[index])) {
            try {
                const retry = parseCaptionAI(await callCaptionAI(), ctx);
                result.slots = result.slots.map((slot, index) => {
                    if (slot && result.grounded[index]) return slot;
                    const candidate = retry.slots[index];
                    if (!candidate) return slot;
                    return (retry.grounded[index] || !slot) ? candidate : slot;
                });
                if (retry.highlights.length > result.highlights.length) result.highlights = retry.highlights;
            } catch { /* 重试失败就保留第一次的文案 */ }
        }
        const { captions, captionStyles } = finalizeCaptions(result.slots);
        if (!captions.length) return createResponse({ error: 'AI 未返回文案，请重试' }, 502);

        // highlights 回传前端展示，让用户能直接核对 AI 到底读到了图里哪些标注
        return createResponse({ data: {
            captions, captionStyles, highlights: result.highlights,
            incomplete: captions.length < CAPTION_SLOT_COUNT
        } });
    } catch (error) {
        return createResponse({ error: error.message || 'AI 文案生成失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
