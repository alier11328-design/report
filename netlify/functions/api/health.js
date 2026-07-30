import { MODEL, createResponse } from './utils.js';

export default async function handler(event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return createResponse({ ok: true });
    }

    if (event.httpMethod !== 'GET') {
        return createResponse({ error: 'Method not allowed' }, 405);
    }

    // Netlify: get env vars from Netlify.env.get() or process.env
    const apiKey = (typeof Netlify !== 'undefined' && Netlify.env?.get?.('DASHSCOPE_API_KEY')) || process.env.DASHSCOPE_API_KEY;
    
    return createResponse({
        ok: true,
        model: MODEL,
        configured: Boolean(apiKey),
        envCheck: {
            hasApiKey: Boolean(apiKey),
            hasBaseUrl: Boolean((typeof Netlify !== 'undefined' && Netlify.env?.get?.('DASHSCOPE_BASE_URL')) || process.env.DASHSCOPE_BASE_URL),
            hasModel: Boolean((typeof Netlify !== 'undefined' && Netlify.env?.get?.('DASHSCOPE_MODEL')) || process.env.DASHSCOPE_MODEL)
        }
    });
}

export const config = {
    path: '/api/health'
};
