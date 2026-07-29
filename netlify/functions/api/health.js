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
        configured: Boolean(context?.clientContext?.custom?.env?.DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY)
    });
}