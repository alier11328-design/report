from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "examples" / "ai-sample-screenshots"
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def font(size):
    return ImageFont.truetype(FONT_PATH, size=size)


def wrap_cn(text, width):
    lines = []
    for raw_line in text.split("\n"):
        if not raw_line:
            lines.append("")
            continue
        current = ""
        for ch in raw_line:
            current += ch
            if len(current) >= width:
                lines.append(current)
                current = ""
        if current:
            lines.append(current)
    return lines


def draw_shadow(draw, box, radius=24, fill="white", shadow=(0, 12, 28, 60)):
    x1, y1, x2, y2 = box
    sx, sy, blur, alpha = shadow
    shadow_box = (x1 + sx, y1 + sy, x2 + sx, y2 + sy)
    draw.rounded_rectangle(shadow_box, radius=radius, fill=(0, 0, 0, alpha))
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_multiline(draw, text, xy, width_chars, font_obj, fill, line_gap=8):
    x, y = xy
    lines = wrap_cn(text, width_chars)
    for line in lines:
        draw.text((x, y), line, font=font_obj, fill=fill)
        y += font_obj.size + line_gap
    return y


def create_course_outline():
    img = Image.new("RGB", (1440, 1800), "#eef3f8")
    draw = ImageDraw.Draw(img, "RGBA")

    draw.rounded_rectangle((60, 40, 1380, 1760), radius=36, fill="white")
    draw.rounded_rectangle((60, 40, 1380, 220), radius=36, fill="#b22933")
    draw.rectangle((60, 180, 1380, 220), fill="#b22933")

    draw.text((110, 88), "ECON201 Course Outline", font=font(42), fill="white")
    draw.text((110, 145), "Business Economics and Market Analysis | Autumn 2026", font=font(22), fill="#ffe7e7")

    blocks = [
        ("Subject Description",
         "本课程介绍市场供需、弹性、成本结构、竞争市场与宏观环境分析。学生需要结合真实商业案例，运用基础经济模型完成分析与报告。"),
        ("Learning Outcomes",
         "1. 解释核心微观与宏观经济概念。\n2. 运用图表与数据分析市场变化。\n3. 评估政策与商业决策对企业的影响。\n4. 撰写结构清晰的经济分析报告。"),
        ("Assessment",
         "Quiz 1 (Week 4) 15%\nGroup Presentation (Week 7) 20%\nCase Report (Week 9) 25%\nFinal Exam (Exam Week) 40%"),
        ("Weekly Topics",
         "Week 1 经济学导论与市场机制\nWeek 2 需求、供给与均衡\nWeek 3 弹性与消费者行为\nWeek 4 成本、收益与企业决策\nWeek 5 市场结构分析\nWeek 6 宏观指标与经济周期\nWeek 7 货币政策与财政政策\nWeek 8-10 商业案例分析与汇报"),
    ]

    top = 270
    for title, content in blocks:
        draw.rounded_rectangle((100, top, 1340, top + 300), radius=28, fill="#f8fafc")
        draw.text((130, top + 28), title, font=font(28), fill="#16233a")
        draw.line((130, top + 78, 1310, top + 78), fill="#d7dee7", width=2)
        draw_multiline(draw, content, (130, top + 105), 38, font(24), "#334155", line_gap=10)
        top += 340

    img.save(OUTPUT_DIR / "course-plan-outline.png")


