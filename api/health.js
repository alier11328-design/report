import { MODEL, createResponse } from './utils.js';

export default function handler(req, res) {
    if (req.method === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (req.method !== 'GET') {
        return createResponse({ error: 'Method not allowed' }, 405);
    }

    return createResponse({
        ok: true,
        model: MODEL,
        configured: Boolean(process.env.DASHSCOPE_API_KEY)
    });
}
