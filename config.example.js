// Calastone Pulse — local API config template (optional fallback)
// Preferred: set ANTHROPIC_API_KEY in .env.local (then `npm run dev`)
// or in Vercel Project Settings so /api/claude proxies without exposing the key.
//
// Optional local static fallback:
//   cp config.example.js config.js
//   Paste your Anthropic key below.
//   config.js is gitignored and must never be committed.

window.CONFIG = {
  ANTHROPIC_API_KEY: "PASTE-YOUR-KEY-HERE", // e.g. "sk-ant-..."
  CLAUDE_MODEL: "claude-sonnet-4-6",
};
