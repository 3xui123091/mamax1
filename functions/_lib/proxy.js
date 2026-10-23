// هسته‌ی پروکسی MAMAX: VLESS روی WebSocket با Cloudflare TCP Sockets.
// حسابداری واقعی: تعداد بایت‌های بالا/پایین‌رفته از همین Worker شمرده و در D1 ذخیره می‌شود.
import { connect } from 'cloudflare:sockets';
import { parseVlessHeader, splitUdp, frameUdp, decodeEarlyData, concat } from './protocol.js';

const USER_TTL = 5000;        // مدت کش اطلاعات کاربر در هر Isolate
const NEG_TTL = 30000;        // کش کاربر ناشناس (جلوگیری از فشار روی D1)
const FLUSH_EVERY = 10000;    // هر چند میلی‌ثانیه مصرف در D1 ثبت شود
const NEAR_LIMIT = 268435456; // نزدیک پایان حجم (256MB): ثبت مکرر برای قطع دقیق‌تر

const users = new Map();      // uuid -> state
const pending = new Set();    // کاربرانی که مصرف ثبت‌نشده دارند
let lastFlush = Date.now();
let flushing = null;
let active = 0;

const USER_SQL = 'SELECT id,name,traffic_limit,up_bytes,down_bytes,enabled,expire_at,duration_days,start_on_first_use,first_used_at FROM users WHERE uuid = ?';

function applyRow(st, r) {
  st.limit = r.traffic_limit;
  st.used = r.up_bytes + r.down_bytes;
  st.enabled = r.enabled === 1;
  st.expireAt = r.expire_at;
  st.duration = r.duration_days;
  st.startOnFirst = r.start_on_first_use === 1;
  st.firstUsedAt = r.first_used_at;
  st.fetched = Date.now();
}

async function loadUser(env, uuid) {
  const now = Date.now();
  const c = users.get(uuid);
  if (c && now - c.fetched < (c.missing ? NEG_TTL : USER_TTL)) return c.missing ? null : c;
  const r = await env.DB.prepare(USER_SQL).bind(uuid).first();
  if (!r) {
    if (users.size > 5000) for (const [k, v] of users) if (v.missing) users.delete(k);
    users.set(uuid, { missing: true, fetched: now });
    return null;
  }
  const st = c && !c.missing ? c : { uuid, up: 0, down: 0 };
  st.id = r.id;
  st.name = r.name;
  applyRow(st, r);
  users.set(uuid, st);
  return st;
}

const allowed = (st, now) =>
  st.enabled && (st.expireAt == null || now < st.expireAt) && (!st.limit || st.used + st.up + st.down < st.limit);

async function markFirstUse(env, st) {
  if (!st.startOnFirst || st.firstUsedAt) return;
  const now = Date.now();
  const exp = st.duration > 0 ? now + st.duration * 86400000 : null;
  await env.DB.prepare('UPDATE users SET first_used_at=?, expire_at=?, updated_at=? WHERE id=? AND first_used_at IS NULL').bind(now, exp, now, st.id).run();
  st.firstUsedAt = now;
  st.expireAt = exp;
}

export function flushAll(env) {
  if (flushing) return flushing.then(() => (pending.size ? flushAll(env) : undefined));
  flushing = doFlush(env).finally(() => { flushing = null; });
  return flushing;
}

