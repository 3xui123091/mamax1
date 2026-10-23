import { DAY } from './util.js';

export const STATUS_SQL = `CASE
  WHEN u.enabled = 0 THEN 'disabled'
  WHEN u.expire_at IS NOT NULL AND u.expire_at <= ? THEN 'expired'
  WHEN u.traffic_limit > 0 AND u.up_bytes + u.down_bytes >= u.traffic_limit THEN 'exhausted'
  ELSE 'active' END`;

export function userStatus(u, now = Date.now()) {
  if (!u.enabled) return 'disabled';
  if (u.expire_at != null && u.expire_at <= now) return 'expired';
  if (u.traffic_limit > 0 && u.up_bytes + u.down_bytes >= u.traffic_limit) return 'exhausted';
  return 'active';
}

export function decorateUser(u, now, origin) {
  const used = u.up_bytes + u.down_bytes;
  const limit = u.traffic_limit;
  return {
    id: u.id,
    name: u.name,
    uuid: u.uuid,
    enabled: !!u.enabled,
    status: userStatus(u, now),
    traffic_limit: limit,
    up_bytes: u.up_bytes,
    down_bytes: u.down_bytes,
    used_bytes: used,
    remaining_bytes: limit > 0 ? Math.max(0, limit - used) : null,
    percent: limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
    expire_at: u.expire_at,
    duration_days: u.duration_days,
    start_on_first_use: !!u.start_on_first_use,
    first_used_at: u.first_used_at,
    pending_start: !!u.start_on_first_use && !u.first_used_at,
    days_remaining: u.expire_at != null ? Math.max(0, Math.ceil((u.expire_at - now) / DAY)) : null,
    note: u.note,
    created_at: u.created_at,
    updated_at: u.updated_at,
    token: u.token || null,
    config_count: u.config_count ?? undefined,
    sub_url: u.token ? `${origin}/sub/${u.token}` : null,
    info_url: u.token ? `${origin}/user/${u.token}` : null,
  };
}

const wrapV6 = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

// ساخت لینک VLESS واقعی. اگر Address/Host/SNI خالی باشد از تنظیمات یا دامنه خود پنل استفاده می‌شود.
export function buildLink(uuid, cfg, settings, reqHost) {
  const hostHeader = cfg.host_header || settings.default_host || reqHost;
  const address = cfg.address || settings.default_host || reqHost;
  const sni = cfg.sni || settings.default_sni || hostHeader;
  const q = new URLSearchParams();
  q.set('encryption', 'none');
  q.set('security', cfg.tls ? 'tls' : 'none');
  if (cfg.tls) {
    q.set('sni', sni);
    if (cfg.fingerprint) q.set('fp', cfg.fingerprint);
    if (cfg.alpn) q.set('alpn', cfg.alpn);
  }
  q.set('type', 'ws');
  q.set('host', hostHeader);
  q.set('path', cfg.path + (cfg.early_data > 0 ? `?ed=${cfg.early_data}` : ''));
  return `vless://${uuid}@${wrapV6(address)}:${cfg.port}?${q.toString()}#${encodeURIComponent(cfg.name)}`;
}