def create_schedule_screenshot():
    img = Image.new("RGB", (1440, 1100), "#f3f6fb")
    draw = ImageDraw.Draw(img, "RGBA")

    draw.rounded_rectangle((70, 60, 1370, 1040), radius=32, fill="white")
    draw.text((110, 110), "Class Schedule", font=font(40), fill="#11253f")
    draw.text((110, 165), "Student: 黄奔涵    Course: Consumer Behaviour", font=font(22), fill="#64748b")

    headers = ["课堂名称", "实际开始时间", "实际结束时间", "实际时长"]
    rows = [
        ["Lecture 08", "2026-04-02 20:20", "2026-04-02 21:41", "1小时21分钟"],
        ["Tutorial 09", "2026-04-06 19:00", "2026-04-06 20:10", "1小时10分钟"],
        ["Review Session", "2026-04-09 20:15", "2026-04-09 21:30", "1小时15分钟"],
        ["Essay Clinic", "2026-04-13 18:30", "2026-04-13 19:35", "1小时05分钟"],
        ["Mock Exam", "2026-04-16 20:00", "2026-04-16 21:20", "1小时20分钟"],
    ]

    col_x = [110, 380, 760, 1120]
    row_top = 250
    draw.rounded_rectangle((100, row_top, 1340, row_top + 70), radius=18, fill="#bf2a32")
    for idx, head in enumerate(headers):
        draw.text((col_x[idx] + 12, row_top + 18), head, font=font(24), fill="white")

    y = row_top + 90
    for row in rows:
        draw.rounded_rectangle((100, y, 1340, y + 96), radius=18, fill="#f8fafc")
        for idx, value in enumerate(row):
            draw.text((col_x[idx] + 12, y + 28), value, font=font(24), fill="#243447")
        y += 116

    img.save(OUTPUT_DIR / "period-feedback-schedule.png")


def create_feedback_chat():
    img = Image.new("RGB", (1280, 1600), "#e9eef5")
    draw = ImageDraw.Draw(img, "RGBA")

    draw.rounded_rectangle((80, 40, 1200, 1560), radius=34, fill="#f5f7fb")
    draw.rounded_rectangle((80, 40, 1200, 150), radius=34, fill="#ffffff")
    draw.rectangle((80, 110, 1200, 150), fill="#ffffff")
    draw.text((130, 78), "课堂反馈群", font=font(36), fill="#15263f")
    draw.text((130, 120), "4月16日 周四", font=font(20), fill="#64748b")

    messages = [
        ("left", "老师", "今天学生课堂参与度不错，对消费者决策模型的理解比上周更完整，提问时也能主动回应。"),
        ("left", "老师", "目前课程主体内容已经讲完，后续会集中做 essay 结构梳理和案例论证训练。"),
        ("right", "教辅", "收到，我这边也会同步给学生复习重点，安排题目拆解和写作练习。"),
        ("left", "老师", "掌握情况整体是良好的，知识框架已经搭起来，但学术表达和论证深度还要继续加强。"),
        ("left", "老师", "建议接下来重点练 thesis statement、段落展开和引用规范，考前多做两次限时写作。"),
    ]

    y = 190
    for side, name, content in messages:
        bubble_w = 760
        bubble_h = 0
        lines = wrap_cn(content, 24)
        bubble_h = 70 + len(lines) * 34
        if side == "left":
            x1 = 120
            bubble_color = "#ffffff"
            name_color = "#bf2a32"
            text_color = "#233548"
        else:
            x1 = 380
            bubble_color = "#d13b45"
            name_color = "#7a1a20"
            text_color = "white"
        draw.text((x1, y), name, font=font(22), fill=name_color)
        draw.rounded_rectangle((x1, y + 36, x1 + bubble_w, y + 36 + bubble_h), radius=26, fill=bubble_color)
        draw_multiline(draw, content, (x1 + 28, y + 62), 24, font(26), text_color, line_gap=8)
        y += bubble_h + 86

    img.save(OUTPUT_DIR / "period-feedback-feedback-chat.png")


