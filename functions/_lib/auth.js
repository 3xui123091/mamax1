import { HttpError, randomToken, sha256Hex, parseCookies, safeEqual, clientIp } from './util.js';

const COOKIE_SECURE = '__Host-mamax_session';
const COOKIE_PLAIN = 'mamax_session';

function ttlSeconds(env) {
  const d = parseInt(env.SESSION_TTL_DAYS, 10);
  return (d >= 1 && d <= 90 ? d : 7) * 86400;
}
const isHttps = (request) => new URL(request.url).protocol === 'https:';

export async function createSession(env, request, adminId) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  const ttl = ttlSeconds(env);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (id, admin_id, csrf, ip, user_agent, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(await sha256Hex(token), adminId, csrf, clientIp(request), (request.headers.get('user-agent') || '').slice(0, 200), now, now + ttl * 1000)
    .run();
  const https = isHttps(request);
  const cookie = `${https ? COOKIE_SECURE : COOKIE_PLAIN}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${https ? '; Secure' : ''}`;
  return { cookie, csrf };
}

export function clearCookie(request) {
  const https = isHttps(request);
  return `${https ? COOKIE_SECURE : COOKIE_PLAIN}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${https ? '; Secure' : ''}`;
}

export async function getSession(env, request) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[COOKIE_SECURE] || cookies[COOKIE_PLAIN];
  if (!token || token.length < 20 || token.length > 100) return null;
  const id = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.csrf, s.expires_at, a.id AS admin_id, a.username, a.must_change_password
     FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
    return null;
  }
  return row;
}

// بررسی نشست + CSRF (Origin و توکن) برای درخواست‌های تغییردهنده
export async function requireSession({ env, request, url }) {
  const session = await getSession(env, request);
  if (!session) throw new HttpError(401, 'ابتدا وارد پنل شوید', { code: 'UNAUTHENTICATED' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    assertSameOrigin(request, url);
    if (!safeEqual(request.headers.get('x-csrf-token') || '', session.csrf)) {
      throw new HttpError(403, 'توکن امنیتی (CSRF) نامعتبر است. صفحه را رفرش کنید.', { code: 'CSRF' });
    }
  }
  return session;
}

export function assertSameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* ignore */ }
    if (host !== url.host) throw new HttpError(403, 'درخواست از مبدأ نامعتبر', { code: 'ORIGIN' });
  }
}
