import { MODEL, createResponse } from './utils.js';

export default async function handler(event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (event.httpMethod !== 'GET') {
        return createResponse({ error: 'Method not allowed' }, 405);
    }

    return createResponse({
        ok: true,
        model: MODEL,
        configured: Boolean(process.env.DASHSCOPE_API_KEY),
        envCheck: {
            hasApiKey: Boolean(process.env.DASHSCOPE_API_KEY),
            hasBaseUrl: Boolean(process.env.DASHSCOPE_BASE_URL),
            hasModel: Boolean(process.env.DASHSCOPE_MODEL)
        }
    });
}

export const config = {
    path: '/api/health'
};
