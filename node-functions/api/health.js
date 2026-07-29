import { MODEL, createResponse } from './utils.js';

export default async function onRequest(context) {
    const request = context.request;
    
    if (request.method === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (request.method !== 'GET') {
        return createResponse({ error: 'Method not allowed' }, 405);
    }

    return createResponse({
        ok: true,
        model: MODEL,
        configured: Boolean(context.env.DASHSCOPE_API_KEY)
    });
}