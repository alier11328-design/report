import { createResponse, createError, parseBody, askQwenForJson, normalizeString } from './_shared/utils.js';

function buildPosterCaptionPrompt({ productType, materialType, teacher, courseName, hasImages }) {
    return `你是「万能班长」留学课业辅导品牌的社媒文案，负责写朋友圈可以直接发布的成品文案。

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
}

export default async function handler(request, context) {
    if (request.method === 'OPTIONS') return createResponse({ ok: true });
    if (request.method !== 'POST') return createError('Method not allowed', 405);

    try {
        const body = await parseBody(request);
        const productType = normalizeString(body?.productType);
        const materialType = normalizeString(body?.materialType);
        const teacher = normalizeString(body?.teacher);
        const courseName = normalizeString(body?.courseName);
        const images = Array.isArray(body?.images)
            ? body.images.filter(url => typeof url === 'string' && url.startsWith('data:image/')).slice(0, 3)
            : [];

        if (!productType || !materialType) return createError('缺少产品类型或素材类型', 400);

        const result = await askQwenForJson({ prompt: buildPosterCaptionPrompt({ productType, materialType, teacher, courseName, hasImages: images.length > 0 }), images, temperature: 0.8, disableThinking: true });
        const caption = normalizeString(result?.caption).trim();

        if (!caption) return createError('AI 未返回文案，请重试', 502);

        return createResponse({ data: { caption } });
    } catch (error) {
        return createError(error.message || '服务内部错误', error.statusCode || 500);
    }
}