def create_final_report_grade():
    img = Image.new("RGB", (1440, 1500), "#eef2f7")
    draw = ImageDraw.Draw(img, "RGBA")

    draw.rounded_rectangle((90, 60, 1350, 1440), radius=34, fill="white")
    draw.rounded_rectangle((90, 60, 1350, 220), radius=34, fill="#16263f")
    draw.rectangle((90, 180, 1350, 220), fill="#16263f")
    draw.text((140, 112), "Final Progress Summary", font=font(42), fill="white")
    draw.text((140, 168), "Consumer Behaviour | Student End-of-Term Snapshot", font=font(22), fill="#ced8e6")

    cards = [
        ("最终成绩", "A- / 82"),
        ("排课次数", "10 次"),
        ("总课时", "16.1 小时"),
        ("出勤率", "95%"),
        ("任务完成率", "92%"),
        ("课堂互动率", "88%"),
    ]

    x_positions = [140, 560, 980]
    y = 280
    i = 0
    for row in range(2):
        for col in range(3):
            title, value = cards[i]
            x = x_positions[col]
            draw.rounded_rectangle((x, y, x + 260, y + 170), radius=26, fill="#f8fafc")
            draw.text((x + 28, y + 34), title, font=font(24), fill="#64748b")
            draw.text((x + 28, y + 92), value, font=font(38), fill="#bf2a32")
            i += 1
        y += 210

    sections = [
        ("学习成果总结", "学生已能独立分析消费者决策过程，能够结合理论解释品牌定位、感知价值与购买路径，并在案例讨论中呈现较强的逻辑表达。"),
        ("成绩评语", "整体表现稳定，能够按时完成任务并在讨论中提出有效观点。后期 essay 训练中进步明显，最终呈现达到课程预期目标。"),
        ("讲师寄语", "保持现在的学习节奏非常重要。建议继续加强学术写作深度和论证严谨性，未来在商业分析课程中会更有优势。"),
    ]

    top = 740
    for title, content in sections:
        draw.rounded_rectangle((130, top, 1310, top + 180), radius=28, fill="#f8fafc")
        draw.text((165, top + 24), title, font=font(28), fill="#1e293b")
        draw_multiline(draw, content, (165, top + 78), 34, font(24), "#334155", line_gap=8)
        top += 220

    img.save(OUTPUT_DIR / "final-report-grade-summary.png")


def create_final_report_teacher_chat():
    img = Image.new("RGB", (1280, 1500), "#edf1f6")
    draw = ImageDraw.Draw(img, "RGBA")

    draw.rounded_rectangle((90, 40, 1190, 1460), radius=34, fill="#f7f9fc")
    draw.rounded_rectangle((90, 40, 1190, 150), radius=34, fill="#ffffff")
    draw.rectangle((90, 110, 1190, 150), fill="#ffffff")
    draw.text((140, 80), "结课沟通记录", font=font(36), fill="#18283f")
    draw.text((140, 120), "老师与教辅沟通摘录", font=font(20), fill="#64748b")

    messages = [
        ("left", "老师", "这位学生本学期整体状态很稳定，作业和课堂参与度都不错。"),
        ("left", "老师", "学习目标基本完成，尤其在 case analysis 部分已经能独立展开，不再只停留在概念复述。"),
        ("right", "教辅", "明白，那结课报告里我会突出成果总结和后续建议。"),
        ("left", "老师", "可以写得积极一些。下学期如果继续读 marketing 相关课，建议提前加强 academic writing 和 literature review。"),
        ("left", "老师", "我对她的整体评价是认真、配合度高、执行力不错，未来还有上升空间。"),
    ]

    y = 190
    for side, name, content in messages:
        lines = wrap_cn(content, 25)
        bubble_h = 70 + len(lines) * 34
        if side == "left":
            x1 = 130
            bubble_color = "#ffffff"
            text_color = "#243447"
            name_color = "#bf2a32"
        else:
            x1 = 390
            bubble_color = "#243447"
            text_color = "#ffffff"
            name_color = "#243447"
        draw.text((x1, y), name, font=font(22), fill=name_color)
        draw.rounded_rectangle((x1, y + 34, x1 + 720, y + 34 + bubble_h), radius=24, fill=bubble_color)
        draw_multiline(draw, content, (x1 + 28, y + 58), 25, font(26), text_color, line_gap=8)
        y += bubble_h + 86

    img.save(OUTPUT_DIR / "final-report-teacher-feedback-chat.png")


