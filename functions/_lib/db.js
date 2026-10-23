import { SCHEMA } from './schema.js';
import { HttpError, hashPassword, iterationsFromEnv } from './util.js';

export const DEFAULT_SETTINGS = {
  panel_name: 'MAMAX',
  default_traffic_gb: '10',
  default_duration_days: '30',
  default_host: '',
  default_port: '443',
  default_sni: '',
};

let initPromise = null;

// ساخت خودکار جدول‌ها + ادمین اولیه (admin/admin) در اولین اجرا
export function ensureInit(env) {
  if (!env.DB) {
    throw new HttpError(500, 'اتصال دیتابیس (D1 Binding با نام DB) تنظیم نشده است. README مرحله ۹ را ببینید.', { code: 'NO_DB' });
  }
  if (!initPromise) {
    initPromise = init(env).catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function init(env) {
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const now = Date.now();
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM admins').first();
  if (!row || row.c === 0) {
    const hash = await hashPassword('admin', iterationsFromEnv(env));
    await env.DB.prepare(
      'INSERT OR IGNORE INTO admins (username, password_hash, must_change_password, created_at, updated_at) VALUES (?,?,1,?,?)'
    ).bind('admin', hash, now, now).run();
  }
  await env.DB.batch(
    Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
      env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)').bind(k, v, now)
    )
  );
}

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out;
}

export async function saveSettings(env, obj) {
  const now = Date.now();
  await env.DB.batch(
    Object.entries(obj).map(([k, v]) =>
      env.DB.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
      ).bind(k, String(v), now)
    )
  );
}

export async function logActivity(env, type, message, userId = null) {
  try {
    await env.DB.prepare('INSERT INTO activity (ts, type, message, user_id) VALUES (?,?,?,?)').bind(Date.now(), type, String(message).slice(0, 300), userId).run();
    if (Math.random() < 0.02) {
      await env.DB.prepare('DELETE FROM activity WHERE id <= (SELECT COALESCE(MAX(id),0) - 500 FROM activity)').run();
    }
  } catch (e) {
    console.error('activity log failed', e);
  }
}

export function publicOrigin(request, env) {
  const fixed = env.PUBLIC_URL && String(env.PUBLIC_URL).trim().replace(/\/+$/, '');
  if (fixed && /^https?:\/\//i.test(fixed)) return fixed;
  return new URL(request.url).origin;
}

// ---------- Rate limit (D1) ----------
export async function checkRate(env, key, max) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key=?').bind(key).first();
  if (row && row.reset_at > Date.now() && row.count >= max) {
    const secs = Math.ceil((row.reset_at - Date.now()) / 1000);
    throw new HttpError(429, `تعداد تلاش‌های ناموفق زیاد بود. ${Math.ceil(secs / 60)} دقیقه دیگر دوباره تلاش کنید.`, { retry_after: secs });
  }
}
export async function hitRate(env, key, windowMs) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?,1,?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END`
  ).bind(key, now + windowMs, now, now, now + windowMs).run();
}
export const clearRate = (env, key) => env.DB.prepare('DELETE FROM rate_limits WHERE key=?').bind(key).run();
