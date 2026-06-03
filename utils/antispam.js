// Filtro antispam multi-capa para los formularios del sitio.
// Sin dependencias externas. Combina varias señales y, si alguna
// salta, marca el envío como spam: el caller devuelve "gracias"
// pero NO envía email a Resend.

// ── Palabras clave típicas de spam (mensajes en español/inglés) ──
const SPAM_KEYWORDS = [
  // medicinas / adulto
  'viagra', 'cialis', 'porn', 'sex chat', 'escort',
  // gambling / casino
  'casino', 'gambling', 'bet365', 'jackpot',
  // SEO / marketing barato
  'seo services', 'cheap seo', 'guaranteed ranking', 'backlinks',
  'guest post', 'link building', 'web traffic', 'buy traffic',
  'increase your ranking', 'top of google',
  // crypto / finanzas
  'bitcoin investment', 'forex trading', 'crypto opportunity',
  'mining contract',
  // estafa genérica
  'click here', 'free money', 'make money fast', 'work from home',
  'limited offer', 'congratulations winner', 'you have won',
  'inheritance', 'nigerian prince',
  // typical bot phrases
  'best regards from', 'kind regards, mr.', 'dear sir/madam'
];

// ── Regex utilidades ────────────────────────────────────────────
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s]+/gi;
// Caracteres no latinos: si aparecen mucho en un form supuestamente
// en español, casi seguro es bot
const CYRILLIC = /[Ѐ-ӿ]/g;
const CHINESE  = /[一-鿿㐀-䶿]/g;
const ARABIC   = /[؀-ۿ]/g;
const KOREAN   = /[가-힯]/g;

function countMatches(text, regex) {
  if (!text) return 0;
  return (text.match(regex) || []).length;
}

function countUrls(text) {
  return countMatches(text, URL_REGEX);
}

function hasSpamKeywords(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return SPAM_KEYWORDS.some(kw => lower.includes(kw));
}

function hasSuspiciousAlphabet(text) {
  if (!text) return false;
  return countMatches(text, CYRILLIC) > 3 ||
         countMatches(text, CHINESE)  > 3 ||
         countMatches(text, ARABIC)   > 3 ||
         countMatches(text, KOREAN)   > 3;
}

function isTooFast(body) {
  const t = parseInt(body._t || '0', 10);
  if (!t) return false; // si el form no manda timestamp, no penalizamos
  const elapsed = Date.now() - t;
  return elapsed < 5000;   // menos de 5 segundos rellenando = bot
}

// ── Rate limit por IP (en memoria, suficiente para una sola
//    instancia de Node) ─────────────────────────────────────────
const recentByIp = new Map();
const RATE_WINDOW   = 60 * 1000;        // 1 minuto
const RATE_LIMIT    = 3;                 // máx 3 envíos por IP en ese minuto
const DAILY_WINDOW  = 24 * 60 * 60 * 1000;
const DAILY_LIMIT   = 3;                 // máx 3 envíos por IP en 24h

function getClientIp(req) {
  // server.js tiene app.set('trust proxy', 1) → req.ip ya respeta
  // el X-Forwarded-For que pone Nginx
  return (req.ip || req.headers['x-forwarded-for'] || 'unknown')
    .toString()
    .split(',')[0]
    .trim();
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  // Filtramos al rango más largo (24h) para reutilizar el array
  const arr = (recentByIp.get(ip) || []).filter(t => now - t < DAILY_WINDOW);

  // Límite diario (3 / IP / 24h)
  if (arr.length >= DAILY_LIMIT) return true;
  // Límite por minuto (3 / IP / 60s)
  const lastMinute = arr.filter(t => now - t < RATE_WINDOW);
  if (lastMinute.length >= RATE_LIMIT) return true;

  arr.push(now);
  recentByIp.set(ip, arr);
  // GC simple para que el Map no crezca infinito
  if (recentByIp.size > 5000) {
    for (const [k, v] of recentByIp.entries()) {
      if (!v.some(t => now - t < DAILY_WINDOW)) recentByIp.delete(k);
    }
  }
  return false;
}

