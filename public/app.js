(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { csrf: '', admin: null, settings: { panel_name: 'MAMAX' }, httpsPorts: [], httpPorts: [], mustChange: false };
  const ui = { search: '', status: '', page: 1 };
  const GB = 1073741824;

  // ---------- helpers ----------
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < 3);
    return n.toFixed(n >= 100 ? 0 : 2) + ' ' + u[i];
  }
  const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('en-CA', { hour12: false }).replace(',', '').slice(0, 16) : '—');
  const badge = (s) => `<span class="badge b-${s}">${{ active: 'Active', disabled: 'Disabled', expired: 'Expired', exhausted: 'Traffic Exhausted' }[s] || esc(s)}</span>`;
  const panel = () => esc(S.settings.panel_name || 'MAMAX');

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.dir = 'auto';
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } finally { t.remove(); }
    }
    toast('کپی شد', 'ok');
  }
  function modal(html) {
    const el = document.createElement('div');
    el.className = 'modal';
    el.innerHTML = `<div class="box">${html}</div>`;
    el.addEventListener('mousedown', (e) => { if (e.target === el) el.remove(); });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) el.remove(); });
    document.body.appendChild(el);
    return el;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const m = document.querySelectorAll('.modal'); if (m.length) m[m.length - 1].remove(); } });
  function confirmBox(message, label = 'تأیید') {
    return new Promise((resolve) => {
      const m = modal(`<h2>تأیید عملیات</h2><p dir="auto">${esc(message)}</p><div class="acts"><button class="btn ghost" id="cf-no">انصراف</button><button class="btn bad" id="cf-ok">${esc(label)}</button></div>`);
      $('#cf-ok', m).onclick = () => { m.remove(); resolve(true); };
      $('#cf-no', m).onclick = () => { m.remove(); resolve(false); };
    });
  }
  function qrSvg(text) {
    try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag(5, 2); } catch { return null; }
  }
  function showQr(text, title) {
    const svg = qrSvg(text);
    modal(`<h2>${esc(title)}</h2>${svg ? `<div class="qr">${svg}</div>` : '<p class="err">کتابخانه QR بارگذاری نشد (اینترنت/cdnjs). لینک را کپی کنید.</p>'}
      <div class="link"><input readonly dir="ltr" value="${esc(text)}"><button class="btn ghost sm" data-act="copy" data-text="${esc(text)}">Copy</button></div>
      <div class="acts"><button class="btn ghost" data-close>Close</button></div>`);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': S.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new Error('ارتباط با سرور برقرار نشد. اینترنت را بررسی کنید.'); }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401 && path !== '/login') { S.admin = null; renderLogin(); throw new Error('نشست شما منقضی شده؛ دوباره وارد شوید.'); }
    if (!res.ok || !data || data.ok === false) throw new Error((data && data.error) || `خطای سرور (${res.status})`);
    return data;
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'bad'); } };

  // ---------- login ----------
  function renderLogin(msg = '') {
    document.title = `${S.settings.panel_name} — Login`;
    $('#app').innerHTML = `<div class="login"><div class="card"><div class="logo"><i>◆</i>${panel()}</div><p>Sign in to the control panel</p>
      <form data-form="login"><div class="f"><label>Username</label><input name="username" autocomplete="username" autofocus required></div>
      <div class="f"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
      <div class="err" dir="auto" id="login-err">${esc(msg)}</div><button class="btn" style="width:100%;justify-content:center">Login</button></form>
      <p class="sub" style="margin:18px 0 0">${panel()} © ${new Date().getFullYear()}</p></div></div>`;
  }

  // ---------- layout ----------
  const NAV = [['dashboard', 'Dashboard', '▦'], ['users', 'Users', '☰'], ['users/new', 'Add User', '＋'], ['configs', 'Configs', '⚙'], ['subscriptions', 'Subscriptions', '⇄'], ['settings', 'Settings', '✦']];
  function renderShell() {
    $('#app').innerHTML = `<div class="shell"><aside class="side" id="side"><div class="logo"><i>◆</i>${panel()}</div>
      <nav class="nav">${NAV.map(([h, l, i]) => `<a href="#/${h}" data-nav="${h}"><span>${i}</span>${l}</a>`).join('')}<button data-act="logout"><span>⏻</span>Logout</button></nav>
      <div class="sub" style="padding:10px">${esc(S.admin)}</div></aside>
      <div class="main"><div class="top"><button data-act="burger">☰</button>${panel()}</div><div class="content" id="view"></div>
      <div class="foot">${panel()} © ${new Date().getFullYear()}</div></div></div>`;
  }
  function setActive(hash) {
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const k = a.dataset.nav;
      a.classList.toggle('on', hash === k || (k === 'users' && /^users\/\d+\/edit$/.test(hash)));
    });
    $('#side') && $('#side').classList.remove('open');
  }

  // ---------- router ----------
  async function route() {
    if (!S.admin) return;
    const hash = (location.hash.replace(/^#\/?/, '') || 'dashboard').replace(/\/$/, '');
    if (!$('#view')) renderShell();
    setActive(hash);
    const v = $('#view');
    let m;
    try {
      v.innerHTML = '<p class="mut">Loading…</p>';
      if (hash === 'dashboard') await pDashboard(v);
      else if (hash === 'users') await pUsers(v);
      else if (hash === 'users/new') await pUserForm(v, null);
      else if ((m = /^users\/(\d+)\/edit$/.exec(hash))) await pUserForm(v, +m[1]);
      else if (hash === 'configs') await pConfigs(v);
      else if (hash === 'subscriptions') await pSubs(v);
      else if (hash === 'settings') await pSettings(v);
      else v.innerHTML = '<div class="card"><h2>404</h2><p class="mut">صفحه پیدا نشد.</p></div>';
    } catch (e) {
      if (!S.admin) return;
      v.innerHTML = `<div class="card"><h2>خطا در بارگذاری</h2><p class="err" dir="auto">${esc(e.message)}</p><button class="btn" data-act="reload">Retry</button></div>`;
    }
  }
  window.addEventListener('hashchange', route);
  const banner = () => (S.mustChange ? `<div class="alert" dir="auto">برای امنیت بیشتر رمز عبور پیش‌فرض را تغییر دهید. <a href="#/settings">Settings → Security</a></div>` : '');
  const head = (title, extra = '') => `<div class="head"><h1>${title}</h1><div>${extra}</div></div>`;

  // ---------- dashboard ----------
  function chart(series) {
    const W = 560, H = 160, bw = W / series.length, max = Math.max(1, ...series.map((d) => d.up + d.down));
    const bars = series.map((d, i) => {
      const hd = (d.down / max) * (H - 24), hu = (d.up / max) * (H - 24), x = i * bw + 4, w = bw - 8;
      return `<g><title>${d.day}: ↓ ${fmtBytes(d.down)}  ↑ ${fmtBytes(d.up)}</title>
        <rect x="${x}" y="${H - 18 - hd}" width="${w}" height="${hd}" rx="3" fill="#7f93ff"/>
        <rect x="${x}" y="${H - 18 - hd - hu}" width="${w}" height="${hu}" rx="3" fill="#3fcf9b"/>
        <text x="${x + w / 2}" y="${H - 4}" fill="#8a97a8" font-size="9" text-anchor="middle">${d.day.slice(8)}</text></g>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>
      <div class="legend"><span><b style="background:#7f93ff"></b>Download</span><span><b style="background:#3fcf9b"></b>Upload</span><span>آخرین ۱۴ روز (UTC)</span></div>`;
  }
  async function pDashboard(v) {
    const d = await api('GET', '/dashboard');
    const s = d.stats;
    const st = (l, val, sub = '') => `<div class="card stat"><div class="l">${l}</div><div class="v">${val}</div><div class="sub">${sub}</div></div>`;
    v.innerHTML = banner() + head('Dashboard', '<a class="btn" href="#/users/new">＋ Add User</a>') +
      `<div class="grid g4">${st('Total Users', s.total)}${st('Active Users', s.active)}${st('Disabled Users', s.disabled)}${st('Expired Users', s.expired)}${st('Traffic Exhausted', s.exhausted)}
      ${st('Total Allocated', s.allocated ? fmtBytes(s.allocated) : '∞', 'مجموع حجم تخصیص‌یافته')}${st('Total Used', fmtBytes(s.used), `↓ ${fmtBytes(s.down)} · ↑ ${fmtBytes(s.up)}`)}</div>
      <div class="grid g2" style="margin-top:16px"><div class="card"><h2 style="margin-bottom:10px">Traffic Statistics</h2>${chart(d.series)}</div>
      <div class="card"><h2 style="margin-bottom:6px">Recent Activity</h2><ul class="act">${d.activity.length ? d.activity.map((a) => `<li dir="auto">${esc(a.message)}<div class="sub">${fmtDate(a.ts)}</div></li>`).join('') : '<li class="mut">هنوز فعالیتی ثبت نشده</li>'}</ul></div></div>
      <div class="card" style="margin-top:16px"><h2 style="margin-bottom:10px">Recent Users</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Traffic</th><th>Expiration</th></tr></thead><tbody>
      ${d.recent_users.length ? d.recent_users.map((u) => `<tr><td dir="auto"><b>${esc(u.name)}</b></td><td>${badge(u.status)}</td><td>${trafficCell(u)}</td><td>${expCell(u)}</td></tr>`).join('') : '<tr><td colspan="4" class="mut">کاربری وجود ندارد</td></tr>'}</tbody></table></div></div>`;
  }

  // ---------- users ----------
  const trafficCell = (u) => `<div>${fmtBytes(u.used_bytes)} / ${u.traffic_limit ? fmtBytes(u.traffic_limit) : '∞'}</div><div class="bar"><i class="${u.percent >= 90 ? 'hi' : ''}" style="width:${u.traffic_limit ? u.percent.toFixed(1) : 0}%"></i></div>`;
  const expCell = (u) => u.expire_at ? `<div>${fmtDate(u.expire_at).slice(0, 10)}</div><div class="sub">${u.days_remaining} days left</div>` : u.pending_start ? `<div>Starts on first use</div><div class="sub">${u.duration_days} days</div>` : '<span class="mut">Unlimited</span>';
  function menu(u) {
    return `<details class="menu"><summary>Actions ▾</summary><div class="pop">
      <a href="#/users/${u.id}/edit">Edit</a>
      <button data-act="toggle" data-id="${u.id}" data-en="${u.enabled ? 0 : 1}">${u.enabled ? 'Disable' : 'Enable'}</button>
      <button data-act="reset" data-id="${u.id}" data-name="${esc(u.name)}">Reset Traffic</button>
      <button data-act="extend" data-id="${u.id}">Extend Expiration</button>
      <button data-act="copy" data-text="${esc(u.sub_url)}">Copy Subscription</button>
      <button data-act="links" data-id="${u.id}">Copy Config…</button>
      <button data-act="qr" data-text="${esc(u.sub_url)}" data-title="${esc(u.name)}">Show QR Code</button>
      <button data-act="regen" data-id="${u.id}" data-name="${esc(u.name)}">Regenerate Token</button>
      <a href="${esc(u.info_url)}" target="_blank" rel="noopener">User Info Page ↗</a>
      <button class="danger" data-act="del" data-id="${u.id}" data-name="${esc(u.name)}">Delete</button></div></details>`;
  }
  async function pUsers(v) {
    const q = new URLSearchParams({ search: ui.search, status: ui.status, page: ui.page, limit: 25 });
    const d = await api('GET', '/users?' + q);
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    v.innerHTML = banner() + head('Users', '<a class="btn" href="#/users/new">＋ Add User</a>') +
      `<div class="card"><div class="tools"><input id="u-search" placeholder="Search name or UUID…" value="${esc(ui.search)}" dir="auto">
      <select id="u-status">${['', 'active', 'disabled', 'expired', 'exhausted'].map((s) => `<option value="${s}" ${ui.status === s ? 'selected' : ''}>${s ? s[0].toUpperCase() + s.slice(1) : 'All statuses'}</option>`).join('')}</select></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Traffic</th><th>Expiration</th><th>Configs</th><th>Actions</th></tr></thead><tbody>
      ${d.users.length ? d.users.map((u) => `<tr><td dir="auto"><b>${esc(u.name)}</b><div class="sub mono">${esc(u.uuid)}</div></td><td>${badge(u.status)}</td><td>${trafficCell(u)}</td><td>${expCell(u)}</td><td>${u.config_count}</td><td>${menu(u)}</td></tr>`).join('') : '<tr><td colspan="6" class="mut">کاربری پیدا نشد</td></tr>'}
      </tbody></table></div><div class="pager"><span>${d.total} users</span><span><button class="btn ghost sm" data-act="page" data-p="${ui.page - 1}" ${ui.page <= 1 ? 'disabled' : ''}>‹ Prev</button> ${ui.page}/${pages} <button class="btn ghost sm" data-act="page" data-p="${ui.page + 1}" ${ui.page >= pages ? 'disabled' : ''}>Next ›</button></span></div></div>`;
    let t;
    $('#u-search').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { ui.search = e.target.value.trim(); ui.page = 1; route(); }, 350); };
    $('#u-status').onchange = (e) => { ui.status = e.target.value; ui.page = 1; route(); };
  }

  const TRAFFIC = [1, 5, 10, 20, 50, 100];
  const DURATIONS = [1, 3, 7, 15, 30, 60, 90];
  async function pUserForm(v, id) {
    const [cf, ud] = await Promise.all([api('GET', '/configs'), id ? api('GET', '/users/' + id) : null]);
    const u = ud && ud.user, set = S.settings;
    const gb0 = u ? u.traffic_limit / GB : Number(set.default_traffic_gb);
    const trSel = gb0 === 0 ? '0' : TRAFFIC.includes(gb0) ? String(gb0) : 'custom';
    const dur0 = Number(set.default_duration_days);
    const exSel = id ? 'keep' : dur0 === 0 ? 'never' : DURATIONS.includes(dur0) ? String(dur0) : 'custom_days';
    const picked = new Set(ud ? ud.config_ids : cf.configs.map((c) => c.id));
    v.innerHTML = banner() + head(id ? `Edit User — ${esc(u.name)}` : 'Add User') + `<div class="card" style="max-width:720px"><form data-form="user" data-id="${id || ''}">
      <div class="f"><label>Name</label><input name="name" required maxlength="64" dir="auto" value="${esc(u ? u.name : '')}" placeholder="Ali / Family-01 / MAMAX-01"></div>
      ${u ? `<div class="f"><label>UUID (خودکار)</label><input readonly class="mono" value="${esc(u.uuid)}"></div>` : ''}
      <div class="row"><div class="f"><label>Traffic Limit</label><select name="traffic_sel" id="tr-sel">${TRAFFIC.map((g) => `<option value="${g}" ${trSel === String(g) ? 'selected' : ''}>${g} GB</option>`).join('')}<option value="0" ${trSel === '0' ? 'selected' : ''}>Unlimited</option><option value="custom" ${trSel === 'custom' ? 'selected' : ''}>Custom</option></select></div>
      <div class="f" id="tr-custom" hidden><label>Custom (GB)</label><input name="traffic_custom" type="number" min="0.01" step="0.01" value="${trSel === 'custom' ? +gb0.toFixed(2) : ''}"></div></div>
      ${u ? `<p class="sub">مصرف فعلی: ${fmtBytes(u.used_bytes)} (↓ ${fmtBytes(u.down_bytes)} · ↑ ${fmtBytes(u.up_bytes)})</p>` : ''}
      <div class="row"><div class="f"><label>Expiration</label><select name="ex_sel" id="ex-sel">${id ? `<option value="keep" selected>Keep current (${u.expire_at ? fmtDate(u.expire_at) : u.pending_start ? 'starts on first use' : 'unlimited'})</option>` : ''}${DURATIONS.map((d) => `<option value="${d}" ${exSel === String(d) ? 'selected' : ''}>${d} Day${d > 1 ? 's' : ''}</option>`).join('')}<option value="never" ${exSel === 'never' ? 'selected' : ''}>Unlimited</option><option value="custom_days" ${exSel === 'custom_days' ? 'selected' : ''}>Custom days</option><option value="date">Custom date</option></select></div>
      <div class="f" id="ex-days" hidden><label>Days</label><input name="ex_days" type="number" min="1" max="3650" value="${dur0 > 0 && !DURATIONS.includes(dur0) ? dur0 : ''}"></div>
      <div class="f" id="ex-date" hidden><label>Expiration date</label><input name="ex_date" type="datetime-local"></div></div>
      <div class="f" id="ex-first"><label class="chk"><input type="checkbox" name="first_use" ${u && u.start_on_first_use ? 'checked' : ''}> Start expiration after first use <span class="sub">(مدت از اولین اتصال واقعی شروع شود)</span></label></div>
      <div class="f"><label>Configs</label><div class="cfglist">${cf.configs.length ? cf.configs.map((c) => `<label class="chk"><input type="checkbox" name="cfg" value="${c.id}" ${picked.has(c.id) ? 'checked' : ''}> <span dir="auto">${esc(c.name)}</span> <span class="sub">:${c.port} ${c.tls ? 'TLS' : 'no TLS'}${c.status !== 'active' ? ' · disabled' : ''}</span></label>`).join('') : '<span class="mut">ابتدا در بخش Configs یک کانفیگ بسازید.</span>'}</div></div>
      <div class="f"><label>Note</label><input name="note" maxlength="300" dir="auto" value="${esc(u ? u.note : '')}"></div>
      <div class="acts"><a class="btn ghost" href="#/users">Cancel</a><button class="btn">${id ? 'Save' : 'Create User'}</button></div></form></div>`;
    const sync = () => {
      $('#tr-custom').hidden = $('#tr-sel').value !== 'custom';
      const e = $('#ex-sel').value;
      $('#ex-days').hidden = e !== 'custom_days';
      $('#ex-date').hidden = e !== 'date';
      $('#ex-first').hidden = e === 'never' || e === 'keep' || e === 'date';
    };
    $('#tr-sel').onchange = sync; $('#ex-sel').onchange = sync; sync();
  }
  const submitUser = guard(async (f, btn) => {
    const fd = new FormData(f), id = f.dataset.id;
    const sel = fd.get('traffic_sel');
    if (sel === 'custom' && !(Number(fd.get('traffic_custom')) > 0)) throw new Error('حجم دلخواه را به GB وارد کنید');
    const body = { name: fd.get('name'), note: fd.get('note'), config_ids: fd.getAll('cfg').map(Number), traffic_gb: sel === 'custom' ? Number(fd.get('traffic_custom')) : Number(sel) };
    const ex = fd.get('ex_sel');
    if (ex === 'keep') body.expire_mode = 'keep';
    else if (ex === 'never') body.expire_mode = 'never';
    else if (ex === 'date') { body.expire_mode = 'date'; body.expire_at = new Date(fd.get('ex_date')).getTime(); }
    else { body.expire_mode = 'days'; body.days = ex === 'custom_days' ? Number(fd.get('ex_days')) : Number(ex); body.start_on_first_use = !!fd.get('first_use'); }
    btn.disabled = true;
    try { await api(id ? 'PUT' : 'POST', '/users' + (id ? '/' + id : ''), body); } finally { btn.disabled = false; }
    toast(id ? 'کاربر ذخیره شد' : 'کاربر ساخته شد', 'ok');
    location.hash = '#/users';
  });

  // ---------- configs ----------
  async function pConfigs(v) {
    const { configs } = await api('GET', '/configs');
    window.__cfgs = configs;
    v.innerHTML = banner() + head('Configs', '<button class="btn" data-act="cfg-new">＋ Add Config</button>') +
      `<div class="card"><p class="sub" dir="auto">پروتکل VLESS روی WebSocket اجرا می‌شود و هویت کاربر با UUID خودِ کاربر تعیین می‌شود (برای همین Config UUID جدا ندارد). فیلدهای خالی از Settings یا دامنه‌ی خود پنل پر می‌شوند.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Protocol</th><th>Address : Port</th><th>TLS / SNI</th><th>Path</th><th>Users</th><th>Status</th><th></th></tr></thead><tbody>
      ${configs.length ? configs.map((c) => `<tr><td dir="auto"><b>${esc(c.name)}</b></td><td>VLESS / ${esc(c.transport)}</td><td class="mono">${esc(c.address || S.settings.default_host || '(panel domain)')}:${c.port}</td><td>${c.tls ? 'TLS' : 'none'}<div class="sub mono">${esc(c.sni || '—')}</div></td><td class="mono">${esc(c.path)}</td><td>${c.user_count}</td><td>${badge(c.status === 'active' ? 'active' : 'disabled')}</td>
      <td><button class="btn ghost sm" data-act="cfg-edit" data-id="${c.id}">Edit</button> <button class="btn ghost sm" data-act="cfg-del" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button></td></tr>`).join('') : '<tr><td colspan="8" class="mut">هنوز کانفیگی نساخته‌اید. «Add Config» را بزنید.</td></tr>'}</tbody></table></div></div>`;
  }
  function cfgModal(c) {
    const ports = (arr, l) => `<optgroup label="${l}">${arr.map((p) => `<option value="${p}" ${c && c.port === p ? 'selected' : ''}>${p}</option>`).join('')}</optgroup>`;
    const m = modal(`<h2>${c ? 'Edit Config' : 'Add Config'}</h2><form data-form="config" data-id="${c ? c.id : ''}">
      <div class="f"><label>Config Name</label><input name="name" required maxlength="64" dir="auto" value="${esc(c ? c.name : '')}" placeholder="MAMAX-MTN"></div>
      <div class="row"><div class="f"><label>Protocol</label><select disabled><option>VLESS</option></select></div><div class="f"><label>Transport</label><select disabled><option>WebSocket (ws)</option></select></div></div>
      <div class="row"><div class="f"><label>Address (آدرس اتصال؛ دامنه یا IP تمیز)</label><input name="address" dir="ltr" value="${esc(c ? c.address : '')}" placeholder="خالی = ${esc(S.settings.default_host || 'دامنه پنل')}"></div>
      <div class="f"><label>Port</label><select name="port" id="c-port">${ports(S.httpsPorts, 'HTTPS (TLS)')}${ports(S.httpPorts, 'HTTP (بدون TLS)')}</select></div></div>
      <div class="row"><div class="f"><label>SNI</label><input name="sni" dir="ltr" value="${esc(c ? c.sni : '')}" placeholder="خالی = Host"></div>
      <div class="f"><label>Host header</label><input name="host_header" dir="ltr" value="${esc(c ? c.host_header : '')}" placeholder="خالی = دامنه پنل"></div></div>
      <div class="row"><div class="f"><label>Path (باید با /ws شروع شود)</label><input name="path" dir="ltr" required value="${esc(c ? c.path : '/ws')}"></div>
      <div class="f"><label>Fingerprint</label><select name="fingerprint">${['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'randomized'].map((x) => `<option ${c && c.fingerprint === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
      <div class="row"><div class="f"><label>ALPN</label><select name="alpn">${['http/1.1', 'h2,http/1.1'].map((x) => `<option ${c && c.alpn === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="f"><label>Status</label><select name="status"><option value="active">Active</option><option value="disabled" ${c && c.status === 'disabled' ? 'selected' : ''}>Disabled</option></select></div></div>
      <div class="f"><label class="chk"><input type="checkbox" name="tls" id="c-tls" ${!c || c.tls ? 'checked' : ''}> TLS (Security = tls)</label></div>
      <div class="f"><label class="chk"><input type="checkbox" name="early_data" ${!c || c.early_data ? 'checked' : ''}> Early Data (0-RTT، اتصال سریع‌تر)</label></div>
      ${c ? '' : '<div class="f"><label class="chk"><input type="checkbox" name="assign_all" checked> اختصاص به همه‌ی کاربران فعلی</label></div>'}
      <div class="err" id="cfg-err" dir="auto"></div><div class="acts"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save</button></div></form>`);
    const port = $('#c-port', m), tls = $('#c-tls', m);
    port.value = String(c ? c.port : 443);
    port.onchange = () => { tls.checked = S.httpsPorts.includes(+port.value); };
  }

  // ---------- subscriptions ----------
  async function pSubs(v) {
    const d = await api('GET', '/users?limit=100&page=' + ui.page);
    v.innerHTML = banner() + head('Subscriptions') + `<div class="card"><div class="table-wrap"><table><thead><tr><th>User</th><th>Status</th><th>Subscription URL</th><th>Actions</th></tr></thead><tbody>
      ${d.users.length ? d.users.map((u) => `<tr><td dir="auto"><b>${esc(u.name)}</b></td><td>${badge(u.status)}</td><td><div class="link" style="margin:0"><input readonly dir="ltr" class="mono" value="${esc(u.sub_url)}"></div></td>
      <td><button class="btn ghost sm" data-act="copy" data-text="${esc(u.sub_url)}">Copy</button> <button class="btn ghost sm" data-act="qr" data-text="${esc(u.sub_url)}" data-title="${esc(u.name)}">QR</button> <button class="btn ghost sm" data-act="links" data-id="${u.id}">Configs</button> <button class="btn ghost sm" data-act="regen" data-id="${u.id}" data-name="${esc(u.name)}">Regenerate</button></td></tr>`).join('') : '<tr><td colspan="4" class="mut">کاربری وجود ندارد</td></tr>'}</tbody></table></div>
      <p class="sub" dir="auto">لینک اشتراک را در برنامه‌هایی مثل v2rayN، v2rayNG، Hiddify، Streisand یا NekoBox به‌صورت Subscription اضافه کنید. حجم/انقضا هم در برنامه نمایش داده می‌شود.</p></div>`;
  }

  // ---------- settings ----------
  async function pSettings(v) {
    const d = await api('GET', '/settings'), s = d.settings;
    S.settings = s;
    const portOpts = [...S.httpsPorts, ...S.httpPorts].map((p) => `<option ${+s.default_port === p ? 'selected' : ''}>${p}</option>`).join('');
    v.innerHTML = banner() + head('Settings') + `<div class="grid g2"><div class="card"><h2 style="margin-bottom:12px">General & Defaults</h2><form data-form="settings">
      <div class="f"><label>Panel Name</label><input name="panel_name" required maxlength="40" value="${esc(s.panel_name)}" dir="auto"></div>
      <div class="row"><div class="f"><label>Default Traffic (GB، ۰ = نامحدود)</label><input name="default_traffic_gb" type="number" min="0" step="0.01" value="${esc(s.default_traffic_gb)}"></div>
      <div class="f"><label>Default Duration (روز، ۰ = نامحدود)</label><input name="default_duration_days" type="number" min="0" max="3650" value="${esc(s.default_duration_days)}"></div></div>
      <div class="f"><label>Default Host (دامنه/IP؛ خالی = دامنه پنل)</label><input name="default_host" dir="ltr" value="${esc(s.default_host)}"></div>
      <div class="row"><div class="f"><label>Default Port</label><select name="default_port">${portOpts}</select></div><div class="f"><label>Default SNI</label><input name="default_sni" dir="ltr" value="${esc(s.default_sni)}"></div></div>
      <div class="acts"><button class="btn">Save Settings</button></div></form></div>
      <div class="card"><h2 style="margin-bottom:12px">Security</h2><form data-form="security">
      <div class="f"><label>Admin Username</label><input name="new_username" autocomplete="username" value="${esc(d.admin.username)}"></div>
      <div class="f"><label>Current Password</label><input name="current_password" type="password" autocomplete="current-password" required></div>
      <div class="f"><label>New Password (حداقل ۸ کاراکتر؛ خالی = بدون تغییر)</label><input name="new_password" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="f"><label>Confirm New Password</label><input name="confirm_password" type="password" autocomplete="new-password"></div>
      <div class="acts"><button class="btn">Update Credentials</button></div></form></div></div>`;
  }

  // ---------- events ----------
  const acts = {
    copy: (d) => copy(d.text),
    qr: (d) => showQr(d.text, d.title || 'QR Code'),
    burger: () => $('#side').classList.toggle('open'),
    reload: () => route(),
    logout: guard(async () => { try { await api('POST', '/logout', {}); } finally { S.admin = null; renderLogin(); } }),
    page: (d) => { ui.page = Math.max(1, +d.p); route(); },
    toggle: guard(async (d) => { await api('POST', `/users/${d.id}/${d.en === '1' ? 'enable' : 'disable'}`, {}); toast('انجام شد', 'ok'); route(); }),
    reset: guard(async (d) => { if (await confirmBox(`ترافیک «${d.name}» صفر شود؟`, 'Reset')) { await api('POST', `/users/${d.id}/reset-traffic`, {}); toast('ترافیک صفر شد', 'ok'); route(); } }),
    regen: guard(async (d) => { if (await confirmBox(`توکن اشتراک «${d.name}» عوض شود؟ لینک قبلی از کار می‌افتد.`, 'Regenerate')) { await api('POST', `/users/${d.id}/regenerate-token`, {}); toast('توکن جدید ساخته شد', 'ok'); route(); } }),
    del: guard(async (d) => { if (await confirmBox(`کاربر «${d.name}» برای همیشه حذف شود؟ این کار قابل بازگشت نیست.`, 'Delete')) { await api('DELETE', '/users/' + d.id); toast('حذف شد', 'ok'); route(); } }),
    extend: (d) => {
      const m = modal(`<h2>Extend Expiration</h2><div class="f"><label>تعداد روز</label><input id="ext-days" type="number" min="1" max="3650" value="30"></div><div class="err" id="ext-err"></div><div class="acts"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ext-ok">Extend</button></div>`);
      $('#ext-ok', m).onclick = guard(async () => { await api('POST', `/users/${d.id}/extend`, { days: Number($('#ext-days', m).value) }); m.remove(); toast('تمدید شد', 'ok'); route(); });
    },
    links: guard(async (d) => {
      const r = await api('GET', '/users/' + d.id);
      modal(`<h2 dir="auto">Configs — ${esc(r.user.name)}</h2>${r.links.length ? r.links.map((l) => `<div class="f"><label dir="auto">${esc(l.name)}</label><div class="link"><input readonly dir="ltr" class="mono" value="${esc(l.link)}"><button class="btn ghost sm" data-act="copy" data-text="${esc(l.link)}">Copy</button><button class="btn ghost sm" data-act="qr" data-text="${esc(l.link)}" data-title="${esc(l.name)}">QR</button></div></div>`).join('') : '<p class="mut">برای این کاربر کانفیگ فعالی وجود ندارد.</p>'}<div class="acts"><button class="btn ghost" data-close>Close</button></div>`);
    }),
    'cfg-new': () => cfgModal(null),
    'cfg-edit': (d) => cfgModal(window.__cfgs.find((c) => c.id === +d.id)),
    'cfg-del': guard(async (d) => { if (await confirmBox(`کانفیگ «${d.name}» حذف شود؟ از همه‌ی کاربران برداشته می‌شود.`, 'Delete')) { await api('DELETE', '/configs/' + d.id); toast('حذف شد', 'ok'); route(); } }),
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !acts[el.dataset.act]) return;
    const det = el.closest('details.menu'); if (det) det.open = false;
    acts[el.dataset.act](el.dataset, el);
  });
  document.addEventListener('click', (e) => { document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; }); });

  const forms = {
    login: async (f, btn) => {
      const fd = new FormData(f);
      btn.disabled = true;
      try {
        const r = await api('POST', '/login', { username: fd.get('username'), password: fd.get('password') });
        S.csrf = r.csrf;
        await boot();
      } catch (e) { $('#login-err').textContent = e.message; } finally { btn.disabled = false; }
    },
    user: submitUser,
    config: async (f, btn) => {
      const fd = new FormData(f), id = f.dataset.id;
      const body = { name: fd.get('name'), address: fd.get('address'), port: Number(fd.get('port')), tls: !!fd.get('tls'), sni: fd.get('sni'), host_header: fd.get('host_header'), path: fd.get('path'), fingerprint: fd.get('fingerprint'), alpn: fd.get('alpn'), early_data: !!fd.get('early_data'), status: fd.get('status'), assign_all: !!fd.get('assign_all') };
      btn.disabled = true;
      try { await api(id ? 'PUT' : 'POST', '/configs' + (id ? '/' + id : ''), body); f.closest('.modal').remove(); toast('کانفیگ ذخیره شد', 'ok'); route(); }
      catch (e) { $('#cfg-err').textContent = e.message; } finally { btn.disabled = false; }
    },
    settings: guard(async (f, btn) => {
      const fd = new FormData(f);
      btn.disabled = true;
      try {
        const r = await api('PUT', '/settings', Object.fromEntries(fd));
        S.settings = r.settings; toast('تنظیمات ذخیره شد', 'ok');
        renderShell(); route();
      } finally { btn.disabled = false; }
    }),
    security: guard(async (f, btn) => {
      const fd = new FormData(f);
      if (fd.get('new_password') !== fd.get('confirm_password')) throw new Error('تکرار رمز عبور جدید یکسان نیست');
      btn.disabled = true;
      try {
        const r = await api('POST', '/settings/security', { current_password: fd.get('current_password'), new_username: fd.get('new_username'), new_password: fd.get('new_password') });
        S.admin = r.username; S.mustChange = r.mustChange;
        toast('اطلاعات ورود به‌روز شد', 'ok');
        renderShell(); route();
      } finally { btn.disabled = false; }
    }),
  };
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    forms[f.dataset.form](f, f.querySelector('button:not([type=button]):not([data-close])'));
  });

  // ---------- boot ----------
  async function boot() {
    try {
      const me = await api('GET', '/me');
      S.csrf = me.csrf; S.admin = me.admin.username; S.mustChange = me.admin.mustChange;
      S.settings = me.settings; S.httpsPorts = me.https_ports; S.httpPorts = me.http_ports;
      renderShell(); route();
    } catch (e) {
      S.admin = null;
      try { const p = await fetch('/api/public').then((r) => r.json()); if (p.ok) S.settings.panel_name = p.panel_name; } catch { /* ignore */ }
      renderLogin(/D1|دیتابیس|Binding/.test(e.message) ? e.message : '');
    }
  }
  boot();
})();
