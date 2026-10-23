import { ensureInit, getSettings, publicOrigin } from '../_lib/db.js';
import { userStatus } from '../_lib/model.js';
import { DAY, errorPage, escHtml, htmlResponse } from '../_lib/util.js';

const STATUS_FA = { active: 'فعال', disabled: 'غیرفعال', expired: 'منقضی‌شده', exhausted: 'اتمام حجم' };
const STATUS_COLOR = { active: '#3fcf9b', disabled: '#8a97a8', expired: '#f5b942', exhausted: '#ff6b7a' };

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 3);
  return `${n.toFixed(n >= 100 ? 0 : 2)} ${u[i]}`;
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  const token = String(params.token || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return htmlResponse(errorPage(404), 404);
  try {
    await ensureInit(env);
    const u = await env.DB.prepare('SELECT u.* FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').bind(token).first();
    if (!u) return htmlResponse(errorPage(404), 404);
    const settings = await getSettings(env);
    const now = Date.now();
    const status = userStatus(u, now);
    const used = u.up_bytes + u.down_bytes;
    const pct = u.traffic_limit > 0 ? Math.min(100, (used / u.traffic_limit) * 100) : 0;
    const total = u.traffic_limit > 0 ? fmtBytes(u.traffic_limit) : 'نامحدود';
    const remaining = u.traffic_limit > 0 ? fmtBytes(Math.max(0, u.traffic_limit - used)) : 'نامحدود';
    let expire = 'نامحدود', days = '—';
    if (u.expire_at != null) {
      expire = new Date(u.expire_at).toISOString().slice(0, 10);
      days = String(Math.max(0, Math.ceil((u.expire_at - now) / DAY)));
    } else if (u.start_on_first_use && !u.first_used_at) {
      expire = `${u.duration_days} روز پس از اولین اتصال`;
      days = String(u.duration_days);
    }
    const subUrl = `${publicOrigin(request, env)}/sub/${token}`;
    const name = escHtml(settings.panel_name);
    const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escHtml(u.name)} — ${name}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0e131a;color:#e6ebf2;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;display:grid;place-items:center;padding:16px}
main{width:100%;max-width:460px;background:#161d26;border:1px solid #243040;border-radius:14px;padding:24px}
h1{margin:0 0 4px;font-size:20px}.brand{color:#7f93ff;font-weight:700;letter-spacing:1px;font-size:13px}
.badge{display:inline-block;padding:3px 12px;border-radius:99px;font-size:13px;color:#0e131a;background:${STATUS_COLOR[status]};margin:10px 0 18px}
.bar{height:10px;background:#243040;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;width:${pct.toFixed(1)}%;background:${status === 'exhausted' ? '#ff6b7a' : '#7f93ff'}}
dl{margin:18px 0 0;display:grid;grid-template-columns:1fr auto;gap:10px 12px}dt{color:#8a97a8}dd{margin:0;text-align:left;direction:ltr}
.sub{margin-top:20px;display:flex;gap:8px}.sub input{flex:1;min-width:0;background:#0e131a;border:1px solid #243040;color:#e6ebf2;border-radius:8px;padding:9px;direction:ltr;font-size:12px}
button{background:#7f93ff;color:#0e131a;border:0;border-radius:8px;padding:9px 14px;font-weight:600;cursor:pointer}</style></head>
<body><main><div class="brand">${name}</div><h1>${escHtml(u.name)}</h1><span class="badge">${STATUS_FA[status]}</span>
<div class="bar"><i></i></div>
<dl><dt>مصرف‌شده</dt><dd>${fmtBytes(used)}</dd><dt>باقی‌مانده</dt><dd>${remaining}</dd><dt>حجم کل</dt><dd>${total}</dd><dt>تاریخ انقضا</dt><dd>${escHtml(expire)}</dd><dt>روز باقی‌مانده</dt><dd>${days}</dd></dl>
<div class="sub"><input id="s" readonly value="${escHtml(subUrl)}"><button id="c">کپی لینک اشتراک</button></div>
</main><script>document.getElementById('c').onclick=function(){var i=document.getElementById('s');i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand('copy')});this.textContent='کپی شد'}</script></body></html>`;
    return htmlResponse(html, 200, { 'referrer-policy': 'no-referrer' });
  } catch (e) {
    console.error(e);
    return htmlResponse(errorPage(500), 500);
  }
}
