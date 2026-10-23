import {
  HttpError, GB, DAY, HTTPS_PORTS, HTTP_PORTS, json, ok, fail, readJson, randomToken, hashPassword, verifyPassword,
  DUMMY_HASH, iterationsFromEnv, clientIp, vStr, vInt, vHost,
} from '../_lib/util.js';
import { ensureInit, getSettings, saveSettings, logActivity, publicOrigin, checkRate, hitRate, clearRate } from '../_lib/db.js';
import { createSession, clearCookie, requireSession, assertSameOrigin } from '../_lib/auth.js';
import { STATUS_SQL, decorateUser, buildLink } from '../_lib/model.js';

const routes = [];
const add = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler, ...opts });

export async function onRequest(ctx) {
  const { request, env } = ctx;
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      await ensureInit(env);
      const c = { ctx, env, request, url, params: m.groups || {}, now: Date.now(), origin: publicOrigin(request, env) };
      if (r.public) {
        if (request.method !== 'GET') assertSameOrigin(request, url);
      } else {
        c.session = await requireSession(c);
      }
      return await r.handler(c);
    }
    return fail(404, 'مسیر API پیدا نشد');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
    console.error(e);
    return fail(500, 'خطای داخلی سرور');
  }
}

const DB = (c) => c.env.DB;
const id = (c) => {
  const n = Number(c.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'شناسه نامعتبر است');
  return n;
};

// ---------------- Auth ----------------
add('GET', '/public', async (c) => ok({ panel_name: (await getSettings(c.env)).panel_name }), { public: true });

add('POST', '/login', async (c) => {
  const key = 'login:' + clientIp(c.request);
  await checkRate(c.env, key, 8);
  const body = await readJson(c.request);
  const username = String(body.username || '').trim().slice(0, 64);
  const password = String(body.password || '').slice(0, 256);
  const admin = await DB(c).prepare('SELECT * FROM admins WHERE username = ?').bind(username).first();
  const valid = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !valid) {
    await hitRate(c.env, key, 15 * 60 * 1000);
    throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است');
  }
  await clearRate(c.env, key);
  const { cookie, csrf } = await createSession(c.env, c.request, admin.id);
  await logActivity(c.env, 'login', `ورود مدیر «${admin.username}»`);
  return json({ ok: true, csrf, mustChange: !!admin.must_change_password }, 200, { 'set-cookie': cookie });
}, { public: true });

add('POST', '/logout', async (c) => {
  await DB(c).prepare('DELETE FROM sessions WHERE id = ?').bind(c.session.id).run();
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(c.request) });
});

add('GET', '/me', async (c) => {
  const s = await getSettings(c.env);
  return ok({ admin: { username: c.session.username, mustChange: !!c.session.must_change_password }, csrf: c.session.csrf, settings: s, https_ports: HTTPS_PORTS, http_ports: HTTP_PORTS });
});

