// Proxies Anthropic Messages API using server-side ANTHROPIC_API_KEY.
// Keeps the key out of the browser bundle / config.js.

function readKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'PASTE-YOUR-KEY-HERE') return null;
  return apiKey;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Lightweight health check — never returns the key.
  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      keyConfigured: !!readKey(),
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = readKey();
  if (!apiKey) {
    sendJson(res, 500, {
      error: {
        message:
          'ANTHROPIC_API_KEY is not set on the server. Add it in Vercel Project Settings → Environment Variables (Production + Preview), or in .env.local for local use with `npm run dev`.',
      },
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    sendJson(res, 400, { error: { message: 'Request body required' } });
    return;
  }

  const model = body.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const payload = { ...body, model };

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(text);
  } catch (err) {
    console.error('Anthropic proxy failed:', err);
    sendJson(res, 502, {
      error: { message: err.message || 'Upstream request failed' },
    });
  }
};
