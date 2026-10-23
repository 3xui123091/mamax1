import { ensureInit, getSettings, publicOrigin } from '../_lib/db.js';
import { buildLink } from '../_lib/model.js';
import { errorPage, htmlResponse, utf8b64 } from '../_lib/util.js';

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const token = String(params.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return htmlResponse(errorPage(404), 404);
  try {
    await ensureInit(env);
    const u = await env.DB.prepare(
      `SELECT u.*, s.id AS sub_id FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    ).bind(token).first();
    if (!u) return htmlResponse(errorPage(404), 404);
    const now = Date.now();
    const settings = await getSettings(env);
    const url = new URL(request.url);
    const used = u.up_bytes + u.down_bytes;
    const active = u.enabled === 1 && (u.expire_at == null || u.expire_at > now) && (!u.traffic_limit || used < u.traffic_limit);
    let links = [];
    if (active) {
      const { results } = await env.DB.prepare(
        `SELECT c.* FROM user_configs uc JOIN configs c ON c.id = uc.config_id WHERE uc.user_id = ? AND c.status = 'active' ORDER BY c.id`
      ).bind(u.id).all();
      links = results.map((c) => buildLink(u.uuid, c, settings, url.host));
    }
    ctx.waitUntil(
      env.DB.prepare('UPDATE subscriptions SET last_access_at=?, access_count=access_count+1 WHERE id=? AND (last_access_at IS NULL OR last_access_at < ?)')
        .bind(now, u.sub_id, now - 60000).run().catch(() => {})
    );
    const text = links.join('\n');
    const body = url.searchParams.get('raw') === '1' ? text : utf8b64(text);
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'profile-title': 'base64:' + utf8b64(`${settings.panel_name} - ${u.name}`),
        'profile-update-interval': '1',
        'profile-web-page-url': `${publicOrigin(request, env)}/user/${token}`,
        'subscription-userinfo': `upload=${u.up_bytes}; download=${u.down_bytes}; total=${u.traffic_limit}; expire=${u.expire_at ? Math.floor(u.expire_at / 1000) : 0}`,
      },
    });
  } catch (e) {
    console.error(e);
    return htmlResponse(errorPage(500), 500);
  }
}
