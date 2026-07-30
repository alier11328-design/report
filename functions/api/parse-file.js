// Cloudflare Pages Functions - 文件处理（客户端解析后直接返回）

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

export async function onRequestPost(context) {
    const { request } = context;
    try {
        const body = await request.json();
        const { text, filename } = body;

        if (!text || !filename) {
            return createResponse({ error: '缺少文本内容或文件名' }, 400);
        }

        return createResponse({ text: text.slice(0, 20000) });
    } catch (error) {
        return createResponse({ error: error.message || '文件处理失败' }, 500);
    }
}

export async function onRequestOptions() {
    return createResponse({ ok: true });
}