def create_review_reason_chat():
    img = Image.new("RGB", (1280, 1550), "#edf2f8")
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rounded_rectangle((80, 40, 1200, 1510), radius=34, fill="#f7f9fc")
    draw.rounded_rectangle((80, 40, 1200, 150), radius=34, fill="#ffffff")
    draw.rectangle((80, 110, 1200, 150), fill="#ffffff")
    draw.text((135, 80), "售后沟通记录", font=font(36), fill="#1b2a41")
    draw.text((135, 120), "用于 AI 识别原因分析", font=font(20), fill="#64748b")

    messages = [
        ("left", "家长", "我们觉得这次作业反馈太晚了，孩子提交后两天都没有收到修改建议。"),
        ("right", "教辅", "抱歉让您久等了，我这边先核实一下老师那边的批改进度。"),
        ("left", "老师", "上周临时有考试周集中辅导，处理顺序往后排了，没有及时同步。"),
        ("right", "教辅", "另外我们内部也没有在延迟发生时主动预警，导致家长感知更差。"),
        ("left", "家长", "主要不是不能等，而是中间没人更新状态，我们完全不知道进度。"),
        ("right", "教辅", "明白，这次问题主要是反馈延迟、过程缺少同步，以及责任分工没有及时闭环。"),
    ]

    y = 190
    for side, name, content in messages:
        lines = wrap_cn(content, 23)
        bubble_h = 70 + len(lines) * 34
        if side == "left":
            x1 = 120
            bubble_color = "#ffffff"
            name_color = "#bf2a32"
            text_color = "#243447"
        else:
            x1 = 400
            bubble_color = "#bf2a32"
            name_color = "#7c2027"
            text_color = "#ffffff"
        draw.text((x1, y), name, font=font(22), fill=name_color)
        draw.rounded_rectangle((x1, y + 36, x1 + 700, y + 36 + bubble_h), radius=24, fill=bubble_color)
        draw_multiline(draw, content, (x1 + 24, y + 60), 23, font(26), text_color, line_gap=8)
        y += bubble_h + 84

    img.save(OUTPUT_DIR / "review-report-reason-chat.png")


def create_review_process_chat():
    img = Image.new("RGB", (1280, 1600), "#eef2f7")
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rounded_rectangle((80, 40, 1200, 1560), radius=34, fill="#f8fafc")
    draw.rounded_rectangle((80, 40, 1200, 150), radius=34, fill="#ffffff")
    draw.rectangle((80, 110, 1200, 150), fill="#ffffff")
    draw.text((135, 80), "售后处理过程", font=font(36), fill="#18283f")
    draw.text((135, 120), "用于 AI 识别过程复盘 / 时间线", font=font(20), fill="#64748b")

    messages = [
        ("2026-04-01 09:14", "家长反馈作业修改迟迟未回传，希望当天给出明确答复。"),
        ("2026-04-01 09:25", "教辅先安抚家长情绪，并同步向老师确认当前批改进度。"),
        ("2026-04-01 10:10", "老师回复因考试周排课集中，作业反馈被延后，预计今晚可完成。"),
        ("2026-04-01 10:18", "教辅将延期原因与预计完成时间反馈给家长，但未同步补偿方案。"),
        ("2026-04-01 21:35", "老师完成作业批改并回传修改建议。"),
        ("2026-04-02 11:00", "教辅二次回访家长，确认材料已收到，家长表示对延迟说明仍有意见。"),
        ("2026-04-02 16:30", "团队内部复盘确认：问题在于延迟预警缺失、节点跟进不足、过程更新不及时。"),
    ]

    y = 210
    for time_text, content in messages:
        draw.rounded_rectangle((120, y, 1160, y + 140), radius=24, fill="#ffffff")
        draw.rounded_rectangle((145, y + 26, 340, y + 74), radius=18, fill="#bf2a32")
        draw.text((162, y + 36), time_text, font=font(19), fill="white")
        draw_multiline(draw, content, (145, y + 90), 34, font(24), "#334155", line_gap=8)
        y += 170

    img.save(OUTPUT_DIR / "review-report-process-timeline.png")


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    create_course_outline()
    create_schedule_screenshot()
    create_feedback_chat()
    create_final_report_grade()
    create_final_report_teacher_chat()
    create_review_reason_chat()
    create_review_process_chat()
    print(f"generated: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
