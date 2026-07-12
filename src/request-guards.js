// Guardas de request compartilhadas entre index.js (x-admin-token) e
// mcp.js/catalog-routes.js (bearer token do MCP/catálogo) — MESMO segredo por
// padrão (config.mcp.token = MCP_TOKEN || ADMIN_TOKEN), então precisa do MESMO
// rate-limit/fallback local nos três pontos de entrada, senão dois protegem o
// segredo e o terceiro vaza (era o caso antes: /mcp e /catalog/* sem limite).

// ngrok (e qualquer proxy reverso) encaminha pro processo local via TCP puro,
// então todo request tunelado chega com remoteAddress=127.0.0.1 — indistinguível
// de um request genuinamente local sem essa checagem extra. Um proxy reverso
// real sempre injeta X-Forwarded-For/X-Real-IP; um curl/painel local nunca manda.
export function isLocalRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Rate-limit simples (em memória) de tentativas FALHAS por (scope, ip) — scope
// separa admin/mcp mesmo quando o segredo é o mesmo, então um ajuste futuro
// (MCP_TOKEN distinto) continua correto sem mudar nada aqui.
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_MAX = 20;
const fails = new Map(); // "scope:ip" -> { count, resetAt }

export function tooManyAuthFails(scope, ip) {
  const rec = fails.get(`${scope}:${ip}`);
  return Boolean(rec && Date.now() < rec.resetAt && rec.count >= FAIL_MAX);
}

export function registerAuthFail(scope, ip) {
  const now = Date.now();
  for (const [k, v] of fails) if (now > v.resetAt) fails.delete(k); // varre expirados
  const key = `${scope}:${ip}`;
  const rec = fails.get(key);
  if (!rec || now > rec.resetAt) fails.set(key, { count: 1, resetAt: now + FAIL_WINDOW_MS });
  else rec.count++;
}