// ---------------- Dashboard ----------------
add('GET', '/dashboard', async (c) => {
  const now = c.now;
  const t = await DB(c).prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END),0) AS disabled,
       COALESCE(SUM(CASE WHEN enabled = 1 AND expire_at IS NOT NULL AND expire_at <= ?1 THEN 1 ELSE 0 END),0) AS expired,
       COALESCE(SUM(CASE WHEN enabled = 1 AND NOT (expire_at IS NOT NULL AND expire_at <= ?1) AND traffic_limit > 0 AND up_bytes + down_bytes >= traffic_limit THEN 1 ELSE 0 END),0) AS exhausted,
       COALESCE(SUM(traffic_limit),0) AS allocated,
       COALESCE(SUM(up_bytes),0) AS up, COALESCE(SUM(down_bytes),0) AS down
     FROM users`
  ).bind(now).first();
  const since = new Date(now - 13 * DAY).toISOString().slice(0, 10);
  const [days, recent, activity] = await Promise.all([
    DB(c).prepare('SELECT day, SUM(up_bytes) AS up, SUM(down_bytes) AS down FROM traffic_usage WHERE day >= ? GROUP BY day ORDER BY day').bind(since).all(),
    DB(c).prepare('SELECT * FROM users ORDER BY id DESC LIMIT 6').all(),
    DB(c).prepare('SELECT ts, type, message FROM activity ORDER BY id DESC LIMIT 10').all(),
  ]);
  const map = new Map(days.results.map((d) => [d.day, d]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    const d = map.get(day);
    series.push({ day, up: d ? d.up : 0, down: d ? d.down : 0 });
  }
  return ok({
    stats: {
      total: t.total, disabled: t.disabled, expired: t.expired, exhausted: t.exhausted,
      active: t.total - t.disabled - t.expired - t.exhausted,
      allocated: t.allocated, used: t.up + t.down, up: t.up, down: t.down,
    },
    series,
    recent_users: recent.results.map((u) => decorateUser(u, now, c.origin)),
    activity: activity.results,
  });
});

// ---------------- Users ----------------
const likeEsc = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

add('GET', '/users', async (c) => {
  const q = (c.url.searchParams.get('search') || '').trim().slice(0, 64);
  const status = c.url.searchParams.get('status') || '';
  const limit = Math.min(100, Math.max(1, parseInt(c.url.searchParams.get('limit'), 10) || 50));
  const page = Math.max(1, parseInt(c.url.searchParams.get('page'), 10) || 1);
  const where = [], args = [];
  if (q) { where.push(`(u.name LIKE ? ESCAPE '\\' OR u.uuid LIKE ? ESCAPE '\\')`); args.push(`%${likeEsc(q)}%`, `%${likeEsc(q)}%`); }
  if (['active', 'disabled', 'expired', 'exhausted'].includes(status)) { where.push(`(${STATUS_SQL}) = ?`); args.push(c.now, status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await DB(c).prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).bind(...args).first()).n;
  const { results } = await DB(c).prepare(
    `SELECT u.*, (SELECT token FROM subscriptions s WHERE s.user_id = u.id) AS token,
       (SELECT COUNT(*) FROM user_configs uc JOIN configs cf ON cf.id = uc.config_id WHERE uc.user_id = u.id AND cf.status = 'active') AS config_count
     FROM users u ${w} ORDER BY u.id DESC LIMIT ? OFFSET ?`
  ).bind(...args, limit, (page - 1) * limit).all();
  return ok({ users: results.map((u) => decorateUser(u, c.now, c.origin)), total, page, limit });
});

function parseTraffic(body) {
  const gb = Number(body.traffic_gb);
  if (!Number.isFinite(gb) || gb < 0 || gb > 1048576) throw new HttpError(400, 'حجم ترافیک نامعتبر است (۰ = نامحدود)');
  return Math.round(gb * GB);
}
// خروجی null یعنی «بدون تغییر» (فقط در ویرایش)
function parseExpiry(body, now, allowKeep) {
  const mode = body.expire_mode;
  if (mode === 'keep' && allowKeep) return null;
  if (mode === 'never') return { expire_at: null, duration_days: 0, start_on_first_use: 0, first_used_at: null };
  if (mode === 'days') {
    const days = vInt(body.days, 'مدت اشتراک (روز)', 1, 3650);
    if (body.start_on_first_use) return { expire_at: null, duration_days: days, start_on_first_use: 1, first_used_at: null };
    return { expire_at: now + days * DAY, duration_days: days, start_on_first_use: 0, first_used_at: null };
  }
  if (mode === 'date') {
    const ts = Number(body.expire_at);
    if (!Number.isFinite(ts) || ts <= now) throw new HttpError(400, 'تاریخ انقضا باید در آینده باشد');
    return { expire_at: Math.floor(ts), duration_days: 0, start_on_first_use: 0, first_used_at: null };
  }
  throw new HttpError(400, 'نوع انقضا نامعتبر است');
}
function parseConfigIds(body) {
  if (!Array.isArray(body.config_ids)) return [];
  return [...new Set(body.config_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
}
const assignStmts = (c, userId, ids) => [
  DB(c).prepare('DELETE FROM user_configs WHERE user_id = ?').bind(userId),
  ...ids.map((cid) => DB(c).prepare('INSERT OR IGNORE INTO user_configs (user_id, config_id) SELECT ?, id FROM configs WHERE id = ?').bind(userId, cid)),
];

async function fetchUser(c, userId) {
  const u = await DB(c).prepare(
    `SELECT u.*, (SELECT token FROM subscriptions s WHERE s.user_id = u.id) AS token FROM users u WHERE u.id = ?`
  ).bind(userId).first();
  if (!u) throw new HttpError(404, 'کاربر پیدا نشد');
  return u;
}

add('POST', '/users', async (c) => {
  const body = await readJson(c.request);
  const name = vStr(body.name, 'نام کاربر', 1, 64);
  const limit = parseTraffic(body);
  const ex = parseExpiry(body, c.now, false);
  const note = String(body.note || '').slice(0, 300);
  const uuid = crypto.randomUUID();
  const token = randomToken(32);
  const r = await DB(c).prepare(
    `INSERT INTO users (name, uuid, traffic_limit, duration_days, start_on_first_use, first_used_at, expire_at, enabled, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?)`
  ).bind(name, uuid, limit, ex.duration_days, ex.start_on_first_use, ex.first_used_at, ex.expire_at, note, c.now, c.now).run();
  const userId = r.meta.last_row_id;
  try {
    await DB(c).batch([
      DB(c).prepare('INSERT INTO subscriptions (user_id, token, created_at, updated_at) VALUES (?,?,?,?)').bind(userId, token, c.now, c.now),
      ...assignStmts(c, userId, parseConfigIds(body)),
    ]);
  } catch (e) {
    await DB(c).prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    throw e;
  }
  await logActivity(c.env, 'user_create', `کاربر «${name}» ساخته شد`, userId);
  return ok({ user: decorateUser(await fetchUser(c, userId), c.now, c.origin) });
});

add('GET', '/users/:id', async (c) => {
  const userId = id(c);
  const u = await fetchUser(c, userId);
  const [cfgs, assigned, settings] = await Promise.all([
    DB(c).prepare(`SELECT c.* FROM user_configs uc JOIN configs c ON c.id = uc.config_id WHERE uc.user_id = ? AND c.status = 'active' ORDER BY c.id`).bind(userId).all(),
    DB(c).prepare('SELECT config_id FROM user_configs WHERE user_id = ?').bind(userId).all(),
    getSettings(c.env),
  ]);
  const links = cfgs.results.map((cf) => ({ config_id: cf.id, name: cf.name, link: buildLink(u.uuid, cf, settings, c.url.host) }));
  return ok({ user: decorateUser(u, c.now, c.origin), config_ids: assigned.results.map((r) => r.config_id), links });
});

add('PUT', '/users/:id', async (c) => {
  const userId = id(c);
  const old = await fetchUser(c, userId);
  const body = await readJson(c.request);
  const name = vStr(body.name, 'نام کاربر', 1, 64);
  const limit = parseTraffic(body);
  const ex = parseExpiry(body, c.now, true);
  const note = String(body.note || '').slice(0, 300);
  const stmts = [];
  if (ex) {
    stmts.push(DB(c).prepare('UPDATE users SET name=?, traffic_limit=?, note=?, duration_days=?, start_on_first_use=?, first_used_at=?, expire_at=?, updated_at=? WHERE id=?')
      .bind(name, limit, note, ex.duration_days, ex.start_on_first_use, ex.first_used_at, ex.expire_at, c.now, userId));
  } else {
    stmts.push(DB(c).prepare('UPDATE users SET name=?, traffic_limit=?, note=?, updated_at=? WHERE id=?').bind(name, limit, note, c.now, userId));
  }
  if (Array.isArray(body.config_ids)) stmts.push(...assignStmts(c, userId, parseConfigIds(body)));
  await DB(c).batch(stmts);
  await logActivity(c.env, 'user_edit', `کاربر «${old.name}» ویرایش شد`, userId);
  return ok({ user: decorateUser(await fetchUser(c, userId), c.now, c.origin) });
});

add('DELETE', '/users/:id', async (c) => {
  const u = await fetchUser(c, id(c));
  await DB(c).prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
  await logActivity(c.env, 'user_delete', `کاربر «${u.name}» حذف شد`);
  return ok();
});

const userAction = (action, fn, msg) =>
  add('POST', `/users/:id/${action}`, async (c) => {
    const u = await fetchUser(c, id(c));
    const body = await readJson(c.request);
    await fn(c, u, body);
    await logActivity(c.env, 'user_' + action.replace('-', '_'), `${msg} «${u.name}»`, u.id);
    return ok({ user: decorateUser(await fetchUser(c, u.id), c.now, c.origin) });
  });

userAction('enable', (c, u) => DB(c).prepare('UPDATE users SET enabled=1, updated_at=? WHERE id=?').bind(c.now, u.id).run(), 'فعال شد:');
userAction('disable', (c, u) => DB(c).prepare('UPDATE users SET enabled=0, updated_at=? WHERE id=?').bind(c.now, u.id).run(), 'غیرفعال شد:');
userAction('reset-traffic', (c, u) => DB(c).prepare('UPDATE users SET up_bytes=0, down_bytes=0, updated_at=? WHERE id=?').bind(c.now, u.id).run(), 'ترافیک صفر شد:');
userAction('regenerate-token', (c, u) =>
  DB(c).prepare('UPDATE subscriptions SET token=?, updated_at=? WHERE user_id=?').bind(randomToken(32), c.now, u.id).run(), 'توکن اشتراک جدید شد:');
userAction('extend', async (c, u, body) => {
  const days = vInt(body.days, 'تعداد روز', 1, 3650);
  if (u.expire_at == null && u.start_on_first_use && !u.first_used_at) {
    await DB(c).prepare('UPDATE users SET duration_days = duration_days + ?, updated_at=? WHERE id=?').bind(days, c.now, u.id).run();
  } else {
    const base = u.expire_at != null && u.expire_at > c.now ? u.expire_at : c.now;
    await DB(c).prepare('UPDATE users SET expire_at=?, updated_at=? WHERE id=?').bind(base + days * DAY, c.now, u.id).run();
  }
}, 'تمدید شد:');

// ---------------- Configs ----------------
const CONFIG_FIELDS = 'name, address, port, tls, sni, host_header, path, fingerprint, alpn, early_data, status';
function parseConfig(body) {
  const port = vInt(body.port, 'پورت', 1, 65535);
  const tls = body.tls ? 1 : 0;
  if (![...HTTPS_PORTS, ...HTTP_PORTS].includes(port)) throw new HttpError(400, `پورت ${port} در فهرست پورت‌های مجاز این پنل نیست.`);
  if (tls && !HTTPS_PORTS.includes(port)) throw new HttpError(400, `پورت ${port} فقط بدون TLS کار می‌کند. TLS را خاموش کنید یا پورت 443/8443/2053/2083/2087/2096 را بزنید.`);
  if (!tls && !HTTP_PORTS.includes(port)) throw new HttpError(400, `پورت ${port} فقط با TLS کار می‌کند. TLS را روشن کنید.`);
  const path = String(body.path || '/ws').trim();
  if (!/^\/[A-Za-z0-9._~\-\/]{0,120}$/.test(path)) throw new HttpError(400, 'Path نامعتبر است');
  const fp = String(body.fingerprint || 'chrome');
  if (!['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'randomized', ''].includes(fp)) throw new HttpError(400, 'Fingerprint نامعتبر است');
  const alpn = String(body.alpn ?? 'http/1.1');
  if (!['http/1.1', 'h2,http/1.1', ''].includes(alpn)) throw new HttpError(400, 'ALPN نامعتبر است');
  return {
    name: vStr(body.name, 'نام کانفیگ', 1, 64),
    address: vHost(body.address, 'Address'),
    port, tls,
    sni: vHost(body.sni, 'SNI'),
    host_header: vHost(body.host_header, 'Host'),
    path, fingerprint: fp, alpn,
    early_data: body.early_data ? 2048 : 0,
    status: body.status === 'disabled' ? 'disabled' : 'active',
  };
}

add('GET', '/configs', async (c) => {
  const { results } = await DB(c).prepare(
    'SELECT c.*, (SELECT COUNT(*) FROM user_configs uc WHERE uc.config_id = c.id) AS user_count FROM configs c ORDER BY c.id'
  ).all();
  return ok({ configs: results });
});

add('POST', '/configs', async (c) => {
  const body = await readJson(c.request);
  const f = parseConfig(body);
  const r = await DB(c).prepare(
    `INSERT INTO configs (${CONFIG_FIELDS}, protocol, transport, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'vless','ws',?,?)`
  ).bind(f.name, f.address, f.port, f.tls, f.sni, f.host_header, f.path, f.fingerprint, f.alpn, f.early_data, f.status, c.now, c.now).run();
  const cid = r.meta.last_row_id;
  if (body.assign_all !== false) await DB(c).prepare('INSERT OR IGNORE INTO user_configs (user_id, config_id) SELECT id, ? FROM users').bind(cid).run();
  await logActivity(c.env, 'config_create', `کانفیگ «${f.name}» ساخته شد`);
  return ok({ id: cid });
});

add('PUT', '/configs/:id', async (c) => {
  const cid = id(c);
  const f = parseConfig(await readJson(c.request));
  const r = await DB(c).prepare(
    'UPDATE configs SET name=?, address=?, port=?, tls=?, sni=?, host_header=?, path=?, fingerprint=?, alpn=?, early_data=?, status=?, updated_at=? WHERE id=?'
  ).bind(f.name, f.address, f.port, f.tls, f.sni, f.host_header, f.path, f.fingerprint, f.alpn, f.early_data, f.status, c.now, cid).run();
  if (!r.meta.changes) throw new HttpError(404, 'کانفیگ پیدا نشد');
  await logActivity(c.env, 'config_edit', `کانفیگ «${f.name}» ویرایش شد`);
  return ok();
});

add('DELETE', '/configs/:id', async (c) => {
  const cid = id(c);
  const cf = await DB(c).prepare('SELECT name FROM configs WHERE id = ?').bind(cid).first();
  if (!cf) throw new HttpError(404, 'کانفیگ پیدا نشد');
  await DB(c).prepare('DELETE FROM configs WHERE id = ?').bind(cid).run();
  await logActivity(c.env, 'config_delete', `کانفیگ «${cf.name}» حذف شد`);
  return ok();
});

// ---------------- Settings ----------------
add('GET', '/settings', async (c) => ok({ settings: await getSettings(c.env), admin: { username: c.session.username } }));

add('PUT', '/settings', async (c) => {
  const b = await readJson(c.request);
  const port = vInt(b.default_port, 'پورت پیش‌فرض', 1, 65535);
  if (![...HTTPS_PORTS, ...HTTP_PORTS].includes(port)) throw new HttpError(400, 'پورت پیش‌فرض باید یکی از پورت‌های مجاز پنل باشد');
  const gb = Number(b.default_traffic_gb);
  if (!Number.isFinite(gb) || gb < 0 || gb > 1048576) throw new HttpError(400, 'حجم پیش‌فرض نامعتبر است');
  await saveSettings(c.env, {
    panel_name: vStr(b.panel_name, 'نام پنل', 1, 40),
    default_traffic_gb: gb,
    default_duration_days: vInt(b.default_duration_days, 'مدت پیش‌فرض', 0, 3650),
    default_host: vHost(b.default_host, 'Default Host'),
    default_port: port,
    default_sni: vHost(b.default_sni, 'Default SNI'),
  });
  await logActivity(c.env, 'settings', 'تنظیمات ذخیره شد');
  return ok({ settings: await getSettings(c.env) });
});

add('POST', '/settings/security', async (c) => {
  const b = await readJson(c.request);
  const admin = await DB(c).prepare('SELECT * FROM admins WHERE id = ?').bind(c.session.admin_id).first();
  if (!(await verifyPassword(String(b.current_password || ''), admin.password_hash))) throw new HttpError(403, 'رمز عبور فعلی اشتباه است');
  const newUser = b.new_username ? String(b.new_username).trim() : admin.username;
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(newUser)) throw new HttpError(400, 'نام کاربری باید ۳ تا ۳۲ حرف انگلیسی/عدد/._- باشد');
  let hash = admin.password_hash, must = admin.must_change_password;
  if (b.new_password) {
    const pw = String(b.new_password);
    if (pw.length < 8 || pw.length > 128) throw new HttpError(400, 'رمز عبور جدید باید حداقل ۸ کاراکتر باشد');
    if (pw.toLowerCase() === 'admin' || pw.toLowerCase() === newUser.toLowerCase()) throw new HttpError(400, 'این رمز عبور بیش از حد ساده است');
    hash = await hashPassword(pw, iterationsFromEnv(c.env));
    must = 0;
  } else if (newUser === admin.username) {
    throw new HttpError(400, 'تغییری برای ذخیره وجود ندارد');
  }
  try {
    await DB(c).prepare('UPDATE admins SET username=?, password_hash=?, must_change_password=?, updated_at=? WHERE id=?').bind(newUser, hash, must, c.now, admin.id).run();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'این نام کاربری قبلاً وجود دارد');
    throw e;
  }
  if (b.new_password) await DB(c).prepare('DELETE FROM sessions WHERE admin_id = ? AND id <> ?').bind(admin.id, c.session.id).run();
  await logActivity(c.env, 'security', 'اطلاعات ورود مدیر تغییر کرد');
  return ok({ username: newUser, mustChange: !!must });
});
