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
  return elapsed < 3000;   // menos de 3 segundos rellenando = bot
}

// ── Rate limit por IP (en memoria, suficiente para una sola
//    instancia de Node) ─────────────────────────────────────────
const recentByIp = new Map();
const RATE_WINDOW = 60 * 1000; // 1 minuto
const RATE_LIMIT  = 5;          // máx 5 envíos por IP en ese minuto

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
  const arr = (recentByIp.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (arr.length >= RATE_LIMIT) return true;
  arr.push(now);
  recentByIp.set(ip, arr);
  // GC simple para que el Map no crezca infinito
  if (recentByIp.size > 1000) {
    for (const [k, v] of recentByIp.entries()) {
      if (!v.some(t => now - t < RATE_WINDOW)) recentByIp.delete(k);
    }
  }
  return false;
}

// ── API principal ───────────────────────────────────────────────
/**
 * Inspecciona el envío y devuelve { isSpam, reasons }.
 * @param req  - express Request
 * @param body - normalmente req.body
 * @param textFields - lista de claves del body que contienen texto libre
 *                    (donde tiene sentido buscar URLs / keywords / etc.)
 */
function detectSpam(req, body, textFields = []) {
  const reasons = [];

  // 1. Honeypot
  if (body._honey) reasons.push('honeypot');

  // 2. Demasiado rápido (form rellenado en <3s)
  if (isTooFast(body)) reasons.push('too_fast');

  // 3. Rate limit por IP
  if (checkRateLimit(req)) reasons.push('rate_limit');

  // 4. Inspección de los textos libres
  const allText = textFields.map(k => body[k] || '').join(' ');
  if (allText.length > 5000)               reasons.push('too_long');
  if (countUrls(allText) > 2)              reasons.push('too_many_urls');
  if (hasSpamKeywords(allText))            reasons.push('spam_keywords');
  if (hasSuspiciousAlphabet(allText))      reasons.push('suspicious_alphabet');

  // 5. Email manifiestamente bot (dominios de "tempmail" más usados)
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
      ip: getClientIp(req),
      route: req.originalUrl,
      reasons,
      email,
      preview: allText.slice(0, 120)
    });
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
  getClientIp
};
