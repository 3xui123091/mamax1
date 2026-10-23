// توابع کمکی عمومی MAMAX (فقط Web APIs استاندارد Cloudflare Workers)
const te = new TextEncoder();
export const GB = 1073741824;
export const DAY = 86400000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
export const ok = (data = {}) => json({ ok: true, ...data });
export const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const utf8b64 = (str) => b64(te.encode(str));

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function sha256Hex(str) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  const x = te.encode(String(a));
  const y = te.encode(String(b));
  let r = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) r |= (x[i] || 0) ^ (y[i] || 0);
  return r === 0;
}

// ---------- Password hashing (PBKDF2-SHA256, Web Crypto) ----------
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export function iterationsFromEnv(env) {
  const n = parseInt(env && env.PBKDF2_ITERATIONS, 10);
  return n >= 1000 && n <= 100000 ? n : 100000; // سقف Workers برای PBKDF2: 100000
}
export async function hashPassword(password, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}
export async function verifyPassword(password, stored) {
  const [alg, it, salt, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2' || !salt || !hash) return false;
  const bits = await derive(password, unb64(salt), parseInt(it, 10) || 100000);
  return safeEqual(b64(bits), hash);
}
export const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// ---------- HTTP helpers ----------
export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

export async function readJson(request) {
  const text = await request.text();
  if (text.length > 200000) throw new HttpError(413, 'حجم درخواست بیش از حد مجاز است');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object') throw new Error('bad');
    return v;
  } catch {
    throw new HttpError(400, 'بدنه درخواست JSON معتبر نیست');
  }
}

export const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Validation ----------
export function vStr(v, field, min, max) {
  const s = String(v ?? '').trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${field} باید بین ${min} تا ${max} کاراکتر باشد`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new HttpError(400, `${field} شامل کاراکتر غیرمجاز است`);
  return s;
}
export function vInt(v, field, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} باید عدد صحیح بین ${min} تا ${max} باشد`);
  return n;
}
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export function vHost(v, field, allowEmpty = true) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (allowEmpty) return '';
    throw new HttpError(400, `${field} الزامی است`);
  }
  if (HOST_RE.test(s) || (s.includes(':') && /^[0-9a-fA-F:]{2,45}$/.test(s))) return s.toLowerCase();
  throw new HttpError(400, `${field} معتبر نیست (فقط دامنه یا IP)`);
}

export const HTTPS_PORTS = [443, 8443, 2053, 2083, 2087, 2096];
export const HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];

export function errorPage(status, panelName = 'MAMAX') {
  const t = { 403: ['دسترسی ممنوع', 'شما اجازه دسترسی به این صفحه را ندارید.'], 404: ['صفحه پیدا نشد', 'آدرس واردشده وجود ندارد یا منقضی شده است.'], 500: ['خطای سرور', 'مشکلی پیش آمده است. چند لحظه بعد دوباره تلاش کنید.'] }[status] || ['خطا', 'مشکلی پیش آمده است.'];
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${status} — ${escHtml(panelName)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e131a;color:#e6ebf2;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}main{text-align:center;padding:24px}b{font-size:72px;letter-spacing:2px;color:#7f93ff;display:block}h1{margin:8px 0;font-size:22px}p{color:#8a97a8;margin:0 0 20px}a{color:#7f93ff}</style></head><body><main><b>${status}</b><h1>${t[0]}</h1><p>${t[1]}</p><a href="/">${escHtml(panelName)}</a></main></body></html>`;
}
export const htmlResponse = (html, status = 200, headers = {}) =>
  new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