// ── Cloudflare Turnstile (verificación server-side) ─────────────
// Si TURNSTILE_SECRET_KEY está configurada, exigimos un token válido
// para cada submission. El widget de Turnstile (en el front) lo
// genera al cargar la página y lo envía con name="cf-turnstile-response".
async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'no_token' };

  try {
    const params = new URLSearchParams();
    params.append('secret', process.env.TURNSTILE_SECRET_KEY);
    params.append('response', token);
    if (ip) params.append('remoteip', ip);

    const resp = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: params }
    );
    const data = await resp.json();
    if (!data.success) {
      return { ok: false, reason: 'turnstile_failed', errors: data['error-codes'] };
    }
    return { ok: true };
  } catch (err) {
    console.error('[antispam] error verificando Turnstile:', err.message);
    // Si Cloudflare está caído, no bloqueamos al usuario
    return { ok: true, skipped: true, error: err.message };
  }
}

// ── API principal ───────────────────────────────────────────────
/**
 * Inspecciona el envío y devuelve { isSpam, reasons }.
 * Async porque Turnstile requiere una llamada HTTPS a Cloudflare.
 *
 * @param req  - express Request
 * @param body - normalmente req.body
 * @param textFields - lista de claves del body que contienen texto libre
 *                    (donde tiene sentido buscar URLs / keywords / etc.)
 */
async function detectSpam(req, body, textFields = []) {
  const reasons = [];
  const ip = getClientIp(req);

  // 1. Cloudflare Turnstile (si está configurado, es la primera barrera)
  const turnstileToken = body['cf-turnstile-response'] || body.cf_turnstile_response;
  const tsResult = await verifyTurnstile(turnstileToken, ip);
  if (!tsResult.ok) {
    reasons.push('turnstile');
    console.warn('[antispam] Turnstile rechazó:', {
      ip,
      reason: tsResult.reason,
      errors: tsResult.errors,
      tokenPresent: !!turnstileToken,
      tokenLen: turnstileToken ? turnstileToken.length : 0
    });
  }

  // 2. Honeypot
  if (body._honey) reasons.push('honeypot');

  // 3. Demasiado rápido (form rellenado en <5s)
  if (isTooFast(body)) reasons.push('too_fast');

  // 4. Rate limit por IP
  if (checkRateLimit(req)) reasons.push('rate_limit');

  // 5. Inspección de los textos libres
  const allText = textFields.map(k => body[k] || '').join(' ');
  if (allText.length > 5000)               reasons.push('too_long');
  if (countUrls(allText) > 2)              reasons.push('too_many_urls');
  if (hasSpamKeywords(allText))            reasons.push('spam_keywords');
  if (hasSuspiciousAlphabet(allText))      reasons.push('suspicious_alphabet');

  // 6. Email manifiestamente bot (dominios de "tempmail" más usados)
  const email = (body.email || '').toLowerCase();
  const TEMP_MAIL_DOMAINS = [
    'tempmail', 'guerrillamail', '10minutemail', 'mailinator',
    'throwaway', 'yopmail', 'getnada', 'maildrop', 'sharklasers',
    'trbvm', 'dispostable', 'mvrht', 'temp-mail'
  ];
  if (TEMP_MAIL_DOMAINS.some(d => email.includes(d))) reasons.push('temp_email');

  const isSpam = reasons.length > 0;
  if (isSpam) {
    console.warn('[antispam] BLOCKED', {
      ip,
      route: req.originalUrl,
      reasons,
      email,
      preview: allText.slice(0, 120)
    });
  } else {
    console.info('[antispam] PASS', { ip, route: req.originalUrl, email });
  }
  return { isSpam, reasons };
}

module.exports = {
  detectSpam,
  hasSpamKeywords,
  hasSuspiciousAlphabet,
  countUrls,
  isTooFast,
  checkRateLimit,
  getClientIp,
  verifyTurnstile
};
