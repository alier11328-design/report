import { createResponse } from './_shared.js';

export async function onRequestGet(context) {
    const env = context.env;
    return createResponse({
        ok: true,
        model: env.DASHSCOPE_MODEL || 'doubao-seed-2-0-lite',
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
