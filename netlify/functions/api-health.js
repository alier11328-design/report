import { MODEL, createResponse } from './_shared/utils.js';

export default async function handler(request, context) {
    if (request.method === 'OPTIONS') return createResponse({ ok: true });
    if (request.method !== 'GET') return createResponse({ error: 'Method not allowed' }, 405);

    return createResponse({
        ok: true,
        model: process.env.DASHSCOPE_MODEL || MODEL,
        configured: Boolean(process.env.DASHSCOPE_API_KEY),
        envCheck: {
            hasApiKey: Boolean(process.env.DASHSCOPE_API_KEY),
            hasBaseUrl: Boolean(process.env.DASHSCOPE_BASE_URL),
            hasModel: Boolean(process.env.DASHSCOPE_MODEL)
        }
    });
}

export const config = { path: '/api/health' };