async function doFlush(env) {
  lastFlush = Date.now();
  const list = [];
  for (const st of pending) {
    const up = st.up, down = st.down;
    if (!up && !down) continue;
    st.up -= up;
    st.down -= down;
    list.push({ st, up, down });
  }
  pending.clear();
  if (!list.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const batch = [];
  for (const { st, up, down } of list) {
    batch.push(
      env.DB.prepare('UPDATE users SET up_bytes = up_bytes + ?, down_bytes = down_bytes + ? WHERE id = ?').bind(up, down, st.id),
      env.DB.prepare(
        'INSERT INTO traffic_usage (user_id, day, up_bytes, down_bytes) VALUES (?,?,?,?) ON CONFLICT(user_id, day) DO UPDATE SET up_bytes = up_bytes + excluded.up_bytes, down_bytes = down_bytes + excluded.down_bytes'
      ).bind(st.id, day, up, down),
      env.DB.prepare('SELECT traffic_limit, up_bytes, down_bytes, enabled, expire_at FROM users WHERE id = ?').bind(st.id)
    );
  }
  try {
    const res = await env.DB.batch(batch);
    list.forEach(({ st }, i) => {
      const row = res[i * 3 + 2].results[0];
      if (row) {
        st.limit = row.traffic_limit;
        st.used = row.up_bytes + row.down_bytes;
        st.enabled = row.enabled === 1;
        st.expireAt = row.expire_at;
        st.fetched = Date.now();
      }
    });
  } catch (e) {
    console.error('traffic flush failed', e);
    for (const { st, up, down } of list) { st.up += up; st.down += down; pending.add(st); }
  }
}

function pickProxyIp(env) {
  const list = String(env.PROXY_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

export function startSession(ws, request, ctx) {
  const env = ctx.env;
  const dohUrl = env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
  let st = null, remote = null, writer = null, closed = false;
  let mode = 'init', respHeader = null, headerSent = false, gotData = false;
  let firstPayload = new Uint8Array(0), udpBuf = new Uint8Array(0), target = null;
  active++;

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try { ws.close(1000); } catch { /* already closed */ }
    try { remote && remote.close(); } catch { /* ignore */ }
    active--;
    if (active === 0 && pending.size) ctx.waitUntil(flushAll(env));
  };

  const tick = () => {
    if (closed) return;
    const now = Date.now();
    if (st && !allowed(st, now)) return close();
    if (!pending.size) return;
    const near = st && st.limit && st.limit - (st.used + st.up + st.down) < NEAR_LIMIT;
    if (now - lastFlush >= (near ? 3000 : FLUSH_EVERY)) ctx.waitUntil(flushAll(env));
  };
  const timer = setInterval(tick, 3000);

  const toClient = (chunk) => {
    if (closed) return;
    if (st) {
      st.down += chunk.byteLength;
      pending.add(st);
      if (!allowed(st, Date.now())) return close();
    }
    if (!headerSent) {
      headerSent = true;
      ws.send(concat(respHeader, chunk));
    } else {
      ws.send(chunk);
    }
  };

  const pump = (sock, allowRetry) => {
    sock.readable
      .pipeTo(new WritableStream({ write(chunk) { gotData = true; toClient(chunk); } }))
      .catch(() => {})
      .then(() => {
        if (closed) return;
        if (!gotData && allowRetry) return retry();
        close();
      });
  };

  const dial = async (host, port, first, allowRetry) => {
    try {
      remote = connect({ hostname: host, port });
      writer = remote.writable.getWriter();
      if (first.byteLength) await writer.write(first);
    } catch {
      if (allowRetry) return retry();
      return close();
    }
    pump(remote, allowRetry);
  };

  const retry = async () => {
    const p = pickProxyIp(env);
    try { remote && remote.close(); } catch { /* ignore */ }
    if (!p) return close();
    const m = /^(.*?)(?::(\d+))?$/.exec(p);
    await dial(m[1], m[2] ? parseInt(m[2], 10) : target.port, firstPayload, false);
  };

  const queryDns = async (q) => {
    try {
      const r = await fetch(dohUrl, { method: 'POST', headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' }, body: q });
      toClient(frameUdp(new Uint8Array(await r.arrayBuffer())));
    } catch { /* DNS failure: ignore */ }
  };
  const udpFeed = (data) => {
    udpBuf = udpBuf.length ? concat(udpBuf, data) : data;
    const { frames, rest } = splitUdp(udpBuf);
    udpBuf = rest;
    for (const f of frames) queryDns(f);
  };

  const init = async (data) => {
    const h = parseVlessHeader(data);
    if (h.error) return close();
    st = await loadUser(env, h.uuid);
    if (!st || !allowed(st, Date.now())) return close();
    await markFirstUse(env, st);
    respHeader = new Uint8Array([h.version, 0]);
    const payload = data.subarray(h.offset);
    st.up += payload.byteLength;
    pending.add(st);
    if (h.cmd === 2) {
      if (h.port !== 53) return close(); // فقط DNS روی UDP پشتیبانی می‌شود
      mode = 'udp';
      if (payload.length) udpFeed(payload);
      return;
    }
    if (h.cmd !== 1 || h.port === 25) return close(); // Mux پشتیبانی نمی‌شود؛ پورت 25 مسدود است
    mode = 'tcp';
    target = h;
    firstPayload = payload;
    await dial(h.host, h.port, payload, !!env.PROXY_IP);
  };

  const handle = async (data) => {
    if (closed) return;
    if (mode === 'init') return init(data);
    if (!allowed(st, Date.now())) return close();
    st.up += data.byteLength;
    pending.add(st);
    if (mode === 'tcp') {
      if (writer) await writer.write(data);
    } else {
      udpFeed(data);
    }
  };

  let chain = Promise.resolve();
  const enqueue = (data) => { chain = chain.then(() => handle(data)).catch(() => close()); };

  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') return close();
    enqueue(new Uint8Array(e.data));
  });
  ws.addEventListener('close', close);
  ws.addEventListener('error', close);

  const early = decodeEarlyData(request.headers.get('sec-websocket-protocol'));
  if (early) enqueue(early);
}
