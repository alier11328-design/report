import fs from "fs";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const apiKey = process.env.DASHSCOPE_API_KEY;
const baseURL = process.env.DASHSCOPE_BASE_URL || "https://ark.cn-beijing.volces.com/api/plan/v3";
const model = process.env.DASHSCOPE_MODEL || "doubao-seed-2-0-lite";
const imagePath = "./examples/ai-sample-screenshots/period-feedback-schedule.png";

let imageBase64 = "";
try {
    imageBase64 = fs.readFileSync(imagePath).toString("base64");
} catch (e) {
    console.log("Warning: Image file not found, skipping image tests");
}

const tests = [
    {
        name: "agent-plan-text",
        body: {
            model: model,
            messages: [
                { role: "system", content: "You are a helpful assistant." },
                { role: "user", content: "你是谁？请只回答一句话。" }
            ]
        }
    }
];

if (imageBase64) {
    tests.push({
        name: "agent-plan-image",
        body: {
            model: model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "请读取这张图片里的排课信息，简要概括。" },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
                    ]
                }
            ]
        }
    });
}

for (const test of tests) {
    const client = new OpenAI({ apiKey, baseURL });
    try {
        const res = await client.chat.completions.create(test.body);
        const content = Array.isArray(res.choices?.[0]?.message?.content)
            ? JSON.stringify(res.choices[0].message.content)
            : String(res.choices?.[0]?.message?.content || "");
        console.log(`=== ${test.name} OK ===`);
        console.log(content.slice(0, 200));
    } catch (error) {
        console.log(`=== ${test.name} ERROR ===`);
        console.log(`status=${error.status ?? "unknown"}`);
        console.log(`message=${error.message ?? ""}`);
        const body = error.response?.data || error.error || error.cause;
        if (body) {
            console.log(`body=${JSON.stringify(body).slice(0, 500)}`);
        }
    }
}
