// Cloudflare Pages Functions - 健康检查
const MODEL = 'doubao-seed-2-0-lite';

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

export async function onRequestGet(context) {
    const env = context.env;
    return createResponse({
        ok: true,
        model: env.DASHSCOPE_MODEL || MODEL,
        configured: Boolean(env.DASHSCOPE_API_KEY),
        envCheck: {
            hasApiKey: Boolean(env.DASHSCOPE_API_KEY),
            hasBaseUrl: Boolean(env.DASHSCOPE_BASE_URL),
            hasModel: Boolean(env.DASHSCOPE_MODEL)
        }
    });
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
