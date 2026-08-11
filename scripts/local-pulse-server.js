#!/usr/bin/env node
/**
 * Local static + /api/claude proxy for Market Research testing.
 * Loads ANTHROPIC_API_KEY from .env.local / .env / process env.
 * Usage: node scripts/local-pulse-server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);

function loadEnvFile(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApiClaude(req, res) {
  // Match Vercel serverless handler shape
  const handler = require(path.join(ROOT, 'api', 'claude.js'));
  const raw = await readBody(req);
  let body = raw;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
  const fauxReq = { method: req.method, body };
  const fauxRes = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) {
      send(res, this.statusCode, payload ?? '', {
        'Content-Type': this.headers['Content-Type'] || 'application/json',
        ...(this.headers['Access-Control-Allow-Origin']
          ? { 'Access-Control-Allow-Origin': this.headers['Access-Control-Allow-Origin'] }
          : {}),
      });
    },
  };
  await handler(fauxReq, fauxRes);
}

function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/') p = '/pulse/index.html';
  // Mirror vercel rewrite: serve /foo from /pulse/foo, but keep /api and repo-root files
  if (!p.startsWith('/api/') && !p.startsWith('/pulse/') && !p.startsWith('/config.js') && !p.startsWith('/Order')) {
    const pulseCandidate = path.join(ROOT, 'pulse', p);
    if (fs.existsSync(pulseCandidate) || fs.existsSync(pulseCandidate + '.html') || fs.existsSync(path.join(pulseCandidate, 'index.html'))) {
      p = '/pulse' + (p.endsWith('/') ? p + 'index.html' : p);
    }
  }
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.normalize(path.join(ROOT, p));
  if (!abs.startsWith(ROOT)) return null;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const idx = path.join(abs, 'index.html');
    return fs.existsSync(idx) ? idx : null;
  }
  return fs.existsSync(abs) ? abs : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/claude') {
      await handleApiClaude(req, res);
      return;
    }
    const file = resolveStatic(url.pathname);
    if (!file) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  } catch (err) {
    console.error(err);
    send(res, 500, 'Server error', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, () => {
  const keySet = !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'PASTE-YOUR-KEY-HERE');
  console.log(`Pulse local server http://127.0.0.1:${PORT}`);
  console.log(`Market Research: http://127.0.0.1:${PORT}/tools/market-research/`);
  console.log(`Proxy health:      http://127.0.0.1:${PORT}/api/claude`);
  console.log(`ANTHROPIC_API_KEY: ${keySet ? 'set' : 'MISSING — copy .env → .env.local and paste your key'}`);
});
