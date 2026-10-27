/* ===== core.js ===== */
/* =====================================================================
   HRM STOCK CONTROL MANAGEMENT — core: api, format, icons, components, shell
   ===================================================================== */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- API bridge (pywebview in .exe · fetch in dev · google.script.run in the Google Apps Script web app · /api proxy on Vercel) ---------------- */
const IS_WEB = !!window.HRM_WEB;   // Vercel web app: same Google backend, reached through the site's own /api/<name> proxy
const IS_GAS = IS_WEB || !!(window.google && window.google.script && window.google.script.run);
const SRC_LABEL = IS_GAS ? 'Google Sheets' : 'ไดร์ฟกลาง';
const bridgeReady = new Promise(res => {
  if (IS_GAS || window.pywebview?.api) return res(true);
  let done = false;
  window.addEventListener('pywebviewready', () => { done = true; res(true); });
  // dev/browser mode: if our own HTTP API answers, use it; otherwise keep waiting for pywebview
  setTimeout(async () => {
    if (done || window.pywebview?.api) return res(true);
    try { const r = await fetch('/api/get_rev', { method: 'POST', body: '[]' }); if (r.ok && (r.headers.get('content-type') || '').includes('json')) res(true); } catch (e) { }
  }, 250);
});
/* the GAS server is stateless: this computer's name, Officer token and Officer name travel with every call */
function gasCtx() { return { token: localStorageGet('token') || '', machine: localStorageGet('machine') || '', name: localStorageGet('officerName') || '', today_override: window.HRM_TODAY || '' }; }
function gasCall(name, args) {
  if (IS_WEB) return fetch('/api/' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args, ctx: gasCtx() }) })
    .then(r => r.text());
  return new Promise((ok, bad) => google.script.run.withSuccessHandler(ok).withFailureHandler(bad).api(name, JSON.stringify(args), JSON.stringify(gasCtx())));
}
const API_READS = new Set(['get_rev', 'app_info', 'dashboard', 'day_get', 'days_status', 'missing_days', 'month_get', 'stock_list', 'orders_list', 'receipts_list',
  'materials_list', 'material_check', 'a3_pages', 'documents_list', 'export_range', 'notes_list', 'shop_catalog', 'shop_requests', 'adjust_list', 'spend_summary', 'price_history', 'stock_trend', 'backup_list', 'backup_schedule_get', 'shop_request_get', 'audit_list', 'scan_open', 'open_folder']);
async function api(name, ...args) {
  await bridgeReady;
  let res;
  try {
    if (IS_GAS) res = JSON.parse(await gasCall(name, args));
    else if (window.pywebview?.api) res = await window.pywebview.api.call(name, args);
    else res = await (await fetch('/api/' + name, { method: 'POST', body: JSON.stringify(args) })).json();
  } catch (e) {
    App.setOnline(false);
    throw new Error(IS_GAS ? 'เชื่อมต่อ Google ไม่ได้ — ตรวจสอบอินเทอร์เน็ต' : 'เชื่อมต่อข้อมูลไม่ได้ — ตรวจสอบไดร์ฟกลาง');
  }
  if (res.ctx) {
    if ('token' in res.ctx) localStorageSet('token', res.ctx.token || '');
    if ('machine' in res.ctx) localStorageSet('machine', res.ctx.machine || '');
    if ('name' in res.ctx) localStorageSet('officerName', res.ctx.name || '');
  }
  if (!API_READS.has(name) && typeof App !== 'undefined') App._dash = null;   // any write → next dashboard is fresh
  if (res.need_login && IS_WEB) { TeamGate.show(); const e = new Error(res.error || 'กรุณาใส่รหัสทีม'); e.needLogin = true; throw e; }
  if (!res.ok) throw new Error(res.error || 'เกิดข้อผิดพลาด');
  return res.data;
}
/** open a link returned by the server (Google Sheet, Drive file …) */
function openUrl(u) { if (u) window.open(u, '_blank', 'noopener'); }
async function printHtml(html, name) {
  await bridgeReady;
  if (!IS_GAS && window.pywebview?.api) return window.pywebview.api.print_html(html, name);
  // browser / Google: print through a hidden iframe
  const fonts = typeof FONT_DATA !== 'undefined' ? html.replace(/__FONTS__([\w.-]+)/g, (m, f) => FONT_DATA[f] || '') : html.replaceAll('__FONTS__', 'fonts/');
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(f);
  f.contentDocument.open(); f.contentDocument.write(fonts); f.contentDocument.close();
  setTimeout(() => f.remove(), 60000); // the print page calls window.print() itself once fonts are ready
}
/** save a base64 file in the browser (GAS export) */
function downloadB64(b64, name, mime) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([u8], { type: mime || 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

/* ---------------- team gate (Vercel web app: team password → 30-day cookie, checked by the /api proxy) ---------------- */
const TeamGate = {
  shown: false,
  /** ?join=… from the "เข้าได้เลย" QR → sign this device in, then clean the address bar. false = carry on starting */
  async join() {
    const q = new URLSearchParams(location.search), tok = q.get('join');
    if (!tok) return false;
    q.delete('join'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    try {
      const r = await (await fetch('/api/team_login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ join: tok }) })).json();
      if (r.ok) return false;
      this.show(r.error); return true;
    } catch (e) { return false; }
  },
  show(msg) {
    if (this.shown) return; this.shown = true;
    const w = document.body.dataset.view === 'widget';
    document.getElementById('root').innerHTML = `<div class="setup"><div class="card off-card tg-card">
      <span class="mark">${typeof art === 'function' ? art('logo', 44) : ''}</span>
      <div class="off-t">${bi('HRM STOCK', 'ระบบควบคุมและจัดการสต็อก HRM')}</div>
      <p class="muted">ใส่รหัสทีมเพื่อเข้าใช้งาน${w ? ' Widget' : ''}</p>
      <form class="tg-f" autocomplete="on"><input class="input" id="tg-code" type="password" autocomplete="current-password" placeholder="รหัสทีม" aria-label="รหัสทีม" required>
      <div class="err-text" id="tg-err" role="alert">${msg ? esc(msg) : ''}</div>
      <button class="btn btn-primary" type="submit" id="tg-go">${ic('lock', 'sm')}เข้าสู่ระบบ</button></form>
      <p class="hint">เครื่องนี้จะจำไว้ 30 วัน · ขอรหัสได้จากหัวหน้าทีมหรือ Officer</p></div></div>`;
    const inp = document.getElementById('tg-code'), err = document.getElementById('tg-err'), go = document.getElementById('tg-go');
    setTimeout(() => inp.focus(), 50);
    document.querySelector('.tg-f').onsubmit = async ev => {
      ev.preventDefault(); err.textContent = ''; go.disabled = true; go.classList.add('busy');
      try {
        const r = await (await fetch('/api/team_login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: inp.value }) })).json();
        if (r.ok) { location.reload(); return; }
        err.textContent = r.error || 'เข้าสู่ระบบไม่สำเร็จ'; inp.select();
      } catch (e) { err.textContent = 'เชื่อมต่อไม่ได้ — ตรวจสอบอินเทอร์เน็ต'; }
      go.disabled = false; go.classList.remove('busy');
    };
  },
  async logout() { try { await fetch('/api/team_logout', { method: 'POST', body: '{}' }); } catch (e) { } location.reload(); },
};

/* ---------------- format ---------------- */
const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MF = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const EN_M = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TH_WD = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const EN_WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const pd = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return iso(d); };
const fmtD = s => { if (!s) return ''; const d = pd(s); return `${d.getDate()} ${TH_M[d.getMonth()]} ${d.getFullYear()}`; };
const fmtDEn = s => { if (!s) return ''; const d = pd(s); return `${d.getDate()} ${EN_M[d.getMonth()]} ${d.getFullYear()}`; };
const fmtDShort = s => fmtD(s);   // dates are always วัน เดือน ปี — 25 ต.ค. 2026
const fmtMonth = m => `${TH_MF[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const fmtMonthEn = m => `${EN_M[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const fmtTime = s => s ? s.slice(11, 16) : '';
const dayDiff = (a, b) => Math.round((pd(a) - pd(b)) / 864e5);
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const fmtN = v => (v === null || v === undefined || v === '') ? '' : nf.format(v);
const qtyH = (v, u, cls = '') => `<span class="qty num ${cls}">${fmtN(v)}<span class="u">${esc(u || '')}</span></span>`;
function relDay(s, today) {
  const n = dayDiff(s, today);
  if (n === 0) return ['วันนี้', 'TODAY'];
  if (n === 1) return ['พรุ่งนี้', 'TOMORROW'];
  if (n === -1) return ['เมื่อวาน', 'YESTERDAY'];
  return n > 0 ? [`อีก ${n} วัน`, `IN ${n} DAYS`] : [`เลยมา ${-n} วัน`, `${-n} DAYS LATE`];
}
function parseNum(s) {
  if (s === null || s === undefined) return null;
  s = String(s).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* ---------------- icons (one family: 24 grid, 1.9 stroke, round) ---------------- */
const IC = {
  coins: '<ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5M5 11.5v5.5c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-5.5"/>',
  logo: '<path d="M6 6.5C6 5.1 8.7 4 12 4s6 1.1 6 2.5v11c0 1.4-2.7 2.5-6 2.5s-6-1.1-6-2.5z"/><path d="M6 6.5C6 7.9 8.7 9 12 9s6-1.1 6-2.5M6 12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
  entry: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3.5h6v1M8.5 10h7M8.5 13.5h7M8.5 17h4"/>',
  stock: '<path d="m12 3.5 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16.5l8 4 8-4"/>',
  order: '<path d="M3.5 4.5h2.2l2.1 10.2a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.1L20 8H6.4"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
  truck: '<path d="M3 6.5h11v9.5H3zM14 9.5h3.8l3.2 3.4V16h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>',
  doc: '<path d="M6.5 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z"/><path d="M13.5 3.5V8H18M9 12.5h6M9 16h6"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15.5v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  pdf: '<path d="M6.5 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z"/><path d="M13.5 3.5V8H18"/><path d="M8.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M12.5 13v4h.8a1.6 1.6 0 0 0 1.6-1.6v-.8a1.6 1.6 0 0 0-1.6-1.6z"/>',
  xls: '<path d="M6.5 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5z"/><path d="M13.5 3.5V8H18"/><path d="m9 12 4.5 5.5M13.5 12 9 17.5"/>',
  a3: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18M8 9.5V19M13 9.5V19"/>',
  master: '<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z"/><path d="m4 7.5 8 3.5 8-3.5M12 11v9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4z"/>',
  chevL: '<path d="m14.5 6-6 6 6 6"/>', chevR: '<path d="m9.5 6 6 6-6 6"/>', chevD: '<path d="m6 9.5 6 6 6-6"/>', chevU: '<path d="m6 14.5 6-6 6 6"/>',
  side: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15M15.5 10l-2 2 2 2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  upload: '<path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.5 20c.8-3.8 3.8-5.7 7.5-5.7s6.7 1.9 7.5 5.7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4.3-3 7.3-7 8.5-4-1.2-7-4.2-7-8.5V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
  folder: '<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v9.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  arrowR: '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="m13 7 4 4"/>',
  box: '<path d="m12 3.5 8 4v9l-8 4-8-4v-9z"/><path d="m4 7.5 8 4 8-4M12 11.5v9"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z"/><path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  db: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  undo: '<path d="M9 14.5 4.5 10 9 5.5"/><path d="M4.5 10H14a5.5 5.5 0 0 1 0 11h-3"/>',
  sheet: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M3.5 14h17M9.5 4v16M15 4v16"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="17.5" r="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  up: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>', down: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
  wifi: '<path d="M3 9a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r=".8"/>',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[n] || ''}</svg>`;
const tile = (n, c, cls = '') => `<span class="tile ${cls}" style="--c:${c}">${ic(n)}</span>`;
const TH_RE = /[\u0E00-\u0E7F]/;
const bi = (th, en, cls = '') => `<span class="bi ${cls}"><span class="th">${esc(th)}</span>${en && en !== th ? `<span class="en${TH_RE.test(en) ? ' en-th' : ''}">${esc(en)}</span>` : ''}</span>`;
/* Thai must never get letter-spacing / uppercase tracking (marks drift, words look torn).
   Safety net for any element styled for English that ends up holding Thai text. */
const ThaiType = {
  fix(root) {
    if (root.nodeType === 1) {   // progress trackers grow in once they are on screen
      const trk = [...(root.matches('.trk') ? [root] : []), ...root.querySelectorAll('.trk:not(.go)')];
      if (trk.length) setTimeout(() => trk.forEach(t => t.classList.add('go')), 220);
    }
    const els = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : [];
    for (const el of els) {
      if (el.dataset.thx || !el.firstChild) continue;
      let own = ''; for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      if (!TH_RE.test(own)) continue;
      el.dataset.thx = '1';
      const ls = getComputedStyle(el).letterSpacing;
      if (ls !== 'normal' && parseFloat(ls) !== 0) el.style.letterSpacing = '0';
    }
  },
  start() {
    let q = new Set(), t = 0;
    new MutationObserver(ms => {
      ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) q.add(n); else if (n.parentElement) q.add(n.parentElement); }));
      clearTimeout(t); t = setTimeout(() => { const list = [...q]; q = new Set(); list.forEach(n => n.isConnected && ThaiType.fix(n)); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
  },
};

/* ---------------- semantic status ---------------- */
const C = { need: 'var(--st-need)', ordered: 'var(--st-ordered)', sched: 'var(--st-sched)', ok: 'var(--st-ok)', neutral: 'var(--stop)' };
const ORDER_ST = {
  requested: { cls: 'ordered', th: 'ขอสั่งแล้ว — รอ Officer สั่งซื้อ', en: 'REQUESTED — WAITING FOR OFFICER' },
  rejected: { cls: 'neutral', th: 'ไม่อนุมัติ', en: 'REJECTED' },
  overdue: { cls: 'need', th: 'เกินกำหนดส่ง', en: 'OVERDUE' },
  waiting_date: { cls: 'ordered', th: 'สั่งแล้ว — รอกำหนดส่ง', en: 'ORDERED — WAITING FOR DELIVERY DATE' },
  today: { cls: 'sched', th: 'ส่งวันนี้', en: 'DELIVERY TODAY' },
  scheduled: { cls: 'sched', th: 'กำหนดส่ง', en: 'DELIVERY' },
  received: { cls: 'ok', th: 'รับเข้าแล้ว', en: 'RECEIVED' },
  cancelled: { cls: 'neutral', th: 'ยกเลิก', en: 'CANCELLED' },
};
const REASON = {
  normal: ['สั่งปกติ', 'Normal Order'], moq: ['MOQ', 'Minimum Order'], pack: ['ขนาดบรรจุ Supplier', 'Supplier Pack Size'],
  partial: ['สั่งบางส่วน', 'Partial Order'], stock: ['มีสต็อกเหลือ', 'Existing Stock'], budget: ['ควบคุมงบ / ต้นทุน', 'Budget / Cost Control'], other: ['อื่น ๆ', 'Other'],
};
function orderBadge(o) {
  const s = ORDER_ST[o.status] || ORDER_ST.waiting_date;
  let th = s.th, en = s.en;
  if (o.status === 'scheduled' || o.status === 'overdue') { th = `${o.status === 'overdue' ? 'เกินกำหนดส่ง' : 'กำหนดส่ง'} ${fmtD(o.expected_date)}`; en = `${o.status === 'overdue' ? 'OVERDUE' : 'DELIVERY'} ${fmtDEn(o.expected_date)}`; }
  if (o.status === 'received' && o.done_date) { th = `รับเข้าแล้ว ${fmtDShort(o.done_date)}`; }
  return `<span class="badge ${s.cls}"><span class="dot"></span>${bi(th, en)}</span>`;
}
function orderCls(o) { return (ORDER_ST[o.status] || {}).cls || 'neutral'; }
function partialLine(o) {
  if (!o.partial) return '';
  const pct = Math.min(100, 100 * o.received_qty / o.ordered_qty);
  return `<div style="width:100%;--c:var(--st-ordered)"><div class="when num"><b style="color:var(--st-ordered)">รับแล้ว ${fmtN(o.received_qty)} / ${fmtN(o.ordered_qty)}</b> · <span class="faint">PARTIAL DELIVERY</span></div><div class="prog" style="margin-top:4px"><i style="width:${pct}%"></i></div></div>`;
}
function matBadge(s) {
  if (s.state === 'need_order') return `<span class="badge need"><span class="dot"></span>${bi('ต้องสั่ง', 'NEED ORDER')}</span>`;
  if (s.state === 'on_order') {
    const st = ORDER_ST[s.order_status] || ORDER_ST.waiting_date;
    const th = { requested: 'ขอสั่งแล้ว — รอ Officer', waiting_date: 'สั่งแล้ว — รอกำหนดส่ง', scheduled: 'สั่งแล้ว — มีกำหนดส่ง', today: 'ส่งวันนี้', overdue: 'เกินกำหนดส่ง' }[s.order_status] || 'สั่งแล้ว';
    const en = { requested: 'REQUESTED', waiting_date: 'ORDERED', scheduled: 'DELIVERY SCHEDULED', today: 'DELIVERY TODAY', overdue: 'OVERDUE' }[s.order_status] || 'ORDERED';
    return `<span class="badge ${st.cls}"><span class="dot"></span>${bi(th, en)}</span>`;
  }
  // NORMAL: double-click → order anyway (asks why)
  return `<span class="badge ok ${s.id ? 'normord' : ''}" ${s.id ? `data-normord="${s.id}" title="ดับเบิลคลิกเพื่อสั่งซื้อ (สถานะยังปกติ)"` : ''}><span class="dot"></span>${bi('ปกติ', 'NORMAL')}</span>`;
}
const ART_LIST = ['ibc-white', 'filter-white', 'drum-blue', 'drum-teal', 'drum-green', 'drum-red', 'drum-maroon', 'drum-orange', 'drum-yellow', 'drum-grey', 'drum-navy',
  'pdrum-blue', 'pdrum-white', 'pdrum-navy', 'pail-blue', 'pail-red', 'pail-yellow', 'pail-green', 'pail-white', 'pail-grey', 'pail-orange',
  'pad-maroon', 'pad-green', 'pad-grey', 'padw-maroon', 'padw-green', 'padw-grey', 'box-red', 'box-yellow', 'box-blue'];
function artSrc(m) { return `img/items/${(m && m.art) || 'box-red'}.svg`; }
const MAT_PICS = false;   // stock materials show text only (original look); pictures are used in HRM Shopping only
function mpic(m, size = 40, cls = '') { if (!MAT_PICS) return ''; return `<img class="mpic ${cls}" src="${artSrc(m)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`; }
function matName(m, extra = '', pic = 40) {
  const en = m.name_en && m.name_en.trim() && m.name_en.trim().toUpperCase() !== m.name.trim().toUpperCase() ? m.name_en : '';
  return `<div class="mname-w">${pic ? mpic(m, pic) : ''}<div class="mname bi"><span class="th" title="${esc(m.name)}">${esc(m.name)}</span>${en ? `<span class="en">${esc(en)}</span>` : `<span class="code">${esc(m.code || '')}${extra}</span>`}</div></div>`;
}
function sparkSvg(vals, rp, color) {
  if (!vals?.length) return '';
  const w = 120, h = 34, max = Math.max(...vals, rp || 0) * 1.08 || 1, min = 0;
  const x = i => (i / (vals.length - 1)) * (w - 4) + 2, y = v => h - 3 - ((v - min) / (max - min)) * (h - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const l = 'M' + pts.join('L');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" style="--c:${color}"><path class="a" d="${l}L${x(vals.length - 1)},${h}L${x(0)},${h}Z"/>${rp ? `<line x1="0" x2="${w}" y1="${y(rp)}" y2="${y(rp)}"/>` : ''}<path class="l" d="${l}"/></svg>`;
}
function levelBar(bal, rp, cls) {
  const scale = Math.max(rp * 2.2, bal * 1.05, 1);
  return `<div class="levelbar" style="--c:${C[cls]}"><i style="width:${Math.min(100, 100 * Math.max(0, bal) / scale)}%"></i>${rp ? `<b style="left:${100 * rp / scale}%" title="จุดสั่งซื้อ"></b>` : ''}</div>`;
}
const emptyState = (icon, th, en, hint = '', action = '', hatch = false) =>
  `<div class="empty ${hatch ? 'hatch' : ''}">${(typeof sticker === 'function' && sticker(icon, 78, 'hero')) || tile(icon, 'var(--fg-3)')}${bi(th, en)}${hint ? `<div class="hint">${hint}</div>` : ''}${action}</div>`;

/* ---------------- toast / panel / modal ---------------- */
function toast(title, detail = '', kind = 'ok') {
  const c = { ok: 'var(--run)', err: 'var(--leak)', info: 'var(--primary)', warn: 'var(--abn)', note: 'var(--abn)' }[kind];
  const icon = { ok: 'check', err: 'alert', info: 'refresh', warn: 'alert', note: 'alert' }[kind];
  const el = document.createElement('div');
  el.className = 'toast';
  const stk = typeof sticker === 'function' ? sticker({ ok: 'check', err: 'alert', info: 'info', warn: 'alert', note: 'megaphone' }[kind] || 'info', 40) : '';
  el.innerHTML = `${stk || `<span class="tile" style="--c:${c}">${ic(icon)}</span>`}<div><b>${esc(title)}</b>${detail ? `<span>${detail}</span>` : ''}</div>`;
  const box = $('#toasts'); box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();   // never a wall of toasts over the page
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, kind === 'err' ? 6000 : 3800);
}
const toastErr = e => toast('ทำรายการไม่สำเร็จ', esc(e.message || e), 'err');

function openPanel({ title, en, icon = 'edit', color = 'var(--primary)', body = '', foot = '', wide = false, onMount }) {
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const p = document.createElement('div'); p.className = 'panel' + (wide ? ' wide' : '');
  p.innerHTML = `<div class="panel-h">${tile(icon, color)}<div class="title">${bi(title, en)}</div><span style="flex:1"></span><button class="icon-btn" data-x aria-label="ปิด">${ic('x')}</button></div>
    <div class="panel-b">${body}</div>${foot ? `<div class="panel-f">${foot}</div>` : ''}`;
  document.body.append(scrim, p);
  const close = () => { scrim.remove(); p.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !$('.modal')) close(); };
  document.addEventListener('keydown', onKey);
  scrim.onclick = close; p.querySelector('[data-x]').onclick = close;
  onMount && onMount(p, close);
  return close;
}
/** pop-up with several choices → resolves to the chosen key (or null). choices: [{k, label, en, cls}] */
function choice({ title, en, icon = 'alert', color = 'var(--abn)', body = '', choices = [] }) {
  return new Promise(resolve => {
    const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.style.zIndex = 61.5;
    const m = document.createElement('div'); m.className = 'modal choice-modal';
    m.innerHTML = `<div class="title">${tile(icon, color, 'sm')}${bi(title, en)}</div><div>${body}</div>
      <div class="choice-list">${choices.map((c, i) => `<button class="btn ${c.cls || 'btn-plain'} lg" data-k="${i}">${c.icon ? ic(c.icon, 'sm') : ''}${bi(c.label, c.en || '')}</button>`).join('')}</div>`;
    document.body.append(scrim, m);
    const close = v => { scrim.remove(); m.remove(); document.removeEventListener('keydown', k); resolve(v); };
    const k = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', k);
    scrim.onclick = () => close(null);
    m.querySelector('.choice-list').onclick = e => { const b = e.target.closest('[data-k]'); if (b) close(choices[+b.dataset.k].k); };
    setTimeout(() => m.querySelector('[data-k]')?.focus(), 50);
  });
}
function modal({ title, en, icon = 'alert', color = 'var(--abn)', body = '', ok = 'ตกลง', okEn = 'OK', cancel = 'ยกเลิก', danger = false, onOk }) {
  return new Promise(resolve => {
    const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.style.zIndex = 61.5;
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="title">${tile(icon, color, 'sm')}${bi(title, en)}</div><div>${body}</div>
      <div class="acts">${cancel ? `<button class="btn btn-plain" data-c>${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${bi(ok, okEn)}</button></div>`;
    document.body.append(scrim, m);
    const close = v => { scrim.remove(); m.remove(); document.removeEventListener('keydown', k); resolve(v); };
    const k = e => { if (e.key === 'Escape') close(false); if (e.key === 'Enter' && !e.target.matches('textarea')) { e.preventDefault(); m.querySelector('[data-ok]').click(); } };
    document.addEventListener('keydown', k);
    scrim.onclick = () => close(false);
    m.querySelector('[data-c]')?.addEventListener('click', () => close(false));
    m.querySelector('[data-ok]').onclick = async () => {
      if (onOk) { try { const r = await onOk(m); if (r === false) return; close(r ?? true); } catch (e) { const er = m.querySelector('.err-text'); if (er) er.textContent = e.message; else toastErr(e); } }
      else close(true);
    };
    setTimeout(() => (m.querySelector('input') || m.querySelector('[data-ok]')).focus(), 50);
  });
}

/* ---------------- app shell ---------------- */
const NAV = [
  { id: 'home', icon: 'home', th: 'หน้าหลัก', en: 'Home' },
  { id: 'entry', icon: 'entry', th: 'กรอก STOCK', en: 'Stock Entry' },
  { id: 'stock', icon: 'stock', th: 'สต็อกคงเหลือ', en: 'Current Stock' },
  { id: 'orders', icon: 'order', th: 'สั่งซื้อ', en: 'Orders' },
  { id: 'delivery', icon: 'truck', th: 'รับสินค้า', en: 'Delivery' },
  { id: 'docs', icon: 'a3', th: 'เอกสาร A3', en: 'Documents' },
  { sep: true },
  { id: 'master', icon: 'master', th: 'จัดการ Material', en: 'Material Master' },
  { id: 'adjust', icon: 'pencil', th: 'ประวัติแก้ยอด', en: 'Stock corrections' },
  { sep: true, label: ['ขอสั่งซื้ออุปกรณ์', 'HRM SHOPPING'] },
  { id: 'shop', icon: 'shopbag', th: 'รายการสินค้า', en: 'Supplies' },
  { id: 'shophist', icon: 'history', th: 'ประวัติคำขอ', en: 'Requests' },
];
const PAGES = {};

const App = {
  info: null, page: 'home', params: {}, rev: null, online: true, badges: {},
  get today() { return this.info?.today || iso(new Date()); },
  get officer() { return this.info?.role === 'officer'; },
  /** startup failed (no internet / server down) — explain, retry by hand or as soon as the connection is back */
  offline(msg) {
    const off = navigator.onLine === false;
    $('#root').innerHTML = `<div class="setup"><div class="card off-card">
      <span class="mark">${art('logo', 44)}</span>
      <div class="off-t">${bi(off ? 'ไม่มีอินเทอร์เน็ต' : 'เชื่อมต่อระบบไม่ได้', off ? 'OFFLINE' : 'CANNOT REACH SERVER')}</div>
      <p class="muted">${off ? 'เครื่องนี้ยังไม่ได้ต่ออินเทอร์เน็ต' : esc(msg || 'เซิร์ฟเวอร์ไม่ตอบกลับ')}</p>
      <p class="hint">ข้อมูล STOCK อยู่บน Google Sheet ต้องออนไลน์จึงจะดูหรือบันทึกได้ · ระบบจะเปิดให้เองเมื่ออินเทอร์เน็ตกลับมา</p>
      <button class="btn btn-primary" id="off-retry">${ic('refresh', 'sm')}ลองใหม่</button></div></div>`;
    $('#off-retry').onclick = () => location.reload();
    window.addEventListener('online', () => location.reload(), { once: true });
  },
  async start() {
    if (IS_WEB && await TeamGate.join()) return;
    try { this.info = await api('app_info'); } catch (e) { if (e.needLogin) return; this.info = { ready: false, error: e.message }; }
    if (!this.info.ready && IS_GAS) return this.offline(this.info.error);   // Google / web: nothing to set up — the server is just unreachable
    if (!this.info.ready) return Setup.show(1);
    if (typeof Widget !== 'undefined' && Widget.want() && this.info.has_data) return Widget.start();   // desktop widget window
    if (typeof Mobile !== 'undefined' && this.info.has_data && Mobile.want()) return Mobile.start();
    if (this.info.need_machine) return Setup.show(3);
    if (!this.info.has_data && localStorageGet('skipImport') !== '1') return Setup.show(2);
    this.rev = this.info.rev;
    this.renderShell();
    const h = location.hash.slice(1);
    this.go(PAGES[h] ? h : 'home');
    window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (PAGES[h] && h !== this.page) this.go(h); });
    setInterval(() => this.poll(), 15000);
    setInterval(() => this.tick(), 20000);
  },
  renderShell() {
    const collapsed = localStorageGet('sideCollapsed') === '1';
    $('#root').innerHTML = `<div class="app">
      <aside class="sidebar glass ${collapsed ? 'collapsed' : ''}" id="side">
        <div class="brand"><span class="mark">${art('logo', 34)}</span><div class="txt"><div class="t1">HRM STOCK</div><div class="t2">ระบบควบคุมและจัดการสต็อก</div></div></div>
        <nav class="nav" id="nav">${NAV.map(n => n.sep ? (n.label ? `<div class="nav-grp"><span>${esc(n.label[0])}</span><small>${esc(n.label[1])}</small></div>` : '<div class="nav-sep"></div>') : `<a data-go="${n.id}" data-tip="${esc(n.th)}|${esc(n.en)}">${art(n.icon)}${bi(n.th, n.en)}<span class="cnt hidden"></span></a>`).join('')}</nav>
        <div class="side-foot">
          <nav class="nav"><a data-go="settings" data-tip="ตั้งค่า|Settings">${art('settings')}${bi('ตั้งค่า', 'Settings')}</a></nav>
          <button class="collapse-btn" id="collapse" title="ย่อ/ขยายเมนู">${ic('side', 'sm')}</button>
        </div>
      </aside>
      <div class="main">
        <header class="header glass" id="header"></header>
        <main class="content" id="content"></main>
      </div></div>`;
    $('#nav').parentElement.addEventListener('click', e => { const a = e.target.closest('[data-go]'); if (a) this.go(a.dataset.go); });
    $('#side .side-foot').addEventListener('click', e => { const a = e.target.closest('[data-go]'); if (a) this.go(a.dataset.go); });
    $('#collapse').onclick = () => { const s = $('#side'); s.classList.toggle('collapsed'); localStorageSet('sideCollapsed', s.classList.contains('collapsed') ? '1' : '0'); };
    // collapsed tooltips
    let tipEl = null;
    $('#side').addEventListener('mouseover', e => {
      const a = e.target.closest('[data-tip]'); if (!a || !$('#side').classList.contains('collapsed') && innerWidth > 1280) return;
      tipEl?.remove(); const [th, en] = a.dataset.tip.split('|'); const r = a.getBoundingClientRect();
      tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.innerHTML = `${esc(th)}<span class="en">${esc(en)}</span>`;
      tipEl.style.left = r.right + 12 + 'px'; tipEl.style.top = r.top + 8 + 'px'; document.body.appendChild(tipEl);
    });
    $('#side').addEventListener('mouseout', () => { tipEl?.remove(); tipEl = null; });
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); PAGES[this.page]?.save?.(); } });
  },
  renderHeader() {
    const p = PAGES[this.page];
    const now = new Date();
    $('#header').innerHTML = `
      <div class="ptitle">${bi(p.title[0], p.title[1])}</div>
      <span class="spacer"></span>
      <span id="hpage"></span>
      <span class="hpill ${this.online ? '' : 'err'}" id="sync" title="${esc(this.info.data_dir)}"><span class="dot"></span>${this.online ? bi('เชื่อมต่อ' + SRC_LABEL, 'ONLINE', 'row') : bi('ขาดการเชื่อมต่อ', 'OFFLINE', 'row')}</span>
      <button class="hpill ${this.officer ? 'role-off' : ''}" id="rolepill" title="เปลี่ยนโหมดที่หน้า ตั้งค่า">${this.officer && typeof People !== 'undefined' ? People.avatar(this.info.officer_name || 'Officer', 24) : ic(this.officer ? 'shield' : 'user', 'sm')}${this.officer ? bi('Officer' + (this.info.officer_name ? ' · ' + this.info.officer_name : ''), '') : bi('Operator', '')}</button>
      <div class="clock"><div class="d">${TH_WD[now.getDay()]} ${fmtD(this.today)}</div><div class="t num" id="clk">${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${this.info.machine || ''}</div></div>
      ${typeof Notif !== 'undefined' ? Notif.bellHtml() : ''}
      ${typeof Widget !== 'undefined' ? `<button class="icon-btn" id="hwidget" title="เปิด Widget บนเดสก์ท็อป — งานที่ต้องสั่ง + ประกาศ">${ic('side')}</button>` : ''}
      <button class="icon-btn" id="hrefresh" title="รีเฟรชข้อมูล">${ic('refresh')}</button>`;
    $('#hbell')?.addEventListener('click', () => Notif.panel());
    if (this._bell !== undefined && typeof Notif !== 'undefined') Notif.setBell(this._bell);
    $('#hrefresh').onclick = () => this.refresh(true);
    $('#hwidget')?.addEventListener('click', () => Widget.launch());
    $('#rolepill').onclick = () => this.go('settings');
    PAGES[this.page].header?.($('#hpage'));
  },
  tick() {
    const now = new Date(), c = $('#clk');
    if (c) c.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · ${this.info.machine || ''}`;
    if (iso(now) !== this.info.today && !this._todayOverride) { this.info.today = iso(now); }
  },
  async go(id, params = {}, force = false) {
    if (!force && PAGES[this.page]?.dirty?.() && (id !== this.page || JSON.stringify(params) !== JSON.stringify(this.params))) {
      const ok = await modal({ title: 'มีข้อมูลที่ยังไม่บันทึก', en: 'Unsaved changes', body: '<p class="muted">ถ้าออกจากหน้านี้ ตัวเลขที่กรอกไว้แต่ยังไม่กดบันทึกจะหายไป</p>', ok: 'ออกโดยไม่บันทึก', okEn: 'Discard', danger: true });
      if (!ok) return;
    }
    this.page = id; this.params = params;
    location.hash = id;
    $$('#side [data-go]').forEach(a => a.classList.toggle('on', a.dataset.go === id));
    this.renderHeader();
    const el = $('#content');
    el.innerHTML = `<div class="loading"><span class="spin"></span>กำลังโหลด…</div>`;
    el.scrollTop = 0;
    try { await PAGES[id].render(el, params); }
    catch (e) { console.error(e); el.innerHTML = `<div class="card">${emptyState('alert', 'โหลดข้อมูลไม่สำเร็จ', 'COULD NOT LOAD', esc(e.message), `<button class="btn btn-tonal" onclick="App.refresh(true)">${ic('refresh', 'sm')}ลองอีกครั้ง</button>`)}</div>`; }
    this.updateBadges();
  },
  async refresh(manual = false, fromPoll = false) {
    const el = $('#content'), st = el.scrollTop;
    try {
      this.info = await api('app_info'); this.rev = this.info.rev; this.setOnline(true);
      await PAGES[this.page].render(el, this.params, true);
      el.scrollTop = st; this.renderHeader(); this.updateBadges();
      if (manual) toast('อัปเดตข้อมูลแล้ว', 'ข้อมูลล่าสุดจาก' + SRC_LABEL, 'info');
      if (fromPoll) toast('มีข้อมูลใหม่จากอีกเครื่อง', 'หน้าจออัปเดตให้อัตโนมัติ', 'info');
    } catch (e) { toastErr(e); }
  },
  async poll() {
    try {
      const rev = await api('get_rev');
      this.setOnline(true);
      if (this.rev !== null && rev !== this.rev) {
        if (PAGES[this.page]?.dirty?.()) { this.rev = rev; toast('มีข้อมูลใหม่จากอีกเครื่อง', 'บันทึกหน้านี้แล้วข้อมูลจะอัปเดต', 'warn'); return; }
        this.rev = rev; await this.refresh(false, true);
      }
    } catch (e) { this.setOnline(false); }
  },
  setOnline(v) { if (this.online !== v) { this.online = v; if ($('#header')) this.renderHeader(); } },
  /** one shared dashboard per data revision — badges, home and notifications reuse it instead of asking the server again */
  _dash: null,
  dash(force = false) {
    const c = this._dash, fresh = c && c.rev === this.rev && Date.now() - c.at < 20000;
    if (!force && fresh) return c.p;
    const p = api('dashboard'); this._dash = { rev: this.rev, at: Date.now(), p };
    p.catch(() => { if (this._dash && this._dash.p === p) this._dash = null; });
    return p;
  },
  bumpRev: async function () { try { this.rev = await api('get_rev'); } catch (e) { } this.updateBadges(); },
  async updateBadges() {
    try {
      const d = await App.dash();
      const set = (id, n, cls = '') => { const a = $(`#side [data-go="${id}"] .cnt`); if (!a) return; a.textContent = n; a.className = 'cnt ' + cls + (n ? '' : ' hidden'); };
      const miss = Shift.workDays(d.missing_days).length + (d.today_recorded || !Shift.works(d.today || App.today) ? 0 : 1);
      set('entry', miss);
      set('stock', d.summary.need_order);
      set('orders', d.summary.ordered + d.summary.overdue, 'abn');
      set('delivery', this.officer ? d.pending.receipts : d.deliveries_today.length, 'abn');
      set('master', this.officer ? d.pending.materials : 0, 'abn');
      set('adjust', this.officer ? (d.adjusts || []).length : 0, 'abn');
      set('docs', this.officer ? d.pending.docs : 0, 'abn');
      App.updateShopBadge && App.updateShopBadge();
      if (typeof Notif !== 'undefined') { Notif.update(d); this._bell = App.officer ? Notif.count(d) : 0; }
      set('home', (d.notes || []).filter(n => n.id > +(localStorageGet('noteAck') || 0)).length, 'abn');
      // pop a toast once per new announcement on this computer
      const seen = +(localStorageGet('noteToast') || 0);
      const fresh = (d.notes || []).filter(n => n.id > seen && !(typeof NoteUI !== 'undefined' && NoteUI.st(n).mode === 'popup')).sort((a, b) => a.id - b.id);
      if (typeof NoteUI !== 'undefined') setTimeout(() => NoteUI.popups(d.notes || []), 600);
      if (fresh.length) {
        const n = fresh[fresh.length - 1];
        localStorageSet('noteToast', String(Math.max(...(d.notes || []).map(x => x.id))));
        toast(fresh.length > 1 ? `ประกาศใหม่ ${fresh.length} รายการ` : (n.title || 'ประกาศใหม่จาก Officer'), esc(n.body.length > 90 ? n.body.slice(0, 90) + '…' : n.body), 'note');
        localStorageSet('noteToast', String(n.id));
      }
    } catch (e) { }
  },
};
function localStorageGet(k) { try { return localStorage.getItem('hrm.' + k); } catch (e) { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('hrm.' + k, v); } catch (e) { } }

/* ---------------- first-run setup ---------------- */
const Setup = {
  async show(step = 1) {
    const info = App.info || {};
    $('#root').innerHTML = `<div class="setup"><div class="card" id="setup"></div></div>`;
    this.step(step, info);
  },
  step(n, info) {
    const el = $('#setup');
    const head = `<div style="display:flex;align-items:center;gap:16px"><span class="brand"><span class="mark" style="width:54px;height:54px;border-radius:16px">${art('logo', 44)}</span></span>
      <div><div style="font-size:24px;font-weight:700;line-height:1.2">HRM STOCK CONTROL MANAGEMENT</div><div class="muted">ระบบควบคุมและจัดการสต็อก HRM — ตั้งค่าเครื่องนี้</div></div></div>
      <div class="steps"><span class="st ${n >= 1 ? 'on' : ''}"></span><span class="st ${n >= 2 ? 'on' : ''}"></span><span class="st ${n >= 3 ? 'on' : ''}"></span></div>`;
    if (n === 1) {
      el.innerHTML = head + `<div style="font-size:19px;font-weight:700">${bi('1. เลือกโฟลเดอร์ข้อมูลบนไดร์ฟกลาง', 'SHARED DATA FOLDER')}</div>
        <p class="muted" style="margin:8px 0 16px">ทุกเครื่อง (หน้างาน + ออฟฟิศ) ต้องชี้มาที่โฟลเดอร์เดียวกัน เช่น <span class="pathbox" style="display:inline;padding:2px 8px">\\\\server\\share\\HRMStock</span></p>
        ${info.error ? `<div class="warn-banner" style="margin-bottom:14px">${ic('alert')}${esc(info.error)}</div>` : ''}
        <div style="display:flex;gap:10px"><input class="input" id="dpath" placeholder="\\\\server\\share\\HRMStock" value="${esc(info.data_dir || '')}"><button class="btn btn-plain" id="browse">${ic('folder', 'sm')}เลือก…</button></div>
        <div class="err-text" id="derr" style="margin-top:8px"></div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:22px"><button class="btn btn-primary lg" id="dnext">${bi('เชื่อมต่อ', 'CONNECT')}${ic('arrowR')}</button></div>`;
      $('#browse').onclick = async () => { try { const p = await api('pick_folder'); if (p) $('#dpath').value = p; } catch (e) { } };
      $('#dnext').onclick = async () => {
        const p = $('#dpath').value.trim(); $('#derr').textContent = '';
        try {
          let r = await api('setup_data_dir', p, false);
          if (!r.exists) {
            const ok = await modal({ title: 'ยังไม่มีฐานข้อมูลในโฟลเดอร์นี้', en: 'Create new database?', icon: 'db', color: 'var(--primary)', body: `<p class="muted">สร้างฐานข้อมูลใหม่ที่<br><span class="pathbox" style="display:block;margin-top:6px">${esc(p)}</span><br>ทำครั้งเดียวที่เครื่องแรก เครื่องที่สองให้เลือกโฟลเดอร์เดิมนี้</p>`, ok: 'สร้างฐานข้อมูล', okEn: 'Create' });
            if (!ok) return;
            r = await api('setup_data_dir', p, true);
          }
          App.info = r.info;
          if (!App.info.has_data) this.step(2, App.info); else this.step(3, App.info);
        } catch (e) { $('#derr').textContent = e.message; }
      };
    } else if (n === 2) {
      el.innerHTML = head + `<div style="font-size:19px;font-weight:700">${bi('2. นำเข้าข้อมูลเดิมจาก Excel', 'IMPORT STOCK RM EXCEL')}</div>
        <p class="muted" style="margin:8px 0 16px">เลือกไฟล์ <b>Stock RM 2026.xlsx</b> ระบบจะสร้าง Material Master 21 รายการ และนำเข้าข้อมูลรับ/ใช้ไป/ยอดยกมา/OPS ทุกเดือน (SRR-104 ทั้ง 2 ถังรวมเป็นรายการเดียว)</p>
        <div style="display:flex;gap:10px"><input class="input" id="xpath" placeholder="C:\\...\\Stock RM 2026.xlsx"><button class="btn btn-plain" id="xbrowse">${ic('folder', 'sm')}เลือกไฟล์…</button></div>
        <div class="err-text" id="xerr" style="margin-top:8px"></div><div id="xres"></div>
        <div style="display:flex;justify-content:space-between;gap:10px;margin-top:22px"><button class="btn btn-ghost" id="xskip">ข้าม — เริ่มจาก Master ว่าง</button><button class="btn btn-primary lg" id="ximp">${ic('upload')}${bi('นำเข้า', 'IMPORT')}</button></div>`;
      $('#xbrowse').onclick = async () => { try { const p = await api('pick_excel'); if (p) $('#xpath').value = p; } catch (e) { } };
      $('#xskip').onclick = () => { localStorageSet('skipImport', '1'); this.step(3, App.info); };
      $('#ximp').onclick = async () => {
        $('#xerr').textContent = ''; $('#ximp').disabled = true; $('#xres').innerHTML = `<div class="loading" style="padding:20px"><span class="spin"></span>กำลังนำเข้า…</div>`;
        try {
          const r = await api('import_excel', $('#xpath').value.trim());
          $('#xres').innerHTML = `<div class="locked-banner" style="margin-top:12px">${ic('check')}นำเข้า ${r.months} เดือน (${esc(r.range)}) · Material ${r.materials} รายการ · ${r.ledger_rows} บันทึก</div>`;
          setTimeout(() => this.step(3, App.info), 1400);
        } catch (e) { $('#xerr').textContent = e.message; $('#xres').innerHTML = ''; $('#ximp').disabled = false; }
      };
    } else {
      el.innerHTML = head + `<div style="font-size:19px;font-weight:700">${bi('3. เครื่องนี้ใช้งานโดย', 'THIS COMPUTER IS FOR')}</div>
        <p class="muted" style="margin:8px 0 16px">เปลี่ยนภายหลังได้ที่หน้า ตั้งค่า · รหัส Officer เริ่มต้นคือ <b>1234</b> (ควรเปลี่ยนทันที)</p>
        ${info.gas ? `<div class="field" style="margin-bottom:16px"><label>ชื่อเครื่องนี้ <span class="en">Computer name · แสดงในประวัติการใช้งาน</span></label><input class="input" id="mname" placeholder="เช่น หน้างาน-1, หน้างาน-2, OFFICE" value="${esc(info.machine || '')}"></div>` : ''}
        <div class="frow"><button class="choice" style="height:96px;justify-content:flex-start;padding:0 18px" aria-pressed="true" data-role="operator">${tile('user', 'var(--primary)')}${bi('Operator · หน้างาน', 'Daily stock entry')}</button>
        <button class="choice" style="height:96px;justify-content:flex-start;padding:0 18px" aria-pressed="false" data-role="officer">${tile('shield', 'var(--maint)')}${bi('Officer · ออฟฟิศ', 'Orders · verify · master')}</button></div>
        <div id="offx" class="hidden frow" style="margin-top:14px"><div class="field"><label>ชื่อ Officer <span class="en">Name</span></label><input class="input" id="oname"></div><div class="field"><label>รหัส Officer <span class="en">PIN</span></label><input class="input" id="opin" type="password" inputmode="numeric"></div></div>
        <div class="err-text" id="rerr" style="margin-top:8px"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:22px"><button class="btn btn-primary lg" id="rgo">${bi('เริ่มใช้งาน', 'START')}${ic('arrowR')}</button></div>`;
      let role = 'operator';
      $$('[data-role]').forEach(b => b.onclick = () => { role = b.dataset.role; $$('[data-role]').forEach(x => x.setAttribute('aria-pressed', x === b)); $('#offx').classList.toggle('hidden', role !== 'officer'); });
      $('#rgo').onclick = async () => {
        try {
          if ($('#mname')) await api('set_machine', $('#mname').value);
          App.info = await api('set_role', role, $('#opin')?.value, role === 'officer' ? $('#oname').value : null); location.hash = ''; App.start();
        }
        catch (e) { $('#rerr').textContent = e.message; }
      };
    }
  },
};

/* F5 = refresh the data in place (fast, keeps the page / scroll / open forms) — Ctrl+F5 still reloads the whole app */
window.addEventListener('keydown', e => {
  if (e.key !== 'F5' || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  if (typeof Mobile !== 'undefined' && document.body.classList.contains('is-mobile')) { Mobile.load(); return; }
  if (!$('#content') || !App.info) { location.reload(); return; }
  if (PAGES[App.page]?.dirty?.()) { toast('มีตัวเลขที่ยังไม่บันทึก', 'บันทึกก่อน แล้วค่อยกด F5', 'warn'); return; }
  App._dash = null; App.refresh(true);
});
window.addEventListener('DOMContentLoaded', () => { ThaiType.start(); App.start(); });

/* ===== stickers.js ===== */
/* =====================================================================
   Hand-drawn sticker icons (Japan Factory theme) — objects only, no faces.
   48×48 · pastel fill · ink outline (.o) · cel shade · white glint · optional sparkle.
   sticker(name, size, cls) → <svg>;  art(name) → sticker if one exists, else line icon.
   ===================================================================== */
'use strict';
const STK = (() => {
  const O = 'class="o"';
  const glint = d => `<path d="${d}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".9"/>`;
  const spark = (x, y, r = 4) => `<path d="M${x} ${y - r}Q${x + r * .25} ${y - r * .25} ${x + r} ${y}Q${x + r * .25} ${y + r * .25} ${x} ${y + r}Q${x - r * .25} ${y + r * .25} ${x - r} ${y}Q${x - r * .25} ${y - r * .25} ${x} ${y - r}Z" fill="#FFE7A3"/>`;
  return {
    home: `<path ${O} d="M8 22 24 9l16 13v16a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z" fill="#FFE9C4"/><path d="M24 9 40 22v4L24 13 8 26v-4z" fill="#F2958A"/><path ${O} d="M6 23 24 8l18 15" fill="none"/>
      <rect ${O} x="19" y="27" width="10" height="14" rx="2" fill="#A7D0FF"/><path d="M40 26v12a3 3 0 0 1-3 3h-4V27z" fill="#F3D9AE"/>${glint('M12 26v8')}`,
    entry: `<rect ${O} x="10" y="8" width="28" height="34" rx="4" fill="#FFFDF8"/><rect ${O} x="17" y="5" width="14" height="7" rx="2.5" fill="#DDB98E"/>
      <path d="M16 20h16M16 26h16M16 32h10" stroke="#A7B4C1" stroke-width="2.4" stroke-linecap="round"/><path d="M34 12h4v26a4 4 0 0 1-4 4h-2z" fill="#EFE6D6"/>
      <path ${O} d="m30 31 9-9 4 4-9 9-5 1z" fill="#FFD36E"/>${glint('M14 13v6')}`,
    stock: `<path ${O} d="M24 6 41 14v20L24 42 7 34V14z" fill="#DDB98E"/><path d="M24 22 41 14v20L24 42z" fill="#C9A274"/><path ${O} d="M7 14 24 22 41 14M24 22v20" fill="none"/>
      <path d="m15 10 17 8v6l-4-2v-5L11 12z" fill="#F7E3BF"/>${glint('M10 18v9')}${spark(38, 9)}`,
    order: `<path ${O} d="M6 9h5l4 21h21l4-15H13" fill="none"/><path ${O} d="M13 15h27l-4 15H15z" fill="#A7D0FF"/><path d="M28 15h12l-4 15h-7z" fill="#86B8EE"/>
      <circle ${O} cx="18" cy="38" r="3.4" fill="#EAF0F5"/><circle ${O} cx="33" cy="38" r="3.4" fill="#EAF0F5"/>${glint('M17 19h6')}`,
    truck: `<rect ${O} x="5" y="13" width="23" height="19" rx="3" fill="#FFD36E"/><path ${O} d="M28 19h8l6 7v6H28z" fill="#A7D0FF"/><path d="M5 26h23v6H8a3 3 0 0 1-3-3z" fill="#F6B73C"/>
      <circle ${O} cx="13" cy="35" r="4" fill="#EAF0F5"/><circle ${O} cx="34" cy="35" r="4" fill="#EAF0F5"/>${glint('M9 17h8')}`,
    a3: `<path ${O} d="M10 6h20l8 8v27a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" fill="#FFFDF8"/><path ${O} d="M30 6v8h8" fill="#EFE6D6"/>
      <path d="M13 20h20M13 25h20M13 30h20M13 35h12M19 20v15M26 20v15" stroke="#A7B4C1" stroke-width="1.8"/><rect x="13" y="16" width="20" height="4" fill="#A6E3E0"/>${glint('M12 10v6')}`,
    settings: `<path ${O} d="M24 6l3.4 4.6 5.6-1 1 5.6 4.6 3.4-3 4.4 3 4.4-4.6 3.4-1 5.6-5.6-1L24 42l-3.4-4.6-5.6 1-1-5.6L9.4 29.4l3-4.4-3-4.4 4.6-3.4 1-5.6 5.6 1z" fill="#C9D3DD"/>
      <circle ${O} cx="24" cy="24" r="6.5" fill="#FFFDF8"/>${glint('M15 16a12 12 0 0 1 5-4')}`,
    calendar: `<rect ${O} x="7" y="10" width="34" height="31" rx="5" fill="#FFFDF8"/><path ${O} d="M7 15a5 5 0 0 1 5-5h24a5 5 0 0 1 5 5v5H7z" fill="#F2958A"/>
      <path d="M15 6v8M33 6v8" class="o"/><rect x="14" y="26" width="6" height="5" rx="1.5" fill="#A7D0FF"/><rect x="24" y="26" width="6" height="5" rx="1.5" fill="#FFD36E"/>${glint('M11 24v8')}`,
    check: `<circle ${O} cx="24" cy="24" r="17" fill="#86D7A0"/><path d="M24 7a17 17 0 0 1 0 34 14 17 0 0 0 0-34z" fill="#62C17F"/><path d="m16 24 6 6 11-12" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${glint('M12 18a13 13 0 0 1 5-6')}`,
    alert: `<path ${O} d="M24 6 43 39a2 2 0 0 1-1.8 3H6.8A2 2 0 0 1 5 39z" fill="#FFC774"/><path d="M24 6 43 39a2 2 0 0 1-1.8 3H30z" fill="#F6B055"/>
      <path d="M24 18v11" stroke="#5E3F22" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="35" r="2.4" fill="#5E3F22"/>${glint('M16 26l4-7')}`,
    info: `<circle ${O} cx="24" cy="24" r="17" fill="#A7D0FF"/><path d="M24 7a17 17 0 0 1 0 34 14 17 0 0 0 0-34z" fill="#86B8EE"/><path d="M24 22v11" stroke="#24476F" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="16" r="2.6" fill="#24476F"/>${glint('M12 18a13 13 0 0 1 5-6')}`,
    sun: `<g stroke="#F6B73C" stroke-width="3" stroke-linecap="round"><path d="M24 4v5M24 39v5M4 24h5M39 24h5M10 10l3.5 3.5M34.5 34.5 38 38M10 38l3.5-3.5M34.5 13.5 38 10"/></g><circle ${O} cx="24" cy="24" r="10" fill="#FFD36E"/>${glint('M18 21a7 7 0 0 1 3-3')}`,
    moon: `<path ${O} d="M30 7a16 16 0 1 0 11 26A14 14 0 0 1 30 7z" fill="#C9CFF5"/><path d="M41 33A16 16 0 0 1 12 30a15 15 0 0 0 29 3z" fill="#A9B2EA"/>${spark(36, 12, 3.5)}${glint('M14 18a13 13 0 0 1 5-6')}`,
    user: `<circle ${O} cx="24" cy="17" r="8" fill="#FFE1C2"/><path ${O} d="M9 41c1-8 7-13 15-13s14 5 15 13z" fill="#A7D0FF"/>${glint('M19 13a5 5 0 0 1 3-2')}`,
    helmet: `<path ${O} d="M8 30a16 16 0 0 1 32 0z" fill="#FFD36E"/><path ${O} d="M5 30h38v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" fill="#F6B73C"/><path d="M24 14v16" class="o"/>${glint('M13 24a12 12 0 0 1 5-6')}`,
    shield: `<path ${O} d="M24 5 39 10v12c0 10-6 17-15 21C15 39 9 32 9 22V10z" fill="#C9B8FF"/><path d="M24 5 39 10v12c0 10-6 17-15 21z" fill="#B3A0F5"/>
      <path d="m17 23 5 5 9-10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>${glint('M13 14v7')}`,
    megaphone: `<path ${O} d="M8 19h7l17-9v28l-17-9H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" fill="#F2958A"/><path d="M32 10v28l-17-9v-4z" fill="#E77E73"/>
      <path ${O} d="M12 29l3 10h5l-2-10" fill="#FFE1C2"/><path d="M37 18c2 2 2 10 0 12M40 15c4 4 4 14 0 18" fill="none" stroke="#F6B73C" stroke-width="2.6" stroke-linecap="round"/>${glint('M10 22h4')}`,
    pencil: `<path ${O} d="M10 38l2-8 20-20 6 6-20 20z" fill="#FFD36E"/><path ${O} d="M32 10l6 6 3-3a2 2 0 0 0 0-3l-3-3a2 2 0 0 0-3 0z" fill="#F2958A"/><path d="M10 38l2-8 6 6z" fill="#FFE1C2"/>${glint('M16 28l12-12')}`,
    upload: `<path ${O} d="M10 28v9a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3v-9" fill="#EAF0F5"/><path ${O} d="M24 8 14 19h6v12h8V19h6z" fill="#A7D0FF"/>${glint('M19 18l4-5')}`,
    wifiOff: `<path d="M8 18a23 23 0 0 1 32 0M13 24a16 16 0 0 1 22 0M18 30a9 9 0 0 1 12 0" fill="none" stroke="#A7B4C1" stroke-width="3.4" stroke-linecap="round"/><circle cx="24" cy="36" r="3" fill="#A7B4C1"/><path d="M9 9l30 30" stroke="#E77E73" stroke-width="3.6" stroke-linecap="round"/>`,
    sparkle: `${spark(24, 24, 14)}${spark(38, 10, 5)}${spark(10, 38, 4)}`,
    shopbag: `<path ${O} d="M10 17h28l-2 23a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" fill="#FFD36E"/><path d="M28 17h10l-2 23a3 3 0 0 1-3 3h-5z" fill="#F6B73C"/>
      <path ${O} d="M17 21v-6a7 7 0 0 1 14 0v6" fill="none"/><circle cx="17" cy="22" r="2" fill="#6B5748"/><circle cx="31" cy="22" r="2" fill="#6B5748"/>
      <path d="M17 30h12" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>${glint('M14 22l-1 12')}${spark(39, 9)}`,
    history: `<circle ${O} cx="25" cy="25" r="16" fill="#A7D0FF"/><path d="M25 9a16 16 0 0 1 0 32 13 16 0 0 0 0-32z" fill="#86B8EE"/><circle ${O} cx="25" cy="25" r="11" fill="#FFFDF8"/>
      <path d="M25 18v7l5 3" stroke="#24476F" stroke-width="3" stroke-linecap="round" fill="none"/><path ${O} d="M6 14l3 6 6-3" fill="none"/>${glint('M13 17a13 13 0 0 1 5-5')}`,
    coil: `<path ${O} d="M24 9h8a15 15 0 0 1 0 30h-8z" fill="#9DB4CC"/><circle ${O} cx="22" cy="24" r="15" fill="#DCE8F5"/>
      <circle cx="22" cy="24" r="11" fill="none" stroke="#B5C7DA" stroke-width="1.6"/><circle cx="22" cy="24" r="7.5" fill="none" stroke="#B5C7DA" stroke-width="1.6"/>
      <circle ${O} cx="22" cy="24" r="4" fill="#7F96AF"/>${glint('M11 18a12 12 0 0 1 6-6')}${spark(38, 10)}`,
    tag: `<path ${O} d="M7 9v13l19 19a3 3 0 0 0 4 0l11-11a3 3 0 0 0 0-4L22 7H9a2 2 0 0 0-2 2z" fill="#A6E3E0"/><path d="M22 7l19 19a3 3 0 0 1 0 4L30 41a3 3 0 0 1-2 1z" fill="#82CFCB"/>
      <circle ${O} cx="15" cy="15" r="3.4" fill="#FFFDF8"/><path d="M20 26l8-8M24 30l8-8" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".85"/>${glint('M10 24v-8')}`,
    // ถุงเงิน ฿ + เหรียญ — ค่าใช้จ่ายเดือนนี้
    moneybag: `<path ${O} d="M17 15.5 13.5 8.5Q18.5 10.5 24 7.5Q29.5 10.5 34.5 8.5L31 15.5z" fill="#FFE29A"/>
      <path ${O} d="M17.5 15.5C9 23 7.5 41 22 41.5h4C40.5 41 39 23 30.5 15.5z" fill="#FFD36E"/>
      <path d="M30.5 15.5C37 21.5 39.5 34 33 39.5 35.5 31 33.5 22 27 16z" fill="#F6B73C"/>
      <rect ${O} x="16" y="13.5" width="16" height="4" rx="2" fill="#C98A3E"/>
      <path d="M21.5 25.5h4.2a2.4 2.4 0 0 1 0 4.8h-4.2zM21.5 30.3h4.8a2.6 2.6 0 0 1 0 5.2h-4.8zM21.5 25.5v10M23.6 23.5v14" fill="none" stroke="#A86A1C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse ${O} cx="38" cy="41" rx="6.5" ry="2.6" fill="#FFE7A3"/><path ${O} d="M31.5 41v-2.6c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V41" fill="#F6C14E"/>
      <ellipse ${O} cx="38" cy="37.6" rx="6.5" ry="2.6" fill="#FFE7A3"/>
      ${glint('M13.5 27q0-4 3-7')}${spark(40, 12, 3.6)}${spark(8, 34, 2.6)}`,
  };
})();
const STK_ALIAS = { logo: 'coil', master: 'tag', clipboard: 'entry', inbox: 'truck', doc: 'a3', cal: 'calendar', lock: 'shield', db: 'master', box: 'stock', note: 'megaphone' };
function sticker(name, size = 28, cls = '') {
  const k = STK[name] ? name : STK_ALIAS[name];
  if (!k) return '';
  return `<svg class="stk ${cls}" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">${STK[k]}</svg>`;
}
function art(name, size = 26, cls = '') { return sticker(name, size, cls) || ic(name); }

/* =====================================================================
   HRM Hydraulic theme — 3D tile icons (replace the hand-drawn stickers)
   48×48 · soft offset shadow tile · tinted gradient tile with white rim · glyph in a vertical gradient + dark depth copy
   One colour per meaning (HRM family palette); glyphs reuse the line-icon set so both families match.
   ===================================================================== */
const T3 = (() => {
  const C = { brand: '#2A64E8', refill: '#0E9A7B', oil: '#0F86A8', leak: '#D93A40', drain: '#2F7BF6', low: '#D39A06', abn: '#E36C12',
    maint: '#7652E8', adj: '#4F6B8F', run: '#1C9B55', idle: '#7F8898', day: '#E7A21B', night: '#5566C8' };
  const G = {
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    helmet: '<path d="M4.5 16a7.5 7.5 0 0 1 15 0"/><path d="M3 16h18v2.5H3zM12 8.5v4"/>',
    megaphone: '<path d="M4 10v4h3l8 4V6L7 10z"/><path d="M18 9.5a3.5 3.5 0 0 1 0 5M8 14l1 4.5h2.5"/>',
    sparkle: '<path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/>',
    shopbag: '<path d="M5.5 8h13l-1 12h-11z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
    wifiOff: '<path d="M5 9.5a10.5 10.5 0 0 1 14 0M8 13a6 6 0 0 1 8 0"/><circle cx="12" cy="17" r="1"/><path d="M4 4l16 16"/>',
    moneybag: '<path d="M9 7.5 7.6 4.5h8.8L15 7.5"/><path d="M9 7.5h6c2.9 2.5 4.5 6 4.5 8.6 0 3-2.6 4-7.5 4s-7.5-1-7.5-4C4.5 13.5 6.1 10 9 7.5z"/><path d="M10.6 11.8h2.2a1.3 1.3 0 0 1 0 2.6h-2.2zm0 2.6h2.5a1.4 1.4 0 0 1 0 2.8h-2.5zM10.6 11.8v5.4M11.7 10.8v7.4"/>',
  };
  // name → [colour, glyph] (glyph = a line icon from IC, or one of G)
  const M = {
    home: ['brand', 'home'], logo: ['brand', 'logo'], coil: ['brand', 'logo'], entry: ['brand', 'entry'], clipboard: ['brand', 'entry'],
    stock: ['oil', 'stock'], box: ['oil', 'stock'], order: ['abn', 'order'], truck: ['drain', 'truck'], inbox: ['drain', 'truck'],
    a3: ['adj', 'a3'], doc: ['adj', 'doc'], master: ['oil', 'master'], tag: ['oil', 'master'], settings: ['adj', 'settings'],
    calendar: ['day', 'cal'], cal: ['day', 'cal'], check: ['run', 'check'], alert: ['leak', 'alert'], info: ['brand', 'info'],
    sun: ['day', 'sun'], moon: ['night', 'moon'], user: ['adj', 'user'], helmet: ['adj', 'helmet'], shield: ['maint', 'shield'], lock: ['maint', 'shield'],
    megaphone: ['abn', 'megaphone'], note: ['abn', 'megaphone'], pencil: ['brand', 'edit'], upload: ['brand', 'upload'], wifiOff: ['idle', 'wifiOff'],
    sparkle: ['day', 'sparkle'], shopbag: ['low', 'shopbag'], history: ['adj', 'clock'], moneybag: ['low', 'moneybag'], coins: ['low', 'coins'], db: ['oil', 'master'],
  };
  return { C, G, M };
})();
/** 3D tile icon — HRM Hydraulic family */
function tile3d(name, size = 28, cls = '') {
  const m = T3.M[name]; if (!m) return '';
  const col = T3.C[m[0]], g = T3.G[m[1]] || (typeof IC !== 'undefined' && IC[m[1]]) || '', id = 't3' + m[0];
  return `<svg class="stk t3 ${cls}" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" style="--tc:${col}">
    <defs><linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="t3a"/><stop offset="1" class="t3b"/></linearGradient>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="t3c"/><stop offset="1" class="t3d"/></linearGradient></defs>
    <rect x="5.5" y="5.5" width="40" height="40" rx="14" class="t3s"/>
    <rect x="3" y="3" width="40" height="40" rx="14" fill="url(#${id}b)" stroke="rgba(255,255,255,.75)" stroke-width=".75"/>
    <path d="M10 9.5h20" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".45"/>
    <g transform="translate(9.8 10.6) scale(1.1)" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.25">
      <g class="t3k" transform="translate(0 1.45)">${g}</g><g stroke="url(#${id}g)">${g}</g></g></svg>`;
}
/* the theme uses 3D tiles everywhere a sticker was drawn; product pictures (shopPic / mpic) are unchanged */
sticker = function (name, size = 28, cls = '') {
  const n = T3.M[name] ? name : (STK_ALIAS[name] && T3.M[STK_ALIAS[name]] ? STK_ALIAS[name] : null);
  return n ? tile3d(n, size, cls) : '';
};

/* ===== a3.js ===== */
/* =====================================================================
   A3 MONTHLY FORM — faithful re-creation of the "Stock RM 2026.xlsx" monthly sheet
   1 page = 1 block = 6 materials × 31 days, A3 Landscape 420 × 297 mm.
   Column proportions come from the Excel column widths:
     A 3.3 | per material: รับสินค้า 7.7 · ทั้งหมด 7.1 · ใช้ไป 8.43 · คงเหลือ 8.3 · OPS 8.43 | gap 0.6
   Row heights come from the Excel rows (pt → mm). Only the original table is printed:
   no instructions column, no document ID, no footer / signature boxes.
   ===================================================================== */
'use strict';
const A3 = (() => {
  const U = 406 / 246.66; // mm per Excel width unit — 37 columns fill the 406 mm printable width
  const W = { a: 3.3, rcv: 7.7, tot: 7.1, used: 8.43, bal: 8.3, ops: 8.43, gap: 0.6 };
  const mm = u => (u * U).toFixed(2) + 'mm';
  const PT = 0.3528; // Excel row heights in points: 27.75 · 21.95 · 21.75 · 21.95 · 18.95 · 21 …
  const ROW = { upd: 27.75 * PT, name: 21.95 * PT, line: 21.85 * PT, head: 18.95 * PT, day: 21 * PT, sum: 21 * PT };
  const n = v => (v === null || v === undefined || v === '') ? '' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v);
  const e = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const UNIT_LONG = { L: 'Liter', Pail: 'Pails', Drum: 'Drums', Roll: 'Rolls', Box: 'Box' };
  const unitText = (u, q) => UNIT_LONG[u] ? (q === 1 && u !== 'L' ? u : UNIT_LONG[u]) : (u || '');
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const CSS = `
  .a3{width:420mm;height:297mm;padding:8mm 7mm;box-sizing:border-box;background:#fff;color:#000;
      font-family:"Leelawadee UI","HRM Thai","Noto Sans Thai Looped","Tahoma",sans-serif;position:relative;overflow:hidden}
  .a3 table{border-collapse:collapse;table-layout:fixed;width:${mm(W.a + 6 * (W.rcv + W.tot + W.used + W.bal + W.ops + W.gap))}}
  .a3 td{padding:0 1mm;overflow:hidden;white-space:nowrap;text-align:center;vertical-align:middle;line-height:1}
  .a3 .b{border:.6pt solid #000}
  .a3 .a3u td{height:${ROW.upd}mm;font-weight:700;font-size:11pt}
  .a3 .a3u td.a3t{font-size:18pt;text-align:center;letter-spacing:.02em}
  .a3 .a3n td.mh{height:${ROW.name}mm;font-weight:700;font-size:12.5pt}
  .a3 .a3l td{height:${ROW.line}mm;font-size:9.5pt;text-align:left}
  .a3 .a3h td{height:${ROW.head}mm;font-size:8pt;font-weight:700}
  .a3 .a3d td{height:${ROW.day}mm;font-size:11pt}
  .a3 .a3s td{height:${ROW.sum}mm;font-size:11pt;font-weight:700;color:#002060}
  .a3 td.mon{font-weight:700;font-size:11pt;padding:0}
  .a3 td.mon div{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;margin:0 auto;font-size:10pt;line-height:1}
  .a3 td.dn{font-size:10pt}
  .a3 .rcv{color:#00863D;font-weight:700}
  .a3 .tot{color:#000} .a3 .tot.first{color:#FF0000;font-weight:700}
  .a3 .bal{font-weight:700}
  .a3 .ops{color:#CC00FF;font-size:9.5pt}
  .a3 .gap{border:0}
  .a3 td.x{background:#AFABAB} .a3 .a3s td.b{background:#D0CECE} .a3 td.end{background:#FFE699}
  .a3 .fit>span{display:inline-block;white-space:nowrap}
  `;

  function colgroup(nmat) {
    let c = `<col style="width:${mm(W.a)}">`;
    for (let i = 0; i < 6; i++) {
      c += `<col style="width:${mm(W.rcv)}"><col style="width:${mm(W.tot)}"><col style="width:${mm(W.used)}"><col style="width:${mm(W.bal)}"><col style="width:${mm(W.ops)}"><col style="width:${mm(W.gap)}">`;
    }
    return `<colgroup>${c}</colgroup>`;
  }

  /** data: result of api a3_data  ·  opts.blank  ·  opts.today */
  function sheet(data, opts = {}) {
    const blank = !!opts.blank;
    const today = opts.today || '';
    const [y, mo] = data.month.split('-').map(Number);
    const monLabel = `${MON[mo - 1]} ${y}`;
    const mats = data.materials.slice(0, 6);
    while (mats.length < 6) mats.push(null);
    const nd = data.days;
    // last day that should show computed totals (no numbers on future days → space for handwriting)
    const lastShown = today.slice(0, 7) === data.month ? +today.slice(8, 10) : (today.slice(0, 7) > data.month ? nd : 0);

    const upd = new Date();
    const updS = `${String(upd.getDate()).padStart(2, '0')}/${String(upd.getMonth() + 1).padStart(2, '0')}/${upd.getFullYear()}`;
    let h = `<table>${colgroup()}`;
    // row 1 — UPDATE
    const title = opts.title !== undefined ? opts.title : A3.title();
    h += `<tr class="a3u"><td></td><td colspan="2" style="text-align:right">UPDATE :</td><td colspan="2" style="text-align:left">${blank ? '' : updS}</td><td colspan="6"></td><td colspan="14" class="a3t">${e(title || '')}</td><td colspan="11"></td></tr>`;
    // row 2 — material names
    h += `<tr class="a3n"><td class="b mon" rowspan="4"><div>${monLabel}</div></td>`;
    mats.forEach((m, i) => {
      h += m ? `<td class="b mh fit" colspan="5" style="background:#${e(m.a3_color || 'FFCC99')}"><span>${e(m.name)}</span></td>` : `<td class="b mh" colspan="5"></td>`;
      h += `<td class="gap"></td>`;
    });
    h += `</tr>`;
    // row 3/4 — reorder / order qty
    for (const k of ['rp', 'oq']) {
      h += `<tr class="a3l">`;
      mats.forEach(m => {
        if (!m) { h += `<td class="b" colspan="5"></td><td class="gap"></td>`; return; }
        const t = k === 'rp' ? `จำนวนคงเหลือที่ต้องสั่ง : ${n(m.reorder_point)} ${unitText(m.unit, m.reorder_point)}`
          : `จำนวนที่สั่งซื้อ : ${n(m.order_qty)} ${unitText(m.unit, m.order_qty)}${m.moq && m.moq === m.order_qty ? ' (MOQ)' : ''}`;
        h += `<td class="b fit" colspan="5"><span>${e(t)}</span></td><td class="gap"></td>`;
      });
      h += `</tr>`;
    }
    // row 5 — column heads
    h += `<tr class="a3h">`;
    mats.forEach(() => { h += `<td class="b">รับสินค้า</td><td class="b">ทั้งหมด</td><td class="b">ใช้ไป</td><td class="b">คงเหลือ</td><td class="b">OPS</td><td class="gap"></td>`; });
    h += `</tr>`;
    // day rows
    for (let d = 1; d <= 31; d++) {
      h += `<tr class="a3d"><td class="b dn${d > nd ? ' x' : ''}">${d <= nd ? d : ''}</td>`;
      mats.forEach(m => {
        if (d > nd) { h += `<td class="b x"></td>`.repeat(5) + `<td class="gap"></td>`; return; }
        if (!m || blank) { h += `<td class="b"></td><td class="b"></td><td class="b"></td><td class="b${d === nd ? ' end' : ''}"></td><td class="b"></td><td class="gap"></td>`; return; }
        const x = m.days[d - 1];
        const show = d <= lastShown;
        const ops = data.ops[d] || '';
        const f = v => v === '' ? '' : `<span>${v}</span>`;
        h += `<td class="b rcv fit">${f(n(x.rcv))}</td><td class="b tot fit ${d === 1 ? 'first' : ''}">${f(show || d === 1 ? n(x.total) : '')}</td>` +
          `<td class="b fit">${f(n(x.used))}</td><td class="b bal fit${d === nd ? ' end' : ''}">${f(show ? n(x.bal) : '')}</td><td class="b ops fit"><span>${e(ops)}</span></td><td class="gap"></td>`;
      });
      h += `</tr>`;
    }
    // sum row
    h += `<tr class="a3s"><td class="b"></td>`;
    mats.forEach(m => {
      h += (m && !blank) ? `<td class="b fit"><span>${n(m.sum_rcv) || ''}</span></td><td class="b"></td><td class="b fit"><span>${n(m.sum_used) || ''}</span></td><td class="b"></td><td class="b"></td><td class="gap"></td>`
        : `<td class="b"></td><td class="b"></td><td class="b"></td><td class="b"></td><td class="b"></td><td class="gap"></td>`;
    });
    h += `</tr></table>`;

    return `<div class="a3">${h}</div>`;
  }

  // squeeze long texts (e.g. "จำนวนคงเหลือที่ต้องสั่ง : 16,000 Liter") into their merged cell, like Excel shrink-to-fit
  function fit(root) {
    root.querySelectorAll('.fit>span').forEach(s => {
      s.style.fontSize = '';
      const td = s.parentElement, avail = td.clientWidth - 3, w = s.scrollWidth;
      if (w > avail && avail > 0) s.style.fontSize = (parseFloat(getComputedStyle(s).fontSize) * avail / w * 0.94).toFixed(2) + 'px';
    });
  }

  function printDoc(pages, title, autoPrint = true) {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${e(title)}</title><style>
      @font-face{font-family:"HRM Thai";font-weight:400;src:url(__FONTS__noto-sans-thai-looped-thai-400-normal.woff2) format("woff2")}
      @font-face{font-family:"HRM Thai";font-weight:700;src:url(__FONTS__noto-sans-thai-looped-thai-700-normal.woff2) format("woff2")}
      @page{size:420mm 297mm;margin:0}
      html,body{margin:0;padding:0;background:#fff}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .a3{page-break-after:always;break-after:page} .a3:last-child{page-break-after:auto;break-after:auto}
      @media screen{body{background:#888}.a3{margin:10mm auto;box-shadow:0 4px 30px rgba(0,0,0,.4)}}
      ${CSS}</style></head><body>${pages.join('')}
      <script>
      ${fit.toString()}
      window.addEventListener('load',()=>{document.fonts.ready.then(()=>{fit(document);${autoPrint ? 'setTimeout(()=>window.print(),300)' : ''}})});
      </script></body></html>`;
  }

  /** all A3 pages of one month (api month_get result) */
  function monthPages(mg, opts = {}) {
    const n = Math.max(1, Math.ceil(mg.materials.length / 6)), out = [];
    for (let pg = 1; pg <= n; pg++) out.push(sheet({ month: mg.month, page: pg, pages: n, days: mg.days, ops: mg.ops, materials: mg.materials.slice((pg - 1) * 6, pg * 6) }, opts));
    return out;
  }

  /** heading printed on top of the form — default "Stock HRM", editable, or none (empty) */
  const title = () => { const v = localStorageGet('a3Title'); return v === null ? 'Stock HRM' : v; };
  const setTitle = v => localStorageSet('a3Title', String(v || '').trim().slice(0, 60));
  return { sheet, fit, printDoc, monthPages, CSS, title, setTitle };
})();

/* ===== pages.js ===== */
/* =====================================================================
   HRM STOCK CONTROL MANAGEMENT — pages
   ===================================================================== */
'use strict';

/** A3 header colours — light tones only, so the black Material name stays readable on a black-and-white print */
const A3_COLORS = [['FFCC99', 'ส้มอ่อน'], ['33CCCC', 'ฟ้าอมเขียว'], ['FFFF99', 'เหลืองอ่อน'], ['FFE699', 'เหลืองทอง'], ['FFD9B3', 'พีช'],
  ['FFC7CE', 'ชมพูแดง'], ['FFCCFF', 'ชมพูอ่อน'], ['CCCCFF', 'ลาเวนเดอร์'], ['BDD7EE', 'ฟ้าอ่อน'], ['99CCFF', 'ฟ้า'],
  ['CCFFFF', 'ฟ้าน้ำแข็ง'], ['99FFCC', 'เขียวมิ้นต์'], ['CCFFCC', 'เขียวอ่อน'], ['C6E0B4', 'เขียวใบไม้'], ['D9D9D9', 'เทาอ่อน'], ['FFFFFF', 'ไม่มีสี']];

/* =============================== STOCK ENTRY =============================== */
PAGES.entry = {
  title: ['กรอก STOCK', 'Stock Entry'],
  mode: 'day', date: null, month: null, page: 1, data: null, dirtyMap: {},
  dirty() { return Object.keys(this.dirtyMap).length > 0 || this._opsDirty; },
  header(slot) {
    slot.innerHTML = `<div class="seg" id="emode"><button data-m="day" class="${this.mode === 'day' ? 'on' : ''}">${ic('list', 'sm')}รายวัน</button><button data-m="month" class="${this.mode === 'month' ? 'on' : ''}">${ic('sheet', 'sm')}รายเดือน (แบบ A3)</button></div>`;
    slot.querySelector('#emode').onclick = async e => {
      const b = e.target.closest('[data-m]'); if (!b || b.dataset.m === this.mode) return;
      if (this.dirty() && !await modal({ title: 'มีข้อมูลที่ยังไม่บันทึก', en: 'Unsaved changes', body: '<p class="muted">เปลี่ยนมุมมองแล้วตัวเลขที่ยังไม่บันทึกจะหายไป</p>', ok: 'เปลี่ยนโดยไม่บันทึก', okEn: 'Discard', danger: true })) return;
      this.mode = b.dataset.m; this.dirtyMap = {}; this._opsDirty = false; App.renderHeader(); this.render($('#content'), {});
    };
  },
  async render(el, params = {}, soft = false) {
    if (params.date) { this.date = params.date; this.mode = 'day'; }
    if (!this.date) this.date = App.today;
    if (!soft) { this.dirtyMap = {}; this._opsDirty = false; }
    if (this.mode === 'month') return this.renderMonth(el);
    const [d, days, dash] = await Promise.all([api('day_get', this.date), api('days_status', this.date.slice(0, 7)), App.dash()]);
    this.data = d;
    const T = App.today, dt0 = pd(this.date);
    const locked = !!d.verified_at && !App.officer;
    const miss = Shift.workDays(dash.missing_days);
    const first = (dt0.getDay() + 0); // calendar strip is a simple 1..31 strip
    const strip = days.map(x => {
      const dd = +x.date.slice(8);
      const cls = [x.date === this.date ? 'sel' : '', x.date === T ? 'today' : '', x.date > T ? 'fut' : '',
      x.verified ? 'ver' : x.recorded ? 'rec' : (x.tracked && x.date < T ? 'miss' : '')].join(' ');
      return `<button class="${cls}" data-day="${x.date}" title="${fmtD(x.date)}${x.ops ? ' · ' + x.ops : ''}">${dd}<i></i></button>`;
    }).join('') + Array(31 - days.length).fill('<button class="blank"></button>').join('');

    const rows = d.rows.map((r, i) => this.rowHtml(r, i, locked)).join('');
    const wd = TH_WD[dt0.getDay()];
    const rel = this.date === T ? 'วันนี้' : relDay(this.date, T)[0];
    const missChip = miss.length && !(miss.length === 1 && miss[0] === this.date)
      ? `<button class="chip" style="height:34px;padding:0 12px;background:var(--leak-soft);color:var(--leak);font-size:13px" data-day="${miss[0]}">${ic('alert', 'sm')}ยังไม่บันทึก ${miss.length} วัน · ไปวันที่ ${fmtDShort(miss[0])}${Shift.teamOn(miss[0]) ? ' (ทีม ' + Shift.label(Shift.teamOn(miss[0])) + ')' : ''} ${ic('arrowR', 'sm')}</button>` : '';
    const state = d.verified_at
      ? `<span class="badge ok"><span class="dot"></span>${bi(`Officer ยืนยันแล้ว · ${d.verified_by || ''}`, locked ? 'LOCKED' : 'VERIFIED — OFFICER CAN EDIT')}</span>${App.officer ? `<button class="btn btn-ghost sm" data-unverify>${ic('undo', 'sm')}ยกเลิกยืนยัน</button>` : ''}`
      : d.saved_at ? `<span class="badge sched"><span class="dot"></span>${bi(`บันทึกแล้ว ${fmtTime(d.saved_at)}`, 'SAVED · WAITING OFFICER')}</span>` : `<span class="badge ordered"><span class="dot"></span>${bi('ยังไม่บันทึก', 'NOT SAVED')}</span>`;
    el.innerHTML = `<div class="page entry">
      <div class="entry-top glass">
        <div class="et-row">
          <div class="datebox">
            <button class="icon-btn" data-nav="-1" title="วันก่อนหน้า">${ic('chevL')}</button>
            <label class="dlabel" style="cursor:pointer;position:relative"><div class="d">${wd} ${fmtD(this.date)}</div><div class="s">${rel} · ${fmtDEn(this.date)}</div><input type="date" id="dpick" value="${this.date}" max="${T}"></label>
            <button class="icon-btn" data-nav="1" title="วันถัดไป" ${this.date >= T ? 'disabled style="opacity:.35"' : ''}>${ic('chevR')}</button>
            ${this.date !== T ? `<button class="btn btn-ghost sm" data-today>${ic('cal', 'sm')}วันนี้</button>` : ''}
          </div>
          ${state}${missChip}
          <span style="flex:1"></span>
          <div class="opsbox"><div class="flabel" style="flex-direction:column;gap:0;align-items:flex-end">${bi('ผู้บันทึก', 'OPS')}</div>
            <input class="input" id="ops" maxlength="12" value="${esc(d.ops || '')}" placeholder="${esc(d.prev_ops || 'ชื่อ')}" ${locked ? 'readonly' : ''} autocomplete="off" spellcheck="false"></div>
          ${App.officer && d.saved_at && !d.verified_at ? `<button class="btn btn-ok" data-verify>${ic('shield', 'sm')}${bi('ยืนยันข้อมูล', 'Verify')}</button>` : ''}
          <button class="btn btn-primary lg" id="save" ${locked || d.is_future ? 'disabled' : ''}>${ic('check')}${bi('บันทึก', 'Save · Ctrl+S')}</button>
        </div>
        <div class="calstrip">${strip}</div>
      </div>
      <div class="card ledger">
        <table class="lgrid" id="lg">
          <thead><tr><th class="l" style="width:44px">#</th><th class="l">Material<span class="en">จาก Material Master</span></th>
            <th>ทั้งหมด<span class="en">Opening</span></th><th>รับสินค้า<span class="en">Received</span></th><th>ใช้ไป<span class="en">Used</span></th>
            <th>คงเหลือ<span class="en">Balance</span></th><th class="rp">จุดสั่งซื้อ<span class="en">Reorder</span></th><th class="l">สถานะ<span class="en">Status</span></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="ledger-foot"><div class="keys"><span><kbd>Enter</kbd>ลงบรรทัดถัดไป</span><span><kbd>Tab</kbd>ช่องถัดไป</span><span><kbd>↑</kbd><kbd>↓</kbd>เลื่อนแถว</span><span><kbd>Esc</kbd>คืนค่าเดิม</span><span><kbd>Ctrl</kbd><kbd>S</kbd>บันทึก</span></div><span style="flex:1"></span><span class="hint" id="dcount"></span></div>
      </div></div>`;
    this.bind(el);
    this.updateCount();
    if (!soft) setTimeout(() => { const o = $('#ops'); if (o && !o.value && !locked) o.focus(); else $('#lg .cell[data-c="1"]')?.focus(); }, 60);
  },
  rowHtml(r, i, locked) {
    const after = r.after, low = r.reorder_point > 0 && after <= r.reorder_point;
    const oo = r.open_orders[0];
    return `<tr data-i="${i}" data-id="${r.id}">
      <td class="idx">${i + 1}</td>
      <td class="l mat"><div class="mat-w">${mpic(r, 34)}<div><span class="th" title="${esc(r.name)}">${esc(r.name)}</span><span class="en">${esc(r.name_en || r.code)} · ${esc(r.unit)}</span></div></div></td>
      <td class="before num">${fmtN(r.before)}<span class="unit">${esc(r.unit)}</span></td>
      <td class="inp"><input class="cell rcv num" data-r="${i}" data-c="0" inputmode="decimal" value="${r.received ?? ''}" placeholder="${oo && oo.expected_date && oo.expected_date <= App.today ? 'รอรับ ' + fmtN(oo.remaining) : ''}" ${locked ? 'readonly' : ''} autocomplete="off"></td>
      <td class="inp"><input class="cell num" data-r="${i}" data-c="1" inputmode="decimal" value="${r.used ?? ''}" ${locked ? 'readonly' : ''} autocomplete="off"></td>
      <td class="after num ${low ? 'low' : ''}" data-after>${fmtN(after)}<span class="unit">${esc(r.unit)}</span></td>
      <td class="rp num">${ovrTag(r)}${fmtN(r.reorder_point)}${qeBtn(r.id)}</td>
      <td class="l st" data-st>${this.stHtml(r, after)}</td></tr>`;
  },
  stHtml(r, after) {
    const low = r.reorder_point > 0 && after <= r.reorder_point;
    if (after < 0) return `<span class="badge need"><span class="dot"></span>ติดลบ!</span>`;
    if (r.open_orders.length) return `<span class="badge ${low ? 'ordered' : 'sched'}"><span class="dot"></span>${bi('สั่งแล้ว', 'ORDERED')}</span>`;
    if (low) return `<span class="badge need"><span class="dot"></span>${bi('ต้องสั่ง', 'NEED ORDER')}</span>`;
    return `<span class="badge ok"><span class="dot"></span>${bi('ปกติ', 'NORMAL')}</span>`;
  },
  bind(el) {
    const T = App.today;
    el.querySelector('#dpick').onchange = e => e.target.value && App.go('entry', { date: e.target.value > T ? T : e.target.value });
    el.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { const n = addDays(this.date, +b.dataset.nav); if (n <= T) App.go('entry', { date: n }); });
    el.addEventListener('click', async e => {
      const dd = e.target.closest('[data-day]'); if (dd) return App.go('entry', { date: dd.dataset.day });
      if (e.target.closest('[data-today]')) return App.go('entry', { date: T });
      if (e.target.closest('[data-verify]')) { if (this.dirty()) return toast('บันทึกก่อนยืนยัน', '', 'warn'); try { await api('day_verify', this.date, true); toast('ยืนยันข้อมูลแล้ว', fmtD(this.date)); App.bumpRev(); this.render(el, {}); } catch (er) { toastErr(er); } }
      if (e.target.closest('[data-unverify]')) { try { await api('day_verify', this.date, false); App.bumpRev(); this.render(el, {}); } catch (er) { toastErr(er); } }
    });
    const ops = el.querySelector('#ops');
    ops.oninput = () => { ops.value = ops.value.toUpperCase(); this._opsDirty = ops.value !== (this.data.ops || ''); ops.classList.remove('err'); this.updateCount(); };
    ops.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!ops.value && this.data.prev_ops) { ops.value = this.data.prev_ops; ops.oninput(); } el.querySelector('.cell[data-c="1"]')?.focus(); } };
    el.querySelector('#save').onclick = () => this.save();
    const grid = el.querySelector('#lg');
    const n = this.data.rows.length;
    const focusCell = (r, c) => { const x = grid.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`); if (x) { x.focus(); x.select(); } };
    grid.addEventListener('focusin', e => { const c = e.target.closest('.cell'); if (!c) return; $$('tr.cur', grid).forEach(t => t.classList.remove('cur')); c.closest('tr').classList.add('cur'); setTimeout(() => c.select(), 0); });
    grid.addEventListener('keydown', e => {
      const c = e.target.closest('.cell'); if (!c) return;
      const r = +c.dataset.r, col = +c.dataset.c;
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); if (e.key === 'Enter' && e.shiftKey) return focusCell(Math.max(0, r - 1), col); if (r < n - 1) focusCell(r + 1, col); else $('#save').focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (r > 0) focusCell(r - 1, col); }
      else if (e.key === 'ArrowRight' && col === 0 && c.selectionStart === c.value.length) { e.preventDefault(); focusCell(r, 1); }
      else if (e.key === 'ArrowLeft' && col === 1 && c.selectionStart === 0 && c.selectionEnd === 0) { e.preventDefault(); focusCell(r, 0); }
      else if (e.key === 'Escape') { const row = this.data.rows[r]; c.value = (col ? row.used : row.received) ?? ''; c.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    grid.addEventListener('input', e => {
      const c = e.target.closest('.cell'); if (!c) return;
      c.value = c.value.replace(/[^\d.,]/g, '');
      const r = +c.dataset.r, row = this.data.rows[r], tr = c.closest('tr');
      const rv = parseNum(tr.querySelector('[data-c="0"]').value), uv = parseNum(tr.querySelector('[data-c="1"]').value);
      [[0, rv, row.received], [1, uv, row.used]].forEach(([k, v, orig]) => {
        const inp = tr.querySelector(`[data-c="${k}"]`);
        const changed = (v ?? null) !== (orig ?? null);
        inp.classList.toggle('dirty', changed && !Number.isNaN(v)); inp.classList.toggle('bad', Number.isNaN(v));
        const key = row.id + ':' + k; if (changed) this.dirtyMap[key] = 1; else delete this.dirtyMap[key];
      });
      const after = row.before + (Number.isNaN(rv) ? 0 : rv || 0) - (Number.isNaN(uv) ? 0 : uv || 0);
      const a = tr.querySelector('[data-after]'); a.innerHTML = `${fmtN(after)}<span class="unit">${esc(row.unit)}</span>`; a.classList.toggle('low', row.reorder_point > 0 && after <= row.reorder_point);
      tr.querySelector('[data-st]').innerHTML = this.stHtml(row, after);
      this.updateCount();
    });
  },
  updateCount() {
    const n = Object.keys(this.dirtyMap).length, el = $('#dcount');
    if (el) el.innerHTML = n ? `<b style="color:var(--abn)">แก้ไข ${n} ช่อง — ยังไม่บันทึก</b>` : (this.data?.saved_at ? 'ข้อมูลตรงกับที่บันทึกไว้' : `${this.data?.rows.length || 0} รายการ จาก Material Master`);
  },
  async save() {
    if (this.mode === 'month') return this.saveMonth();
    const el = $('#content'), ops = $('#ops');
    if (!ops || ops.readOnly) return;
    if (!ops.value.trim()) { ops.classList.add('err'); ops.focus(); return toast('กรุณากรอกชื่อผู้บันทึก (OPS)', 'พิมพ์ชื่อเล่นแล้วกด Enter', 'warn'); }
    const bad = $$('#lg .cell.bad'); if (bad.length) { bad[0].focus(); return toast('มีช่องที่ไม่ใช่ตัวเลข', '', 'warn'); }
    const rows = $$('#lg tbody tr').map(tr => ({ id: +tr.dataset.id, received: tr.querySelector('[data-c="0"]').value, used: tr.querySelector('[data-c="1"]').value }));
    const neg = this.data.rows.filter((r, i) => r.before + (parseNum(rows[i].received) || 0) - (parseNum(rows[i].used) || 0) < 0);
    if (neg.length && !await modal({ title: 'คงเหลือติดลบ', en: 'Negative balance', body: `<p class="muted">${neg.map(r => esc(r.name)).join(', ')}<br>ใช้ไปมากกว่ายอดที่มี ตรวจสอบตัวเลขอีกครั้ง</p>`, ok: 'บันทึกต่อ', okEn: 'Save anyway' })) return;
    // numbers that were already saved and are now changed → warning + reason (the Officer is notified)
    const fixes = [];
    this.data.rows.forEach((r, i) => [['received', rows[i].received], ['used', rows[i].used]].forEach(([f, v]) => {
      const nv = parseNum(v) ?? null;
      if (r[f] !== null && r[f] !== undefined && nv !== r[f]) fixes.push({ name: r.name, unit: r.unit, date: this.date, field: f, old: r[f], new: nv });
    }));
    let reason = '';
    if (fixes.length) { reason = await StockFix.ask(fixes); if (reason === null) return; }
    const btn = $('#save'); btn.disabled = true;
    try {
      const r = await api('day_save', this.date, ops.value, rows, reason ? { reason } : undefined);
      this.dirtyMap = {}; this._opsDirty = false;
      toast('บันทึกแล้ว', `${fmtD(this.date)} · ${esc(ops.value)} · แก้ไข ${r.changed} รายการ`);
      await App.bumpRev();
      const dash = await App.dash();
      const next = dash.missing_days.find(x => x > this.date);
      if (next) App.go('entry', { date: next }, true); else this.render(el, {});
    } catch (e) { toastErr(e); btn.disabled = false; }
  },

  /* ---- month (Excel / A3 layout) ---- */
  async renderMonth(el) {
    this.month = this.month || this.date.slice(0, 7);
    const m = await api('month_get', this.month);
    this.mdata = m;
    const pages = Math.max(1, Math.ceil(m.materials.length / 6));
    if (this.page > pages) this.page = 1;
    const mats = m.materials.slice((this.page - 1) * 6, this.page * 6);
    const T = App.today;
    const tabs = Array.from({ length: pages }, (_, i) => `<button data-pg="${i + 1}" class="${this.page === i + 1 ? 'on' : ''}">หน้า ${i + 1}<span class="n">${m.materials.slice(i * 6, i * 6 + 6).length}</span></button>`).join('');
    let head1 = `<th class="day" rowspan="2">วันที่</th>`, head2 = '';
    mats.forEach(x => {
      head1 += `<th colspan="5" class="grp mh" style="--hc:#${esc(x.a3_color || 'FFCC99')}">${esc(x.name)}<div style="font-size:11px;font-weight:600;color:var(--fg-2)">ยกมา ${fmtN(x.opening)} ${esc(x.unit)} ${App.officer ? `<span class="link" data-open="${x.id}" title="แก้ยอดยกมา">${ic('edit', 'sm')}</span>` : ''}</div><div style="font-size:11px;font-weight:600;color:var(--fg-3);display:flex;align-items:center;justify-content:center;gap:2px">จุดสั่ง ${fmtN(x.reorder_point)} · สั่ง ${fmtN(x.order_qty)}${qeBtn(x.id)}</div></th>`;
      head2 += `<th class="grp">รับสินค้า</th><th>ทั้งหมด</th><th>ใช้ไป</th><th>คงเหลือ</th><th class="opsh">OPS</th>`;
    });
    let body = '';
    for (let d = 1; d <= m.days; d++) {
      const ds = `${this.month}-${String(d).padStart(2, '0')}`, fut = ds > T, wk = [0, 6].includes(pd(ds).getDay());
      body += `<tr class="${wk ? 'wk' : ''} ${ds === T ? 'today' : ''}"><td class="day">${d}</td>`;
      mats.forEach(x => {
        const v = x.days[d - 1];
        body += `<td class="ed r grp"><input data-d="${d}" data-id="${x.id}" data-f="received" value="${v.rcv ?? ''}" ${fut ? 'disabled' : ''}></td><td class="tot num">${fut ? '' : fmtN(v.total)}</td>
          <td class="ed"><input data-d="${d}" data-id="${x.id}" data-f="used" value="${v.used ?? ''}" ${fut ? 'disabled' : ''}></td><td class="bal num">${fut ? '' : fmtN(v.bal)}</td>
          <td class="ops ${fut ? 'fut' : ''}" data-ops="${d}" ${fut ? '' : 'title="ดับเบิลคลิกเพื่อพิมพ์ชื่อ OPS — ชื่อจะใส่ให้ทุกช่องของวันนี้"'}>${esc(m.ops[d] || '')}</td>`;
      });
      body += `</tr>`;
    }
    let foot = `<td class="day">รวม</td>`;
    mats.forEach(x => { foot += `<td class="grp num">${fmtN(x.sum_rcv)}</td><td></td><td class="num">${fmtN(x.sum_used)}</td><td class="num">${fmtN(x.close)}</td><td></td>`; });
    const prevM = (() => { const d = pd(this.month + '-01'); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
    const nextM = (() => { const d = pd(this.month + '-01'); d.setMonth(d.getMonth() + 1); return iso(d).slice(0, 7); })();
    el.innerHTML = `<div class="page">
      <div class="toolbar">
        <div class="datebox"><button class="icon-btn" data-m="${prevM}">${ic('chevL')}</button><div class="dlabel"><div class="d">${fmtMonth(this.month)}</div><div class="s">${fmtMonthEn(this.month)} · เหมือนฟอร์ม A3</div></div><button class="icon-btn" data-m="${nextM}" ${nextM > T.slice(0, 7) ? 'disabled style="opacity:.35"' : ''}>${ic('chevR')}</button></div>
        <div class="seg" id="pgs">${tabs}</div><span class="grow"></span>
        <div class="opsbox"><div class="flabel" style="flex-direction:column;gap:0;align-items:flex-end">${bi('ผู้แก้ไข', 'OPS')}</div><input class="input" id="mops" maxlength="12" placeholder="ชื่อ" style="width:130px;height:44px;font-size:17px"></div>
        <button class="btn btn-primary" id="msave">${ic('check', 'sm')}บันทึก</button>
      </div>
      <div class="sheetwrap card" style="padding:0"><table class="msheet num"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${body}</tbody><tfoot><tr>${foot}</tr></tfoot></table></div>
      <p class="hint" style="margin:10px 4px">ช่องสีเขียว = รับสินค้า · ทั้งหมด/คงเหลือคำนวณอัตโนมัติ (ทั้งหมด + รับ − ใช้ไป) · วันที่ Officer ยืนยันแล้ว Operator แก้ไม่ได้</p></div>`;
    el.querySelector('#pgs').onclick = e => { const b = e.target.closest('[data-pg]'); if (b) { if (this.dirty()) return toast('บันทึกก่อนเปลี่ยนหน้า', '', 'warn'); this.page = +b.dataset.pg; this.renderMonth(el); } };
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { if (this.dirty()) return toast('บันทึกก่อนเปลี่ยนเดือน', '', 'warn'); this.month = b.dataset.m; this.renderMonth(el); });
    el.querySelector('#msave').onclick = () => this.saveMonth();
    const tbl = el.querySelector('.msheet');
    tbl.addEventListener('input', e => {
      const i = e.target; if (!i.dataset.f) return;
      i.value = i.value.replace(/[^\d.,]/g, '');
      const x = mats.find(z => z.id === +i.dataset.id).days[+i.dataset.d - 1];
      const orig = i.dataset.f === 'received' ? x.rcv : x.used;
      const ch = (parseNum(i.value) ?? null) !== (orig ?? null);
      i.classList.toggle('dirty', ch);
      const k = `${i.dataset.d}:${i.dataset.id}:${i.dataset.f}`; if (ch) this.dirtyMap[k] = 1; else delete this.dirtyMap[k];
    });
    tbl.addEventListener('keydown', e => {
      const i = e.target; if (!i.dataset.f) return;
      const inputs = $$('input:not([disabled])', tbl), cols = mats.length * 2;
      const idx = inputs.indexOf(i);
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); inputs[idx + cols]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); inputs[idx - cols]?.focus(); }
      if (e.key === 'ArrowRight' && i.selectionStart === i.value.length) { e.preventDefault(); inputs[idx + 1]?.focus(); }
      if (e.key === 'ArrowLeft' && i.selectionStart === 0) { e.preventDefault(); inputs[idx - 1]?.focus(); }
    });
    tbl.addEventListener('focusin', e => e.target.select?.());
    // OPS: double-click a cell → type the name → it fills every OPS cell of that day (all Material, all pages, the A3 print)
    tbl.addEventListener('dblclick', e => {
      const c = e.target.closest('td.ops'); if (!c || c.classList.contains('fut') || c.querySelector('input')) return;
      const d = +c.dataset.ops, old = m.ops[d] || '', same = () => $$(`td.ops[data-ops="${d}"]`, tbl).filter(x => x !== c);
      c.classList.add('editing');
      c.innerHTML = `<input class="ops-in" maxlength="12" value="${esc(old)}" placeholder="ชื่อ" data-date="${PAGES.entry.month}-${String(d).padStart(2, '0')}">`;
      const i = c.querySelector('input'); i.focus(); i.select();
      i.oninput = () => same().forEach(x => { x.textContent = i.value.toUpperCase(); x.classList.toggle('pending', i.value.trim().toUpperCase() !== old); });
      let done = false;
      const fin = async ok => {
        if (done) return; done = true;
        const v = i.value.trim().toUpperCase();
        const restore = val => { c.classList.remove('editing'); $$(`td.ops[data-ops="${d}"]`, tbl).forEach(x => { x.textContent = val; x.classList.remove('pending'); }); };
        if (!ok || v === old) return restore(old);
        if (!v) { restore(old); return toast('ลบชื่อ OPS ไม่ได้', 'พิมพ์ชื่อใหม่แทนได้', 'warn'); }
        const ds = `${this.month}-${String(d).padStart(2, '0')}`;
        c.classList.remove('editing'); c.textContent = v; c.classList.add('pending');
        try {
          await api('day_save', ds, v, []);
          m.ops[d] = v; restore(v);
          $$(`td.ops[data-ops="${d}"]`, tbl).forEach(x => { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); });
          toast(`OPS วันที่ ${d} → ${esc(v)}`, `ใส่ให้ทุกช่องของ ${fmtD(ds)} แล้ว`);
          App.bumpRev();
        } catch (er) { restore(old); toastErr(er); }
      };
      i.onkeydown = ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); fin(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); fin(false); }
        else if (ev.key === 'Tab') { ev.preventDefault(); fin(true); }
      };
      i.onblur = () => fin(true);
    });
    el.addEventListener('click', async e => {
      const o = e.target.closest('[data-open]'); if (!o) return;
      const x = m.materials.find(z => z.id === +o.dataset.open);
      await modal({
        title: 'ยอดยกมาต้นเดือน', en: 'Opening balance', icon: 'edit', color: 'var(--primary)',
        body: `<p class="muted" style="margin-top:0">${esc(x.name)} · ${fmtMonth(this.month)}<br>ปกติ = ยอดคงเหลือสิ้นเดือนก่อน แก้เมื่อตรวจนับแล้วไม่ตรง (เว้นว่าง = ใช้ยอดเดือนก่อน)</p><div class="input-wrap"><input class="input num" id="opq" value="${x.opening_explicit ? x.opening : ''}" placeholder="${fmtN(x.opening)}"><span class="unit">${esc(x.unit)}</span></div><div class="err-text"></div>`,
        ok: 'บันทึก', okEn: 'Save', onOk: async m2 => { await api('opening_save', this.month, x.id, m2.querySelector('#opq').value); toast('แก้ยอดยกมาแล้ว', esc(x.name)); App.bumpRev(); this.renderMonth(el); },
      });
    });
  },
  async saveMonth() {
    if (!Object.keys(this.dirtyMap).length) return toast('ไม่มีการเปลี่ยนแปลง', '', 'info');
    const byDay = {};
    $$('.msheet input.dirty').forEach(i => {
      const d = +i.dataset.d, id = +i.dataset.id;
      byDay[d] = byDay[d] || {};
      const cur = byDay[d][id] || (() => { const x = this.mdata.materials.find(z => z.id === id).days[d - 1]; return { id, received: x.rcv ?? '', used: x.used ?? '' }; })();
      cur[i.dataset.f] = i.value; byDay[d][id] = cur;
    });
    const editor = $('#mops').value.trim().toUpperCase();
    const miss = Object.keys(byDay).find(d => !(this.mdata.ops[d] || editor));
    if (miss) { $('#mops').classList.add('err'); $('#mops').focus(); return toast(`วันที่ ${miss} ยังไม่มี OPS`, 'กรอกชื่อผู้แก้ไขก่อนบันทึก', 'warn'); }
    const fixes = [];
    Object.entries(byDay).forEach(([d, rows]) => Object.values(rows).forEach(r => {
      const x = this.mdata.materials.find(z => z.id === r.id), v = x.days[d - 1];
      [['received', v.rcv, r.received], ['used', v.used, r.used]].forEach(([f, o, n]) => {
        const nv = parseNum(n) ?? null;
        if (o !== null && o !== undefined && nv !== o) fixes.push({ name: x.name, unit: x.unit, date: `${this.month}-${String(d).padStart(2, '0')}`, field: f, old: o, new: nv });
      });
    }));
    let reason = '';
    if (fixes.length) { reason = await StockFix.ask(fixes); if (reason === null) return; }
    try {
      for (const [d, rows] of Object.entries(byDay)) {
        const ops = this.mdata.ops[d] || editor;
        await api('day_save', `${this.month}-${String(d).padStart(2, '0')}`, ops, Object.values(rows), { reason, month: true });
      }
      this.dirtyMap = {}; toast('บันทึกแล้ว', `${Object.keys(byDay).length} วัน`); App.bumpRev(); this.renderMonth($('#content'));
    } catch (e) { toastErr(e); }
  },
};

/* =============================== CURRENT STOCK =============================== */
PAGES.stock = {
  title: ['สต็อกคงเหลือ', 'Current Stock'], filter: 'all', q: '', view: 'list',
  async render(el, params = {}) {
    if (params.filter === 'need') this.filter = 'need';
    const list = await api('stock_list');
    this.list = list;
    const cnt = { all: list.length, need: list.filter(x => x.state === 'need_order').length, on: list.filter(x => x.state === 'on_order').length, ok: list.filter(x => x.state === 'normal').length };
    el.innerHTML = `<div class="page">
      <div class="toolbar">
        <div class="seg" id="sf">${[['all', 'ทั้งหมด'], ['need', 'ต้องสั่ง'], ['on', 'สั่งแล้ว'], ['ok', 'ปกติ']].map(([k, t]) => `<button data-f="${k}" class="${this.filter === k ? 'on' : ''}">${t}<span class="n">${cnt[k]}</span></button>`).join('')}</div>
        <span class="grow"></span>
        <label class="search">${ic('search', 'sm')}<input class="input" id="sq" placeholder="ค้นหา Material…" value="${esc(this.q)}"></label>
      </div>
      <div class="rhead g-stock" id="shead"><span>Material</span><span>คงเหลือ<span class="en">Balance</span></span><span class="r">จุดสั่งซื้อ<span class="en">Reorder</span></span><span class="r">สั่งค้างรับ<span class="en">On order</span></span><span class="r">ใช้/วัน<span class="en">60-day avg</span></span><span class="r">พอใช้<span class="en">Cover</span></span><span class="c-spark">30 วัน<span class="en">Trend</span></span><span>สถานะ<span class="en">Status</span></span><span></span></div>
      <div class="rows" id="srows"></div></div>`;
    const draw = () => {
      const q = this.q.toLowerCase();
      const rows = list.filter(x => (this.filter === 'all' || (this.filter === 'need' && x.state === 'need_order') || (this.filter === 'on' && x.state === 'on_order') || (this.filter === 'ok' && x.state === 'normal'))
        && (!q || (x.name + ' ' + x.name_en + ' ' + x.code).toLowerCase().includes(q)));
      const card = this.view === 'card';
      $('#shead').classList.toggle('hidden', card);
      $('#srows').className = card ? 'pgrid' : 'rows';
      if (card && rows.length) {
        $('#srows').innerHTML = rows.map(x => {
          const cls = x.state === 'need_order' ? 'need' : x.state === 'on_order' ? (x.order_status === 'overdue' ? 'need' : x.order_status === 'waiting_date' ? 'ordered' : 'sched') : 'ok';
          const cover = x.days_cover === null ? '' : x.days_cover > 365 ? 'พอใช้ > 1 ปี' : `พอใช้ ~${Math.floor(x.days_cover)} วัน`;
          return `<article class="pcard" style="--c:${C[cls]}">
            <div class="pc-pic">${mpic(x, 132)}<span class="pc-st">${matBadge(x)}</span></div>
            <div class="pc-body">
              <div class="pc-name" title="${esc(x.name)}">${esc(x.name)}</div>
              <div class="pc-code">${esc(x.code)} · ${esc(x.unit)}${x.name_en && x.name_en !== x.name ? ' · ' + esc(x.name_en) : ''}</div>
              <div class="pc-bal"><span class="num" style="${x.below_reorder ? 'color:var(--leak)' : ''}">${fmtN(x.balance)}</span><small>${esc(x.unit)}</small><span class="grow"></span><span class="pc-cover">${cover}</span></div>
              ${levelBar(x.balance, x.reorder_point, x.below_reorder ? 'need' : 'ok')}
              <div class="pc-meta"><span>จุดสั่ง <b class="num">${fmtN(x.reorder_point)}</b></span><span>สั่งครั้งละ <b class="num">${fmtN(x.order_qty)}</b>${x.moq ? ` · MOQ ${fmtN(x.moq)}` : ''}</span>${qeBtn(x.id)}</div>
              ${x.open_order_qty ? `<div class="pc-on">${ic('truck', 'sm')}ค้างรับ <b class="num">${fmtN(x.open_order_qty)}</b> ${esc(x.unit)}<span class="grow"></span><button class="link" data-goord="${esc(x.name)}">ใบสั่ง ${ic('chevR', 'sm')}</button></div>`
              : App.officer && x.state === 'need_order' ? `<button class="btn btn-primary sm pc-act" data-order="${x.id}">${ic('plus', 'sm')}สร้างใบสั่งซื้อ</button>` : ''}
            </div></article>`;
        }).join('');
        return;
      }
      $('#srows').innerHTML = rows.length ? rows.map(x => {
        const cls = x.state === 'need_order' ? 'need' : x.state === 'on_order' ? (x.order_status === 'overdue' ? 'need' : x.order_status === 'waiting_date' ? 'ordered' : 'sched') : 'ok';
        const cover = x.days_cover === null ? '—' : x.days_cover > 365 ? '> 1 ปี' : `${Math.floor(x.days_cover)} วัน`;
        return `<div class="rrow g-stock tr-open" data-mid="${x.id}" style="--c:${C[cls]}" title="คลิกเพื่อดูกราฟแนวโน้มสต็อก">
          ${matName(x)}
          <div class="levelcell"><span class="v num" style="${x.below_reorder ? 'color:var(--leak)' : ''}">${fmtN(x.balance)}<span class="u">${esc(x.unit)}</span></span>${levelBar(x.balance, x.reorder_point, x.below_reorder ? 'need' : 'ok')}</div>
          <span class="r num muted" style="display:flex;align-items:center;justify-content:flex-end;gap:2px">${ovrTag(x)}${fmtN(x.reorder_point)}${qeBtn(x.id)}</span>
          <span class="r num" style="font-weight:700">${x.open_order_qty ? fmtN(x.open_order_qty) : '<span class="faint">—</span>'}</span>
          <span class="r num muted">${x.usage_per_day ? fmtN(Math.round(x.usage_per_day * 100) / 100) : '—'}</span>
          <span class="r num" style="font-weight:700;${x.days_cover !== null && x.days_cover < 14 ? 'color:var(--abn)' : ''}">${cover}</span>
          <span class="c-spark">${sparkSvg(x.spark, x.reorder_point, C[x.below_reorder ? 'need' : 'ok'])}</span>
          <span>${matBadge(x)}</span>
          <span class="r">${App.officer && x.state === 'need_order' ? `<button class="btn btn-tonal sm" data-order="${x.id}">${ic('plus', 'sm')}สั่ง</button>` : x.state === 'on_order' ? `<button class="btn btn-ghost sm" data-goord="${esc(x.name)}">ใบสั่ง ${ic('chevR', 'sm')}</button>` : ''}</span>
        </div>`;
      }).join('') : `<div class="card">${emptyState('search', 'ไม่พบรายการ', 'No materials match', 'ลองเปลี่ยนคำค้นหรือตัวกรอง')}</div>`;
    };
    draw();
    el.querySelector('#sf').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; this.filter = b.dataset.f; $$('#sf button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
    el.querySelector('#sq').oninput = e => { this.q = e.target.value; draw(); };
    el.onclick = e => {
      const o = e.target.closest('[data-order]'); if (o) return OrderUI.form({ material_id: +o.dataset.order });
      const g = e.target.closest('[data-goord]'); if (g) { PAGES.orders.q = g.dataset.goord; PAGES.orders.filter = 'open'; App.go('orders'); return; }
      if (e.target.closest('button,a,input,.qe')) return;
      const r = e.target.closest('[data-mid]'); if (r) StockTrend.open(+r.dataset.mid);   // row → stock trend chart
    };
  },
};

/* =============================== QUICK EDIT: order quantities (Officer) =============================== */
function qeBtn(id) { return App.officer ? `<button class="qe" data-qe="${id}" title="แก้จำนวนที่ต้องสั่ง / จำนวนสั่งซื้อ">${ic('edit', 'sm')}</button>` : ''; }
/** "ชั่วคราว" tag when a month-only override is in effect */
function ovrTag(x) {
  const o = x && (x.override || x.override_now); if (!o) return '';
  const mo = o.month ? fmtMonth(o.month) : '';
  return `<span class="tmp-tag" title="ค่าชั่วคราว ${esc(mo)} · เหตุผล: ${esc(o.reason || '-')}${o.master_reorder_point !== undefined ? ` · ค่าถาวร: จุดสั่ง ${fmtN(o.master_reorder_point)} / สั่งครั้งละ ${fmtN(o.master_order_qty)}` : ''}">ชั่วคราว</span>`;
}
const MatQuick = {
  /** Officer edits จำนวนคงเหลือที่ต้องสั่ง / จำนวนที่สั่งซื้อ — permanent (Master) or temporary (one month, with reason).
      opts: {oq, context:'order'} → resolves true when saved */
  async edit(id, opts = {}) {
    if (!App.officer) return false;
    const m = (await api('materials_list')).find(x => x.id === id);
    if (!m) return false;
    const cur = m.override_now, thisM = App.today.slice(0, 7);
    const months = [0, 1, 2].map(i => { const d = pd(thisM + '-01'); d.setMonth(d.getMonth() + i); return iso(d).slice(0, 7); });
    let mode = opts.context === 'order' ? 'temporary' : 'permanent';
    const rp0 = cur ? cur.reorder_point : m.reorder_point, oq0 = opts.oq ?? (cur ? cur.order_qty : m.order_qty);
    const f = (k, th, en, v, hint = '') => `<div class="field"><label>${th} <span class="en">${en}</span></label><div class="input-wrap"><input class="input num" id="q_${k}" inputmode="decimal" value="${v ?? ''}"><span class="unit">${esc(m.unit)}</span></div>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
    let saved = false;
    const pr = modal({
      title: opts.context === 'order' ? 'แก้ไขจุดสั่งซื้อ' : 'แก้จำนวนที่ต้องสั่ง', en: m.name, icon: 'edit', color: 'var(--primary)',
      body: `<div style="display:grid;gap:14px;min-width:min(520px,80vw)">
        ${cur ? `<div class="tmp-banner">${ic('clock', 'sm')}<div><b>เดือนนี้ใช้ค่าชั่วคราว</b> จุดสั่ง ${fmtN(cur.reorder_point)} · สั่งครั้งละ ${fmtN(cur.order_qty)} ${esc(m.unit)}<br><span class="muted">เหตุผล: ${esc(cur.reason || '-')} · ${esc(cur.created_by || '')}</span></div><button class="btn btn-ghost sm" data-clr>ยกเลิกค่าชั่วคราว</button></div>` : ''}
        <div class="field"><label>รูปแบบการเปลี่ยนแปลง <span class="en">Change type</span></label>
          <div class="mode-pick" id="q_mode">
            <button data-mode="permanent">${ic('db', 'sm')}<span>${bi('ถาวร', 'Permanent · แก้ใน Material Master')}</span></button>
            <button data-mode="temporary">${ic('clock', 'sm')}<span>${bi('ชั่วคราว', 'Temporary · เฉพาะเดือน')}</span></button></div></div>
        <div class="frow">${f('rp', 'จำนวนคงเหลือที่ต้องสั่ง', 'Reorder point', rp0, 'คงเหลือเท่านี้ → ขึ้นสถานะ ต้องสั่ง')}
        ${f('oq', 'จำนวนที่สั่งซื้อ (ส่งครั้งละ)', 'Order qty', oq0)}</div>
        <div id="q_perm">${f('moq', 'MOQ', 'Minimum order', m.moq, 'เว้นว่างถ้าไม่มี')}</div>
        <div id="q_temp" class="frow">
          <div class="field" style="max-width:200px"><label>ใช้กับเดือน <span class="en">Month</span></label><select class="input" id="q_month">${months.map(x => `<option value="${x}">${fmtMonth(x)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label id="q_rlab">เหตุผล <span class="en">Reason</span></label><input class="input" id="q_reason" maxlength="200" placeholder="เช่น งบเดือนนี้จำกัด, Supplier ส่งได้แค่ 5 Drum"></div>
        <div class="hint" id="q_hint"></div>
        <div class="err-text"></div></div>`,
      ok: 'บันทึก', okEn: 'Save',
      onOk: async el => {
        const v = k => el.querySelector('#q_' + k).value;
        if (mode === 'temporary' && !v('reason').trim()) { el.querySelector('#q_reason').classList.add('err'); throw new Error('กรุณาระบุเหตุผลของการเปลี่ยนแปลงชั่วคราว'); }
        await api('material_set_qty', id, v('rp'), v('oq'), mode === 'permanent' ? v('moq') : m.moq, mode, v('month'), v('reason'));
        const applies = mode === 'permanent' || v('month') === thisM;
        const u = { id, reorder_point: parseNum(v('rp')), order_qty: parseNum(v('oq')) };
        if (mode === 'permanent') u.moq = parseNum(v('moq'));
        if (applies) document.dispatchEvent(new CustomEvent('material-updated', { detail: u }));
        toast(mode === 'permanent' ? 'แก้จำนวนแล้ว (ถาวร)' : `ตั้งค่าชั่วคราว ${fmtMonth(v('month'))}`, `${esc(m.name)} · จุดสั่ง ${fmtN(u.reorder_point)} · สั่งครั้งละ ${fmtN(u.order_qty)} ${esc(m.unit)}`);
        saved = true;
        await App.bumpRev(); if (opts.context !== 'order') App.refresh();
      },
    });
    const el = $$('.modal').pop();
    const sync = () => {
      $$('#q_mode [data-mode]', el).forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
      el.querySelector('#q_perm').classList.toggle('hidden', mode !== 'permanent');
      el.querySelector('#q_temp').classList.toggle('hidden', mode !== 'temporary');
      el.querySelector('#q_rlab').innerHTML = mode === 'temporary' ? 'เหตุผล <span class="req">*</span> <span class="en">Reason (required)</span>' : 'เหตุผล <span class="en">Reason (optional)</span>';
      el.querySelector('#q_hint').innerHTML = mode === 'temporary'
        ? `${ic('info', 'sm')} ใช้เฉพาะเดือนที่เลือก — เดือนถัดไปกลับเป็นค่าถาวร (จุดสั่ง ${fmtN(m.reorder_point)} · สั่งครั้งละ ${fmtN(m.order_qty)} ${esc(m.unit)}) · ฟอร์ม A3 ของเดือนนั้นพิมพ์ตามค่านี้`
        : `${ic('info', 'sm')} แก้ใน Material Master — มีผลทุกเดือนตั้งแต่ตอนนี้`;
    };
    el.querySelector('#q_mode').onclick = e => { const b = e.target.closest('[data-mode]'); if (b) { mode = b.dataset.mode; sync(); } };
    el.querySelector('[data-clr]')?.addEventListener('click', async () => {
      try { await api('material_override_clear', id, thisM); toast('ยกเลิกค่าชั่วคราวแล้ว', `${esc(m.name)} กลับเป็นจุดสั่ง ${fmtN(m.reorder_point)} · สั่งครั้งละ ${fmtN(m.order_qty)}`);
        document.dispatchEvent(new CustomEvent('material-updated', { detail: { id, reorder_point: m.reorder_point, order_qty: m.order_qty } }));
        el.querySelector('[data-c]')?.click(); await App.bumpRev(); App.refresh(); } catch (e) { toastErr(e); }
    });
    sync();
    if (opts.context === 'order') setTimeout(() => el.querySelector('#q_reason').focus(), 80);
    await pr;
    return saved;
  },
};
document.addEventListener('click', e => {
  const q = e.target.closest('[data-qe]'); if (!q) return;
  e.preventDefault(); e.stopPropagation(); MatQuick.edit(+q.dataset.qe);
}, true);

/* =============================== ANNOUNCEMENTS =============================== */
const NOTE_LV = { info: ['ทั่วไป', 'General', 'info'], warn: ['สำคัญ', 'Important', 'alert'], urgent: ['ด่วน', 'Urgent', 'megaphone'] };
const NOTE_BG = { auto: ['ตามระดับ', ''], yellow: ['เหลือง', '#FFE9A8'], orange: ['ส้ม', '#FFD3A8'], red: ['แดง', '#FFC9C9'], green: ['เขียว', '#CDEFD3'], blue: ['ฟ้า', '#CFE3FF'], purple: ['ม่วง', '#E2D6FF'], dark: ['เข้ม', '#2B3445'] };
const NOTE_SIZE = { m: ['ปกติ', 'Aa'], l: ['ใหญ่', 'Aa'], xl: ['ใหญ่มาก', 'Aa'] };
const NOTE_MODE = { banner: ['แบนเนอร์', 'การ์ดบนหน้าแรก', 'list'], popup: ['เด้ง Pop-up', 'เด้งขึ้นกลางจอ 1 ครั้ง/เครื่อง', 'bell'], marquee: ['ตัวหนังสือไหล', 'แถบวิ่งบนสุดของหน้าแรก', 'arrowR'] };
const NOTE_EMOJI = ['', '📢', '⚠️', '🔥', '✅', '📦', '🛢️', '🧹', '🦺', '📅', '🎉', '❗'];

const NoteUI = {
  ackId() { return +(localStorageGet('noteAck') || 0); },
  st(n) { let o = {}; try { o = JSON.parse(n.style || '{}') || {}; } catch (e) { } return { size: o.size || 'm', bg: o.bg || 'auto', mode: o.mode || 'banner', emoji: o.emoji || '' }; },
  ver(n) { return `${n.id}:${n.updated_at || ''}`; },
  hidden() { try { return JSON.parse(localStorageGet('noteHidden') || '[]'); } catch (e) { return []; } },
  visible(notes) { const h = this.hidden(); return (notes || []).filter(n => !h.includes(this.ver(n))); },
  /** days left before the announcement stops showing (null = no end date) */
  left(n) { return n.expires_on ? dayDiff(n.expires_on, App.today) : null; },
  leftChip(n) {
    const d = this.left(n); if (d === null) return '';
    return `<span class="nb-exp ${d <= 2 ? 'soon' : ''}">${ic('clock', 'sm')}${d <= 0 ? 'หมดอายุวันนี้' : `หมดอายุในอีก ${d} วัน`} · ${fmtD(n.expires_on)}</span>`;
  },
  html(notes, { manage = false } = {}) {
    const ack = this.ackId();
    return notes.map(n => {
      const lv = NOTE_LV[n.level] || NOTE_LV.info, S = this.st(n);
      return `<div class="nb-item ${n.level} ns-${S.size} nbg-${S.bg}">${S.emoji ? `<span class="nb-emo">${esc(S.emoji)}</span>` : (sticker(lv[2], S.size === 'm' ? 40 : 52) || '')}
        <div class="nb-body"><div class="nb-head">${n.title ? `<span class="nb-title">${esc(n.title)}</span>` : ''}<span class="nb-lvl">${lv[0]}</span>${n.pinned ? '<span class="nb-lvl" style="--c:var(--gold)">ปักหมุด</span>' : ''}${S.mode !== 'banner' ? `<span class="nb-mode">${NOTE_MODE[S.mode][0]}</span>` : ''}${n.id > ack ? '<span class="nb-new">ใหม่</span>' : ''}</div>
          <div class="nb-text">${esc(n.body)}</div>
          <div class="nb-meta">${esc(n.created_by || 'Officer')} · ${fmtD(n.created_at)} ${fmtTime(n.created_at)}${this.leftChip(n)}</div></div>
        <div class="nb-acts">${manage && App.officer ? `<button class="icon-btn sm" data-note-edit="${n.id}" title="แก้ไข / ปรับแต่ง">${ic('edit', 'sm')}</button><button class="icon-btn sm" data-note-del="${n.id}" title="ลบประกาศ (ทุกเครื่อง)">${ic('ban', 'sm')}</button>` : ''}
          <button class="icon-btn sm nb-x" data-note-hide="${n.id}" title="ปิดประกาศนี้ (เฉพาะเครื่องนี้)">${ic('x', 'sm')}</button></div>
      </div>`;
    }).join('');
  },
  /** running text strip for announcements in "ตัวหนังสือไหล" mode */
  marquee(notes) {
    if (!notes.length) return '';
    const items = notes.map(n => { const S = this.st(n); return `<span class="mq-i nbg-${S.bg}">${S.emoji ? esc(S.emoji) + ' ' : ''}${n.title ? `<b>${esc(n.title)}</b> · ` : ''}${esc(n.body.replace(/\s+/g, ' '))}</span>`; }).join('<i class="mq-dot">•</i>');
    const S0 = this.st(notes[0]), dur = Math.max(18, Math.min(80, notes.reduce((t, n) => t + n.body.length, 0) / 6));
    return `<div class="nb-marquee ns-${S0.size} nbg-${S0.bg} lv-${notes[0].level}" style="--dur:${dur}s">${sticker('megaphone', 26)}
      <div class="mq-win"><div class="mq-track"><span>${items}</span><span aria-hidden="true">${items}</span></div></div>
      <button class="icon-btn sm nb-x" data-note-hide="${notes.map(n => n.id).join(',')}" title="ปิดแถบประกาศ (เฉพาะเครื่องนี้)">${ic('x', 'sm')}</button></div>`;
  },
  hide(ids, notes) {
    const h = this.hidden();
    ids.forEach(id => { const n = notes.find(x => x.id === id); if (n) h.push(this.ver(n)); });
    localStorageSet('noteHidden', JSON.stringify(h.slice(-200)));
  },
  /** Pop-up mode: shown in the middle of the screen once per computer (again after the Officer edits it) */
  async popups(notes) {
    if (this._busy) return;
    let seen = []; try { seen = JSON.parse(localStorageGet('notePop') || '[]'); } catch (e) { }
    const todo = this.visible(notes).filter(n => this.st(n).mode === 'popup' && !seen.includes(this.ver(n)));
    if (!todo.length) return;
    this._busy = true;
    for (const n of todo) {
      const S = this.st(n), lv = NOTE_LV[n.level] || NOTE_LV.info;
      seen.push(this.ver(n)); localStorageSet('notePop', JSON.stringify(seen.slice(-200)));
      await modal({
        title: n.title || 'ประกาศจาก Officer', en: `ANNOUNCEMENT · ${lv[1].toUpperCase()}`, icon: 'bell', color: n.level === 'urgent' ? 'var(--leak)' : 'var(--abn)', cancel: 'ปิด', ok: 'รับทราบ', okEn: 'Got it',
        body: `<div class="np-box ns-${S.size} nbg-${S.bg} ${n.level}">${S.emoji ? `<span class="nb-emo">${esc(S.emoji)}</span>` : sticker(lv[2], 56)}<div class="nb-text">${esc(n.body)}</div></div>
          <div class="nb-meta" style="margin-top:10px">${esc(n.created_by || 'Officer')} · ${fmtD(n.created_at)}${this.leftChip(n)}</div>`,
      });
    }
    this._busy = false;
  },
  bind(root, notes, after) {
    root.addEventListener('click', async e => {
      if (e.target.closest('[data-note-new]')) return this.form({});
      const ed = e.target.closest('[data-note-edit]'); if (ed) return this.form(notes.find(n => n.id === +ed.dataset.noteEdit));
      const hd = e.target.closest('[data-note-hide]');
      if (hd) {
        const ids = hd.dataset.noteHide.split(',').map(Number);
        const box = hd.closest('.nb-item,.nb-marquee'); box?.classList.add('out');
        this.hide(ids, notes);
        toast('ปิดประกาศแล้ว', App.officer ? 'ซ่อนเฉพาะเครื่องนี้ — ลบให้ทุกเครื่องใช้ปุ่ม ⊘' : 'ซ่อนเฉพาะเครื่องนี้', 'info');
        setTimeout(() => after && after(), 260); return;
      }
      if (e.target.closest('[data-note-unhide]')) { localStorageSet('noteHidden', '[]'); return after && after(); }
      const dl = e.target.closest('[data-note-del]');
      if (dl) { if (await modal({ title: 'ลบประกาศนี้?', en: 'Remove announcement', body: '<p class="muted">ประกาศจะหายจากหน้าแรกของทุกเครื่อง</p>', ok: 'ลบ', okEn: 'Remove', danger: true })) { try { await api('note_delete', +dl.dataset.noteDel); toast('ลบประกาศแล้ว'); await App.bumpRev(); App.refresh(); } catch (er) { toastErr(er); } } return; }
      if (e.target.closest('[data-note-ack]')) { localStorageSet('noteAck', String(Math.max(0, ...notes.map(n => n.id)))); after && after(); }
    });
  },
  form(n) {
    const edit = !!n.id; let level = n.level || 'info';
    const S = this.st(n);
    const pv = () => {   // live preview
      const fake = { id: 0, title: p.querySelector('#n_t').value, body: p.querySelector('#n_b').value || 'ตัวอย่างข้อความประกาศ', level, expires_on: p.querySelector('#n_e').value || null, created_by: App.info?.officer_name, created_at: App.today, style: JSON.stringify(S) };
      p.querySelector('#n_pv').innerHTML = S.mode === 'marquee' ? this.marquee([fake]) : `<div class="nb-grid one">${this.html([fake])}</div>`;
      const d = fake.expires_on ? dayDiff(fake.expires_on, App.today) : null;
      p.querySelector('#n_left').innerHTML = d === null ? 'ไม่กำหนด — แสดงจนกว่าจะลบ' : `แสดงอีก <b>${d + 1}</b> วัน (ถึง ${fmtD(fake.expires_on)})${d <= 2 ? ' · <b style="color:var(--leak)">ใกล้หมดอายุ</b>' : ''}`;
    };
    let p;
    const seg = (id, obj, cur, f) => `<div class="choices n-seg" id="${id}">${Object.entries(obj).map(([k, v]) => `<button class="choice" data-v="${k}" aria-pressed="${cur === k}">${f(k, v)}</button>`).join('')}</div>`;
    openPanel({
      title: edit ? 'แก้ไขประกาศ' : 'เขียนประกาศ', en: edit ? 'Edit announcement' : 'New announcement · shows on every Home screen', icon: 'alert', color: 'var(--abn)', wide: true,
      body: `<div class="n-form"><div>
        <div class="field"><label>หัวข้อ <span class="en">Title (optional)</span></label><input class="input" id="n_t" maxlength="80" value="${esc(n.title || '')}" placeholder="เช่น ตรวจนับสต็อกสิ้นเดือน"></div>
        <div class="field"><label>ข้อความ <span class="en">Message</span></label><textarea class="input" id="n_b" rows="4" maxlength="1000" placeholder="พิมพ์ข้อความที่ต้องการแจ้ง Operator / ทุกคน">${esc(n.body || '')}</textarea></div>
        <div class="field"><label>ระดับ <span class="en">Level</span></label><div class="choices" id="n_l">${Object.entries(NOTE_LV).map(([k, v]) => `<button class="choice" data-l="${k}" aria-pressed="${level === k}">${sticker(v[2], 22)}${v[0]}<span class="en">${v[1]}</span></button>`).join('')}</div></div>
        <div class="field"><label>แสดงแบบ <span class="en">Display</span></label>${seg('n_m', NOTE_MODE, S.mode, (k, v) => `${ic(v[2], 'sm')}<span>${v[0]}<small>${v[1]}</small></span>`)}</div>
        <div class="frow"><div class="field"><label>ขนาดตัวหนังสือ <span class="en">Text size</span></label>${seg('n_z', NOTE_SIZE, S.size, (k, v) => `<span class="sz-${k}">${v[1]}</span>${v[0]}`)}</div>
          <div class="field"><label>อีโมจิ <span class="en">Emoji</span></label><div class="n-emo" id="n_j">${NOTE_EMOJI.map(e => `<button data-e="${e}" class="${S.emoji === e ? 'on' : ''}" title="${e ? '' : 'ไม่ใช้ (ใช้สติกเกอร์ตามระดับ)'}">${e || ic('x', 'sm')}</button>`).join('')}</div></div></div>
        <div class="field"><label>พื้นหลัง <span class="en">Background</span></label><div class="n-bg" id="n_g">${Object.entries(NOTE_BG).map(([k, v]) => `<button data-g="${k}" class="${S.bg === k ? 'on' : ''}" title="${v[0]}"><i style="background:${v[1] || 'linear-gradient(135deg,#FFE9A8 50%,#FFC9C9 50%)'}"></i>${v[0]}</button>`).join('')}</div></div>
        <div class="field"><label>แสดงถึงวันที่ <span class="en">Show until</span></label>
          <div class="n-until"><input class="input" type="date" id="n_e" value="${esc(n.expires_on || '')}" min="${App.today}">${[[1, 'พรุ่งนี้'], [3, '3 วัน'], [7, '7 วัน'], [30, '30 วัน']].map(([d, t]) => `<button class="chip-btn" data-d="${d}">${t}</button>`).join('')}<button class="chip-btn" data-d="0">ไม่กำหนด</button></div>
          <div class="hint" id="n_left" style="margin-top:6px"></div></div>
        <label style="display:flex;gap:12px;align-items:center;font-weight:600"><span class="switch"><input type="checkbox" id="n_p" ${n.pinned ? 'checked' : ''}><span></span></span>ปักหมุดไว้บนสุด</label>
        <div class="err-text" id="n_err"></div></div>
        <div class="n-prev"><div class="flabel">ตัวอย่าง <span class="en">PREVIEW</span></div><div id="n_pv"></div>
          <p class="hint">ทุกคนกด × เพื่อปิดประกาศบนเครื่องตัวเองได้ · ประกาศจะหายเองเมื่อเลยวันที่กำหนด</p></div></div>`,
      foot: `<button class="btn btn-plain" data-x2>ยกเลิก</button><button class="btn btn-primary lg" id="n_s">${ic('check')}${bi(edit ? 'บันทึก' : 'ประกาศ', edit ? 'Save' : 'Post')}</button>`,
      onMount: (panel, close) => {
        p = panel;
        p.querySelector('[data-x2]').onclick = close;
        p.querySelector('#n_l').onclick = e => { const b = e.target.closest('[data-l]'); if (!b) return; level = b.dataset.l; $$('#n_l .choice', p).forEach(x => x.setAttribute('aria-pressed', x === b)); pv(); };
        const pick = (id, key) => p.querySelector(id).onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; S[key] = b.dataset.v; $$(`${id} .choice`, p).forEach(x => x.setAttribute('aria-pressed', x === b)); pv(); };
        pick('#n_m', 'mode'); pick('#n_z', 'size');
        p.querySelector('#n_j').onclick = e => { const b = e.target.closest('[data-e]'); if (!b) return; S.emoji = b.dataset.e; $$('#n_j button', p).forEach(x => x.classList.toggle('on', x === b)); pv(); };
        p.querySelector('#n_g').onclick = e => { const b = e.target.closest('[data-g]'); if (!b) return; S.bg = b.dataset.g; $$('#n_g button', p).forEach(x => x.classList.toggle('on', x === b)); pv(); };
        p.querySelector('.n-until').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; p.querySelector('#n_e').value = +b.dataset.d ? addDays(App.today, +b.dataset.d) : ''; pv(); });
        ['#n_t', '#n_b', '#n_e'].forEach(id => p.querySelector(id).addEventListener('input', pv));
        pv();
        setTimeout(() => p.querySelector(edit ? '#n_b' : '#n_t').focus(), 60);
        p.querySelector('#n_s').onclick = async () => {
          try {
            const r = await api('note_save', { id: n.id, title: p.querySelector('#n_t').value, body: p.querySelector('#n_b').value, level, pinned: p.querySelector('#n_p').checked, expires_on: p.querySelector('#n_e').value, style: S });
            if (!edit) localStorageSet('noteToast', String(r.id));
            close(); toast(edit ? 'แก้ไขประกาศแล้ว' : 'ประกาศแล้ว', 'แสดงที่หน้าแรกของทุกเครื่อง'); await App.bumpRev(); App.refresh();
          } catch (e) { p.querySelector('#n_err').textContent = e.message; }
        };
      },
    });
  },
};

/* =============================== ORDERS =============================== */
const OrderUI = {
  async form(pre = {}) {
    if (!App.officer) return toast('เฉพาะ Officer', 'เปลี่ยนโหมดได้ที่หน้า ตั้งค่า', 'warn');
    const stock = await api('stock_list');
    let m = stock.find(x => x.id === pre.material_id) || null;
    const edit = !!pre.id;
    const reasons = Object.entries(REASON);
    const body = `
      <div class="field"><label>Material <span class="en">from Material Master</span></label>
        <div class="combo"><label class="search" style="flex:none;display:block">${ic('search', 'sm')}<input class="input" id="oc" placeholder="พิมพ์ชื่อหรือรหัส Material…" value="${m ? esc(m.name) : ''}" ${edit ? 'disabled' : ''} autocomplete="off"></label><div class="list hidden" id="ocl"></div></div></div>
      <div id="oinfo"></div>
      <div class="frow">
        <div class="field"><label>จำนวนที่สั่ง <span class="en">Ordered Qty</span></label><div class="input-wrap"><input class="input num" id="oq" inputmode="decimal" value="${pre.ordered_qty ?? (m ? m.order_qty : '')}"><span class="unit" id="ou">${m ? esc(m.unit) : ''}</span></div></div>
        <div class="field"><label>วันที่สั่ง <span class="en">Order date</span></label><input class="input" type="date" id="od" value="${pre.order_date || App.today}" max="${App.today}"></div>
      </div>
      <div id="ocmp"></div>
      <div class="field"><label>เหตุผลการสั่ง <span class="en">Order reason</span></label><div class="choices" id="or">${reasons.map(([k, [t, en]]) => `<button class="choice" data-r="${k}" aria-pressed="${(pre.reason || 'normal') === k}">${esc(t)}<span class="en">${esc(en)}</span></button>`).join('')}</div></div>
      <div class="field"><label>กำหนดส่ง <span class="en">Delivery date</span></label>
        <div style="display:flex;gap:12px;align-items:center"><input class="input" type="date" id="oe" value="${pre.expected_date || ''}" style="max-width:240px"><label style="display:flex;gap:10px;align-items:center;font-size:14px;font-weight:600;color:var(--fg-2)"><span class="switch"><input type="checkbox" id="onod" ${pre.id && !pre.expected_date ? 'checked' : (!pre.id ? 'checked' : '')}><span></span></span>ยังไม่ทราบ — รอกำหนดส่ง</label></div></div>
      <div class="field"><label>หมายเหตุ <span class="en">Remark</span></label><input class="input" id="orm" value="${esc(pre.remark || '')}" placeholder="เช่น เลขที่ PR / PO"></div>
      <div class="err-text" id="oerr"></div>`;
    openPanel({
      title: edit ? `แก้ไขใบสั่งซื้อ ${pre.id}` : 'สร้างใบสั่งซื้อ', en: edit ? 'Edit order' : 'New order', icon: 'order', color: 'var(--st-ordered)', body,
      foot: `<button class="btn btn-plain" data-x2>ยกเลิก</button><button class="btn btn-primary lg" id="osave">${ic('check')}${bi(edit ? 'บันทึก' : 'สร้างใบสั่งซื้อ', edit ? 'Save' : 'Create order')}</button>`,
      onMount: (p, close) => {
        let reason = pre.reason || 'normal';
        const nod = p.querySelector('#onod'), oe = p.querySelector('#oe');
        const syncNod = () => { oe.disabled = nod.checked; if (nod.checked) oe.value = ''; };
        nod.onchange = syncNod; oe.oninput = () => { if (oe.value) nod.checked = false; }; syncNod();
        if (pre.expected_date) { nod.checked = false; oe.disabled = false; oe.value = pre.expected_date; }
        const info = () => {
          if (!m) { p.querySelector('#oinfo').innerHTML = ''; p.querySelector('#ocmp').innerHTML = ''; return; }
          p.querySelector('#ou').textContent = m.unit;
          p.querySelector('#oinfo').innerHTML = `<div class="infobox">
            <div><div class="k">คงเหลือตอนนี้<span class="en">Current</span></div><div class="v num" style="${m.below_reorder ? 'color:var(--leak)' : ''}">${fmtN(m.balance)}<span class="u">${esc(m.unit)}</span></div></div>
            <div><div class="k" style="display:flex;justify-content:space-between">จุดสั่งซื้อ (Required)${qeBtn(m.id)}</div><div class="v num">${fmtN(m.reorder_point)}<span class="u">${esc(m.unit)}</span>${ovrTag(m)}</div></div>
            <div><div class="k">ส่งครั้งละ${m.moq ? ' · MOQ' : ''}<span class="en">Std qty${m.moq ? ' · MOQ' : ''}</span></div><div class="v num">${fmtN(m.order_qty)}${m.moq ? `<span class="u">MOQ ${fmtN(m.moq)}</span>` : `<span class="u">${esc(m.unit)}</span>`}</div></div></div>
            ${m.open_order_qty ? `<div class="compare less">${ic('alert', 'sm')}มีใบสั่งที่ยังรับไม่ครบอยู่แล้ว ${fmtN(m.open_order_qty)} ${esc(m.unit)}</div>` : ''}`;
          cmp();
        };
        const cmp = () => {
          if (!m) return;
          const q = parseNum(p.querySelector('#oq').value), s = m.order_qty;
          let h = '';
          if (q && s) {
            if (q > s) h = `<div class="compare more">${ic('up', 'sm')}สั่งมากกว่าจำนวนมาตรฐาน +${fmtN(q - s)} ${esc(m.unit)} — ระบุเหตุผลด้านล่าง</div>`;
            else if (q < s) h = `<div class="compare less">${ic('down', 'sm')}สั่งน้อยกว่าจำนวนมาตรฐาน −${fmtN(s - q)} ${esc(m.unit)} — ระบุเหตุผลด้านล่าง</div>`;
            else h = `<div class="compare same">${ic('check', 'sm')}ตรงกับจำนวนมาตรฐาน ${fmtN(s)} ${esc(m.unit)}</div>`;
            if (m.moq && q < m.moq) h += `<div class="compare less" style="margin-top:8px">${ic('alert', 'sm')}ต่ำกว่า MOQ ${fmtN(m.moq)} ${esc(m.unit)}</div>`;
            if (!edit && reason === 'normal' && m.moq && q === m.moq && q !== s) setReason('moq');
          }
          p.querySelector('#ocmp').innerHTML = h;
        };
        const setReason = r => { reason = r; $$('#or .choice', p).forEach(b => b.setAttribute('aria-pressed', b.dataset.r === r)); };
        p.querySelector('#or').onclick = e => { const b = e.target.closest('[data-r]'); if (b) setReason(b.dataset.r); };
        p.querySelector('#oq').oninput = e => { e.target.value = e.target.value.replace(/[^\d.,]/g, ''); cmp(); };
        // combo
        const oc = p.querySelector('#oc'), ocl = p.querySelector('#ocl');
        let act = 0, opts = [];
        const drawList = () => {
          const q = oc.value.toLowerCase().trim();
          opts = stock.filter(x => !q || (x.name + ' ' + x.name_en + ' ' + x.code).toLowerCase().includes(q)).sort((a, b) => (b.state === 'need_order') - (a.state === 'need_order'));
          act = 0;
          ocl.innerHTML = opts.length ? opts.map((x, i) => `<div class="opt ${i === act ? 'act' : ''}" data-i="${i}">${matName(x)}<span class="num muted" style="font-weight:700">${fmtN(x.balance)} ${esc(x.unit)}</span>${matBadge(x)}</div>`).join('') : `<div class="hint" style="padding:12px">ไม่พบ — เพิ่มที่ Material Master</div>`;
          ocl.classList.remove('hidden');
        };
        const pick = x => { m = x; oc.value = x.name; ocl.classList.add('hidden'); if (!edit) p.querySelector('#oq').value = x.order_qty || ''; info(); p.querySelector('#oq').focus(); p.querySelector('#oq').select(); };
        oc.onfocus = drawList; oc.oninput = () => { m = null; info(); drawList(); };
        oc.onkeydown = e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(opts.length - 1, act + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, act - 1); }
          else if (e.key === 'Enter') { e.preventDefault(); if (opts[act]) pick(opts[act]); return; } else return;
          $$('.opt', ocl).forEach((o, i) => o.classList.toggle('act', i === act)); $$('.opt', ocl)[act]?.scrollIntoView({ block: 'nearest' });
        };
        ocl.onmousedown = e => { const o = e.target.closest('.opt'); if (o) { e.preventDefault(); pick(opts[+o.dataset.i]); } };
        oc.onblur = () => setTimeout(() => ocl.classList.add('hidden'), 150);
        info();
        const onMat = ev => { if (!document.body.contains(p)) return document.removeEventListener('material-updated', onMat);
          const u = ev.detail; [stock.find(z => z.id === u.id), m && m.id === u.id ? m : null].forEach(z => z && Object.assign(z, u));
          if (m && m.id === u.id) { if (!edit) p.querySelector('#oq').value = u.order_qty; info(); } };
        document.addEventListener('material-updated', onMat);
        if (!m) setTimeout(() => oc.focus(), 80); else setTimeout(() => { p.querySelector('#oq').focus(); p.querySelector('#oq').select(); }, 80);
        p.querySelector('[data-x2]').onclick = close;
        p.querySelector('#osave').onclick = async () => {
          p.querySelector('#oerr').textContent = '';
          if (!m) return p.querySelector('#oerr').textContent = 'กรุณาเลือก Material';
          const q = parseNum(p.querySelector('#oq').value);
          if (!edit && q && m.order_qty && q !== m.order_qty) {
            const k = await choice({
              title: 'จำนวนไม่ตรงกับจำนวนจุดสั่งซื้อ', en: 'Quantity differs from the order point', icon: 'alert', color: 'var(--abn)',
              body: `<div class="qty-cmp"><div><span>ตั้งไว้ · สั่งครั้งละ</span><b class="num">${fmtN(m.order_qty)}</b><small>${esc(m.unit)}</small></div>${ic('arrowR')}<div class="now"><span>ใบนี้สั่ง</span><b class="num">${fmtN(q)}</b><small>${esc(m.unit)} · ${q > m.order_qty ? '+' : '−'}${fmtN(Math.abs(q - m.order_qty))}</small></div></div>
                <p class="muted" style="margin:14px 0 4px">${esc(m.name)} — ต้องการแก้ไขจุดสั่งซื้อไหม? เลือกได้ว่าจะเปลี่ยน <b>ถาวร</b> หรือ <b>ชั่วคราว</b> (เฉพาะเดือน)</p>`,
              choices: [{ k: 'edit', label: 'แก้ไขจุดสั่งซื้อ', en: 'Edit order point', cls: 'btn-primary', icon: 'edit' },
                { k: 'keep', label: 'สั่งตามนี้ ไม่แก้จุดสั่งซื้อ', en: 'Order anyway', icon: 'check' },
                { k: null, label: 'กลับไปแก้จำนวน', en: 'Back', cls: 'btn-ghost' }],
            });
            if (!k) { p.querySelector('#oq').focus(); return; }
            if (k === 'edit') {
              const ok = await MatQuick.edit(m.id, { oq: q, context: 'order' });
              if (!ok) return;
              m.order_qty = q;
            }
          }
          if (q && m.order_qty && q !== m.order_qty && reason === 'normal') return p.querySelector('#oerr').textContent = 'จำนวนไม่ตรงกับจำนวนมาตรฐาน — กรุณาเลือกเหตุผลการสั่ง (เช่น MOQ, ขนาดบรรจุ, สั่งบางส่วน)';
          try {
            const r = await api('order_save', { id: pre.id, material_id: m.id, ordered_qty: p.querySelector('#oq').value, order_date: p.querySelector('#od').value, expected_date: nod.checked ? null : oe.value || null, reason, remark: p.querySelector('#orm').value });
            close(); toast(edit ? 'บันทึกใบสั่งซื้อแล้ว' : 'สร้างใบสั่งซื้อแล้ว', `${r.id} · ${esc(m.name)} ${p.querySelector('#oq').value} ${esc(m.unit)}`);
            await App.bumpRev(); App.refresh();
          } catch (e) { p.querySelector('#oerr').textContent = e.message; }
        };
      },
    });
  },
  async detail(oid) {
    const all = await api('orders_list');
    const o = all.find(x => x.id === oid); if (!o) return;
    const m = o.material;
    const rc = o.receipts?.length ? o.receipts.map(r => `<div class="drow">${tile('check', 'var(--st-ok)', 'sm')}<div>${bi(fmtD(r.date), fmtDEn(r.date))}</div>${qtyH(r.qty, m.unit)}</div>`).join('') : emptyState('inbox', 'ยังไม่ได้รับสินค้า', 'Nothing received yet', 'บันทึกรับที่หน้า รับสินค้า หรือช่อง รับสินค้า ในหน้า กรอก STOCK');
    const off = App.officer && o.status !== 'received' && o.status !== 'cancelled';
    openPanel({
      title: o.id, en: 'Order detail', icon: 'order', color: C[orderCls(o)],
      body: `<div style="display:flex;align-items:center;gap:14px">${matName(m)}<span style="flex:1"></span>${orderBadge(o)}</div>
        ${o.partial ? partialLine(o) : ''}
        <div class="infobox">
          <div><div class="k">จุดสั่งซื้อ (Required)<span class="en">Reorder point</span></div><div class="v num">${fmtN(o.reorder_point)}<span class="u">${esc(m.unit)}</span></div></div>
          <div><div class="k">จำนวนที่สั่ง<span class="en">Ordered</span></div><div class="v num">${fmtN(o.ordered_qty)}<span class="u">${esc(m.unit)}</span></div></div>
          <div><div class="k">รับแล้ว / คงค้าง<span class="en">Received / Remaining</span></div><div class="v num">${fmtN(o.received_qty)}<span class="u">/ ${fmtN(o.remaining_qty)}</span></div></div></div>
        <div class="kv"><span class="k">วันที่สั่ง</span><span>${fmtD(o.order_date)} · ${esc(o.officer || '')}</span>
          <span class="k">กำหนดส่ง</span><span>${o.expected_date ? fmtD(o.expected_date) : '<span style="color:var(--abn);font-weight:700">ยังไม่กำหนด — รอกำหนดส่ง</span>'}</span>
          <span class="k">เหตุผล</span><span>${esc((REASON[o.reason] || REASON.other)[0])} <span class="faint">${esc((REASON[o.reason] || REASON.other)[1])}</span>${o.suggested_qty && o.suggested_qty !== o.ordered_qty ? ` · มาตรฐาน ${fmtN(o.suggested_qty)} ${esc(m.unit)}` : ''}</span>
          ${o.remark ? `<span class="k">หมายเหตุ</span><span>${esc(o.remark)}</span>` : ''}</div>
        ${off ? `<div class="card solid" style="padding:16px"><div class="flabel" style="margin-bottom:8px">${bi('ตั้ง / เลื่อนกำหนดส่ง', 'Set delivery date')}</div><div style="display:flex;gap:10px"><input class="input" type="date" id="dd" value="${o.expected_date || ''}" min="${o.order_date}" style="max-width:220px"><button class="btn btn-tonal" id="ddsave">${ic('cal', 'sm')}บันทึกกำหนดส่ง</button></div></div>` : ''}
        <div><div class="flabel" style="margin-bottom:8px">${bi('การรับสินค้า', 'Receipts')}</div><div class="dlist">${rc}</div></div>`,
      foot: off ? `<button class="btn btn-danger" data-st="cancelled">${ic('ban', 'sm')}ยกเลิกใบสั่ง</button>${o.received_qty > 0 ? `<button class="btn btn-plain" data-st="closed">${ic('stop', 'sm')}ปิดใบสั่ง (รับไม่ครบ)</button>` : ''}<span style="flex:1"></span><button class="btn btn-plain" data-edit>${ic('edit', 'sm')}แก้ไข</button>`
        : (App.officer && o.state !== 'open' ? `<button class="btn btn-plain" data-st="open">${ic('undo', 'sm')}เปิดใบสั่งอีกครั้ง</button>` : ''),
      onMount: (p, close) => {
        p.querySelector('#ddsave')?.addEventListener('click', async () => { try { await api('order_set_date', o.id, p.querySelector('#dd').value); close(); toast('บันทึกกำหนดส่งแล้ว', `${o.id} · ${fmtD(p.querySelector('#dd').value) || 'ยังไม่กำหนด'}`); await App.bumpRev(); App.refresh(); } catch (e) { toastErr(e); } });
        p.querySelector('[data-edit]')?.addEventListener('click', () => { close(); OrderUI.form(o); });
        p.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => {
          const st = b.dataset.st;
          const lbl = { cancelled: ['ยกเลิกใบสั่งซื้อ?', 'Cancel order'], closed: ['ปิดใบสั่งทั้งที่รับไม่ครบ?', 'Close short'], open: ['เปิดใบสั่งอีกครั้ง?', 'Reopen'] }[st];
          const ok = await modal({ title: lbl[0], en: lbl[1], body: `<p class="muted">${o.id} · ${esc(m.name)}</p><input class="input" id="srm" placeholder="เหตุผล (ไม่บังคับ)"><div class="err-text"></div>`, ok: 'ยืนยัน', okEn: 'Confirm', danger: st === 'cancelled', onOk: async m2 => { await api('order_set_state', o.id, st, m2.querySelector('#srm').value); } });
          if (ok) { close(); toast('อัปเดตใบสั่งซื้อแล้ว', o.id); await App.bumpRev(); App.refresh(); }
        });
      },
    });
  },
};

PAGES.orders = {
  title: ['สั่งซื้อ', 'Orders'], filter: 'open', q: '',
  async render(el, params = {}) {
    if (params.filter) this.filter = { ordered: 'waiting', waiting: 'open', received: 'received' }[params.filter] || this.filter;
    const list = await api('orders_list');
    const T = App.today;
    const F = {
      open: o => !['received', 'cancelled', 'rejected'].includes(o.status), waiting: o => o.status === 'waiting_date', overdue: o => o.status === 'overdue',
      received: o => o.status === 'received', all: () => true,
    };
    const cnt = k => list.filter(F[k]).length;
    el.innerHTML = `<div class="page">
      <div class="toolbar">
        <div class="seg" id="of">${[['open', 'เปิดอยู่'], ['waiting', 'รอกำหนดส่ง'], ['overdue', 'เกินกำหนด'], ['received', 'รับครบแล้ว'], ['all', 'ทั้งหมด']].map(([k, t]) => `<button data-f="${k}" class="${this.filter === k ? 'on' : ''}">${t}<span class="n">${cnt(k)}</span></button>`).join('')}</div>
        <span class="grow"></span>
        <label class="search">${ic('search', 'sm')}<input class="input" id="oqs" placeholder="ค้นหา Material / เลขที่…" value="${esc(this.q)}"></label>
        ${App.officer ? `<button class="btn btn-primary" data-new>${ic('plus', 'sm')}${bi('สร้างใบสั่งซื้อ', 'New order')}</button>` : ''}
      </div>
      <div class="rhead g-order"><span>เลขที่ / วันที่<span class="en">Order</span></span><span>Material</span><span class="r">จำนวนสั่ง<span class="en">Ordered</span></span><span>กำหนดส่ง<span class="en">Delivery</span></span><span>สถานะ<span class="en">Status</span></span><span>รับแล้ว<span class="en">Received</span></span><span class="c-act"></span></div>
      <div class="rows" id="orows"></div></div>`;
    const draw = () => {
      const q = this.q.toLowerCase();
      const rows = list.filter(F[this.filter]).filter(o => !q || (o.id + ' ' + o.material.name + ' ' + o.material.code).toLowerCase().includes(q))
        .sort((a, b) => a.priority - b.priority || (a.expected_date || '9').localeCompare(b.expected_date || '9') || b.order_date.localeCompare(a.order_date));
      $('#orows').innerHTML = rows.length ? rows.map(o => {
        const u = o.material.unit, pct = Math.min(100, 100 * o.received_qty / o.ordered_qty);
        const diff = o.suggested_qty && o.ordered_qty !== o.suggested_qty;
        return `<div class="rrow g-order click" data-oid="${o.id}" style="--c:${C[orderCls(o)]}">
          <div>${bi(o.id, fmtD(o.order_date))}</div>
          ${matName(o.material)}
          <div class="r">${qtyH(o.ordered_qty, u)}${diff ? `<div><span class="chip ${o.reason === 'moq' ? 'info' : 'abn'}" title="จำนวนมาตรฐาน ${fmtN(o.suggested_qty)}">${esc((REASON[o.reason] || REASON.other)[0])}</span></div>` : ''}</div>
          <div>${o.expected_date ? bi(fmtD(o.expected_date), o.status === 'received' ? '' : relDay(o.expected_date, T)[1]) : `<span style="color:var(--abn);font-weight:700">${bi('ยังไม่กำหนด', 'NO DATE')}</span>`}</div>
          <div>${orderBadge(o)}</div>
          <div style="--c:${o.status === 'received' ? 'var(--st-ok)' : 'var(--st-ordered)'}"><div class="num" style="font-weight:700">${fmtN(o.received_qty)} <span class="faint">/ ${fmtN(o.ordered_qty)}</span></div><div class="prog"><i style="width:${pct}%"></i></div></div>
          <div class="r c-act">${App.officer && o.status === 'requested' ? `<div class="c-act2"><button class="btn btn-primary sm" data-oconf="${o.id}">${ic('order', 'sm')}สั่งซื้อ · ใส่วันที่</button><button class="btn btn-ghost sm" data-orej="${o.id}">ไม่อนุมัติ</button></div>` : App.officer && o.status === 'waiting_date' ? `<button class="btn btn-tonal sm" data-oid="${o.id}">${ic('cal', 'sm')}กำหนดส่ง</button>` : `<span class="chev">${ic('chevR', 'sm')}</span>`}</div>
        </div>`;
      }).join('') : `<div class="card">${emptyState('order', this.filter === 'open' ? 'ไม่มีใบสั่งซื้อที่เปิดอยู่' : 'ไม่พบรายการ', 'No orders', App.officer ? 'กด สร้างใบสั่งซื้อ เพื่อเริ่มสั่ง Material ที่ถึงจุดสั่งซื้อ' : '', App.officer ? `<button class="btn btn-tonal" data-new>${ic('plus', 'sm')}สร้างใบสั่งซื้อ</button>` : '', true)}</div>`;
    };
    draw();
    el.querySelector('#of').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; this.filter = b.dataset.f; $$('#of button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
    el.querySelector('#oqs').oninput = e => { this.q = e.target.value; draw(); };
    el.onclick = e => {
      if (e.target.closest('[data-new]')) return OrderUI.form({});
      const rj = e.target.closest('[data-orej]'); if (rj) { e.stopPropagation(); const o = list.find(x => x.id === rj.dataset.orej); return o && OrderConfirm.reject(o).then(ok => ok && App.refresh()); }
      const cf = e.target.closest('[data-oconf]'); if (cf) { e.stopPropagation(); const o = list.find(x => x.id === cf.dataset.oconf); return o && OrderConfirm.open(o).then(ok => ok && App.refresh()); }
      const r = e.target.closest('[data-oid]'); if (r) OrderUI.detail(r.dataset.oid);
    };
  },
};

/* =============================== DELIVERY =============================== */
PAGES.delivery = {
  title: ['รับสินค้า', 'Delivery'],
  async render(el) {
    const [orders, rcv] = await Promise.all([api('orders_list'), api('receipts_list', 60)]);
    const T = App.today;
    const open = orders.filter(o => !['received', 'cancelled'].includes(o.status)).sort((a, b) => a.priority - b.priority || (a.expected_date || '9').localeCompare(b.expected_date || '9'));
    const pending = rcv.filter(r => !r.confirmed_at);
    const orow = o => `<div class="rrow" style="grid-template-columns:minmax(0,1fr) 110px 260px 110px;--c:${C[orderCls(o)]}">
        <div>${matName(o.material)}<div class="faint" style="font-size:12px">${o.id} · สั่ง ${fmtDShort(o.order_date)}</div></div>
        <div class="r">${qtyH(o.remaining_qty, o.material.unit)}<div class="faint" style="font-size:11px">ค้างรับ</div></div>
        <div>${orderBadge(o)}${o.partial ? `<div class="hint num" style="margin-top:4px">รับแล้ว ${fmtN(o.received_qty)} / ${fmtN(o.ordered_qty)}</div>` : ''}</div>
        <div class="r"><button class="btn btn-primary sm" data-rcv="${o.id}">${ic('inbox', 'sm')}รับของ</button></div></div>`;
    const rrow = r => `<div class="rrow" style="grid-template-columns:96px minmax(0,1fr) 110px 150px">
        <div>${bi(fmtDShort(r.date), r.date === T ? 'TODAY' : fmtDEn(r.date))}</div>
        <div>${matName(r.material)}<div class="faint" style="font-size:12px">โดย ${esc(r.by || '-')}${r.orders.length ? ' · ' + r.orders.map(x => x.order).join(', ') : ' · ไม่ผูกใบสั่ง'}</div></div>
        <div class="r">${qtyH(r.qty, r.material.unit)}</div>
        <div class="r">${r.confirmed_at ? `<span class="badge ok"><span class="dot"></span>${bi('ยืนยันแล้ว', esc(r.confirmed_by || ''))}</span>` : App.officer ? `<button class="btn btn-ok sm" data-conf="${r.date}|${r.material_id}">${ic('check', 'sm')}ยืนยัน</button>` : `<span class="badge ordered"><span class="dot"></span>${bi('รอ Officer', 'PENDING')}</span>`}</div></div>`;
    el.innerHTML = `<div class="page"><div class="home-grid">
      <section class="card">
        <div class="card-h">${tile('truck', 'var(--st-sched)', 'sm')}<div class="title">${bi('รอรับสินค้า', 'Awaiting delivery')}</div><span class="count-chip">${open.length}</span><span class="grow"></span>
          <button class="btn btn-plain sm" data-rcv="free">${ic('plus', 'sm')}รับของนอกใบสั่ง</button></div>
        ${open.length ? `<div class="rows">${open.map(orow).join('')}</div>` : emptyState('truck', 'ไม่มีรายการรอรับ', 'Nothing to receive', 'ใบสั่งซื้อที่ยังรับไม่ครบจะแสดงที่นี่', '', true)}
      </section>
      <section class="card">
        <div class="card-h">${tile('inbox', 'var(--st-ok)', 'sm')}<div class="title">${bi('บันทึกการรับ 60 วัน', 'Receipts')}</div><span class="grow"></span>
          ${App.officer && pending.length > 1 ? `<button class="btn btn-ok sm" data-confall>${ic('check', 'sm')}ยืนยันทั้งหมด ${pending.length}</button>` : pending.length ? `<span class="badge ordered">${pending.length} รอยืนยัน</span>` : ''}</div>
        ${rcv.length ? `<div class="rows">${rcv.map(rrow).join('')}</div>` : emptyState('inbox', 'ยังไม่มีการรับสินค้า', 'No receipts')}
      </section></div></div>`;
    el.onclick = async e => {
      const r = e.target.closest('[data-rcv]'); if (r) return this.receive(r.dataset.rcv === 'free' ? null : open.find(o => o.id === r.dataset.rcv));
      const c = e.target.closest('[data-conf]');
      if (c) { const [d, id] = c.dataset.conf.split('|'); try { await api('receipt_confirm', d, +id, true); toast('ยืนยันการรับแล้ว'); await App.bumpRev(); this.render(el); } catch (er) { toastErr(er); } }
      if (e.target.closest('[data-confall]')) { try { for (const p of pending) await api('receipt_confirm', p.date, p.material_id, true); toast(`ยืนยันแล้ว ${pending.length} รายการ`); await App.bumpRev(); this.render(el); } catch (er) { toastErr(er); } }
    };
  },
  async receive(o) {
    const stock = o ? null : await api('materials_list');
    const day = await api('day_get', App.today);
    openPanel({
      title: 'บันทึกรับสินค้า', en: 'Receive goods', icon: 'inbox', color: 'var(--st-ok)',
      body: `${o ? `<div style="display:flex;gap:14px;align-items:center">${matName(o.material)}<span style="flex:1"></span>${orderBadge(o)}</div>
          <div class="infobox"><div><div class="k">สั่ง<span class="en">Ordered</span></div><div class="v num">${fmtN(o.ordered_qty)}<span class="u">${esc(o.material.unit)}</span></div></div><div><div class="k">รับแล้ว<span class="en">Received</span></div><div class="v num">${fmtN(o.received_qty)}</div></div><div><div class="k">ค้างรับ<span class="en">Remaining</span></div><div class="v num">${fmtN(o.remaining_qty)}</div></div></div>`
          : `<div class="field"><label>Material</label><select class="input" id="rm">${stock.filter(m => m.status === 'active').map(m => `<option value="${m.id}" data-u="${esc(m.unit)}">${esc(m.name)} (${esc(m.unit)})</option>`).join('')}</select></div>`}
        <div class="frow">
          <div class="field"><label>จำนวนที่รับ <span class="en">Received qty</span></label><div class="input-wrap"><input class="input num" id="rq" inputmode="decimal" value="${o ? o.remaining_qty : ''}" style="font-size:22px;height:56px"><span class="unit" id="ru">${o ? esc(o.material.unit) : ''}</span></div></div>
          <div class="field"><label>วันที่รับของเข้า <span class="en">Received date</span></label><input class="input" type="date" id="rd" value="${App.today}" max="${App.today}" style="height:56px"></div>
        </div>
        <div class="field"><label>ผู้รับ <span class="en">OPS</span></label><input class="input" id="rops" maxlength="12" value="${esc(day.ops || '')}" placeholder="${esc(day.prev_ops || 'ชื่อ')}" style="text-transform:uppercase;font-weight:700;color:#B0179F;max-width:200px"></div>
        <div id="rpart"></div>
        <p class="hint">${ic('entry', 'sm')} ระบบจะบวกจำนวนนี้ลงช่อง <b>รับสินค้า</b> ของวันที่เลือกในหน้า กรอก STOCK และให้ Officer ยืนยันอีกครั้ง</p>
        <div class="err-text" id="rerr"></div>`,
      foot: `<button class="btn btn-plain" data-x2>ยกเลิก</button><button class="btn btn-primary lg" id="rsave">${ic('check')}${bi('บันทึกรับ', 'Receive')}</button>`,
      onMount: (p, close) => {
        p.querySelector('[data-x2]').onclick = close;
        const rq = p.querySelector('#rq');
        const part = () => { if (!o) return; const q = parseNum(rq.value); p.querySelector('#rpart').innerHTML = q && q < o.remaining_qty ? `<div class="compare less">${ic('alert', 'sm')}รับไม่ครบ — สถานะจะเป็น <b>รับแล้ว ${fmtN(o.received_qty + q)} / ${fmtN(o.ordered_qty)}</b> (PARTIAL)</div>` : q > o.remaining_qty ? `<div class="compare more">${ic('up', 'sm')}รับเกินจำนวนค้าง ${fmtN(q - o.remaining_qty)} ${esc(o.material.unit)}</div>` : q ? `<div class="compare same">${ic('check', 'sm')}รับครบตามใบสั่ง → <b>รับเข้าแล้ว</b></div>` : ''; };
        rq.oninput = () => { rq.value = rq.value.replace(/[^\d.,]/g, ''); part(); }; part();
        const rm = p.querySelector('#rm'); if (rm) { const s = () => p.querySelector('#ru').textContent = rm.selectedOptions[0]?.dataset.u || ''; rm.onchange = s; s(); }
        setTimeout(() => { rq.focus(); rq.select(); }, 60);
        p.querySelector('#rsave').onclick = async () => {
          try {
            const ops = p.querySelector('#rops').value || day.prev_ops;
            await api('receipt_add', p.querySelector('#rd').value, o ? o.material_id : +rm.value, rq.value, ops);
            close(); toast('บันทึกรับสินค้าแล้ว', `${o ? esc(o.material.name) : ''} +${esc(rq.value)}`); await App.bumpRev(); App.refresh();
          } catch (e) { p.querySelector('#rerr').textContent = e.message; }
        };
      },
    });
  },
};

/* =============================== DOCUMENTS (A3) =============================== */
PAGES.docs = {
  title: ['เอกสาร A3', 'Documents'], month: null,
  async render(el) {
    this.month = this.month || App.today.slice(0, 7);
    const [mg, docs] = await Promise.all([api('month_get', this.month), api('documents_list')]);
    const pages = Math.max(1, Math.ceil(mg.materials.length / 6));
    const dmap = {}; docs.forEach(d => { if (d.month === this.month) dmap[d.page] = d; });
    const T = App.today;
    const prevM = (() => { const d = pd(this.month + '-01'); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
    const nextM = (() => { const d = pd(this.month + '-01'); d.setMonth(d.getMonth() + 1); return iso(d).slice(0, 7); })();
    const card = pg => {
      const d = dmap[pg], mats = mg.materials.slice((pg - 1) * 6, pg * 6);
      const st = !d ? 0 : d.verified_at ? 4 : d.scan_file ? 3 : d.print_count ? 2 : 1;
      const step = (n, t) => `<span class="s ${st > n ? 'done' : st === n ? 'cur' : ''}">${st > n ? ic('check', 'sm') : ''}${t}</span>`;
      return `<div class="docpage card">
        <div class="thumb" data-prev="${pg}"><div class="a3scale" data-thumb="${pg}"></div></div>
        <div style="display:flex;align-items:center;gap:10px"><div style="flex:1">${bi(`หน้า ${pg} / ${pages}`, `PAGE ${pg}`)}</div><span class="did">${d ? esc(d.id) : '<span class="faint" style="font-size:13px">ยังไม่ออกเลข</span>'}</span></div>
        <div class="mats">${mats.map(m => esc(m.name)).join(' · ')}</div>
        <div class="flow">${step(1, 'พิมพ์')}${ic('chevR', 'sm')}${step(2, 'สแกน')}${ic('chevR', 'sm')}${step(3, 'ตรวจสอบ')}</div>
        ${d?.scan_file ? `<div class="hint">สแกน: ${esc(d.scan_file)} · ${esc(d.scan_uploaded_by || '')} ${fmtTime(d.scan_uploaded_at)}${d.verified_at ? ` · <b style="color:var(--run)">Officer ตรวจแล้ว (${esc(d.verified_by)})</b>` : ''}</div>` : d?.print_count ? `<div class="hint">พิมพ์แล้ว ${d.print_count} ครั้ง · ล่าสุด ${fmtD(d.last_printed_at)} ${fmtTime(d.last_printed_at)}</div>` : ''}
        <div class="acts">
          <button class="btn btn-primary sm" data-print="${pg}">${ic('print', 'sm')}พิมพ์ A3</button>
          <button class="btn btn-plain sm" data-blank="${pg}">${ic('doc', 'sm')}ฟอร์มเปล่า</button>
          <button class="btn btn-plain sm" data-up="${pg}">${ic('upload', 'sm')}อัปโหลดสแกน</button>
          ${d?.scan_file ? `<button class="btn btn-ghost sm" data-view="${esc(d.id)}">${ic('eye', 'sm')}ดูไฟล์</button>` : ''}
          ${App.officer && d?.scan_file && !d.verified_at ? `<button class="btn btn-ok sm" data-ver="${esc(d.id)}">${ic('shield', 'sm')}ตรวจสอบแล้ว</button>` : ''}
        </div></div>`;
    };
    const hist = docs.slice(0, 40).map(d => `<div class="rrow g-doc">
        <span class="did" style="font-family:ui-monospace,Consolas,monospace;font-weight:700">${esc(d.id)}</span>
        <span>${bi(fmtMonth(d.month), fmtMonthEn(d.month))}</span><span>หน้า ${d.page}</span>
        <span class="muted">${d.print_count ? `พิมพ์ ${d.print_count} ครั้ง` : 'ยังไม่พิมพ์'}</span>
        <span>${d.scan_file ? `<span class="link" data-view="${esc(d.id)}">${ic('eye', 'sm')}ไฟล์สแกน</span>` : '<span class="faint">ยังไม่มีสแกน</span>'}</span>
        <span>${d.verified_at ? `<span class="badge ok"><span class="dot"></span>${bi('ตรวจแล้ว', esc(d.verified_by || ''))}</span>` : d.scan_file ? `<span class="badge ordered"><span class="dot"></span>${bi('รอ Officer', 'PENDING')}</span>` : '<span class="badge neutral"><span class="dot"></span>รอสแกน</span>'}</span>
        <span class="faint" style="font-size:12.5px">${fmtD(d.created_at)}</span></div>`).join('');
    el.innerHTML = `<div class="page">
      <div class="toolbar">
        <div class="datebox"><button class="icon-btn" data-m="${prevM}">${ic('chevL')}</button><div class="dlabel"><div class="d">${fmtMonth(this.month)}</div><div class="s">${fmtMonthEn(this.month)} · A3 Landscape 420 × 297 mm</div></div><button class="icon-btn" data-m="${nextM}">${ic('chevR')}</button></div>
        <span class="grow"></span>
        <div class="flow"><span class="s">${ic('a3', 'sm')}ฟอร์ม A3</span>${ic('arrowR', 'sm')}<span class="s">${ic('print', 'sm')}พิมพ์</span>${ic('arrowR', 'sm')}<span class="s">${ic('edit', 'sm')}เขียนมือ</span>${ic('arrowR', 'sm')}<span class="s">${ic('upload', 'sm')}สแกน/อัปโหลด</span>${ic('arrowR', 'sm')}<span class="s">${ic('shield', 'sm')}Officer ตรวจ</span></div>
        <button class="btn btn-plain" data-export>${ic('download', 'sm')}${bi('ส่งออกไฟล์', 'Export PDF / Excel')}</button>
        <button class="btn btn-primary" data-printall>${ic('print', 'sm')}${bi(`พิมพ์ทั้งเดือน (${pages} แผ่น)`, 'Print all')}</button>
      </div>
      <div class="docpages">${Array.from({ length: pages }, (_, i) => card(i + 1)).join('')}</div>
      <section class="card" style="margin-top:var(--gap)"><div class="card-h">${tile('doc', 'var(--primary)', 'sm')}<div class="title">${bi('ประวัติเอกสาร', 'Document history')}</div><span class="count-chip">${docs.length}</span></div>
        ${docs.length ? `<div class="rhead g-doc"><span>เลขที่เอกสาร<span class="en">Document ID</span></span><span>เดือน</span><span>หน้า</span><span>การพิมพ์</span><span>ไฟล์สแกน<span class="en">Attached scan</span></span><span>ตรวจสอบ<span class="en">Verification</span></span><span>สร้างเมื่อ</span></div><div class="rows">${hist}</div>` : emptyState('doc', 'ยังไม่มีเอกสาร', 'No documents yet', 'เลขที่เอกสาร (เช่น STK-261007-001) จะถูกสร้างเมื่อพิมพ์ฟอร์มครั้งแรก')}
      </section>
      <input type="file" id="scanfile" accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff,image/*" class="hidden"></div>`;
    // thumbnails
    for (let pg = 1; pg <= pages; pg++) {
      const host = el.querySelector(`[data-thumb="${pg}"]`);
      host.innerHTML = `<style>${A3.CSS}</style>` + A3.sheet({ month: this.month, page: pg, pages, days: mg.days, ops: mg.ops, materials: mg.materials.slice((pg - 1) * 6, pg * 6), doc: dmap[pg] }, { today: T });
      const box = host.parentElement; const s = box.clientWidth / 1587; host.style.transform = `scale(${s})`; box.style.height = (1123 * s) + 'px';
      A3.fit(host);
    }
    let upPage = null;
    el.querySelector('#scanfile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f || !upPage) return;
      try {
        const doc = await api('document_ensure', this.month, upPage);
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        await api('scan_upload', doc.id, f.name, b64, '');
        toast('อัปโหลดสแกนแล้ว', `${doc.id} · ${esc(f.name)}`); await App.bumpRev(); this.render(el);
      } catch (er) { toastErr(er); }
    };
    el.onclick = async e => {
      const t = e.target.closest('[data-m],[data-print],[data-blank],[data-up],[data-view],[data-ver],[data-printall],[data-prev],[data-export]'); if (!t) return;
      if (t.dataset.export !== undefined) return ExportUI.open(this.month);
      if (t.dataset.m) { this.month = t.dataset.m; return this.render(el); }
      if (t.dataset.print) return this.print([+t.dataset.print], false);
      if (t.dataset.blank) return this.print([+t.dataset.blank], true);
      if (t.dataset.printall !== undefined) return this.print(Array.from({ length: pages }, (_, i) => i + 1), false);
      if (t.dataset.prev) return this.preview(+t.dataset.prev, pages);
      if (t.dataset.up) { upPage = +t.dataset.up; return el.querySelector('#scanfile').click(); }
      if (t.dataset.view) { try { const r = await api('scan_open', t.dataset.view); if (r && r.url) openUrl(r.url); } catch (er) { toastErr(er); } return; }
      if (t.dataset.ver) { try { await api('document_verify', t.dataset.ver, true, ''); toast('ตรวจสอบเอกสารแล้ว', t.dataset.ver); await App.bumpRev(); this.render(el); } catch (er) { toastErr(er); } }
    };
  },
  async print(pages, blank) {
    try {
      const datas = [];
      for (const pg of pages) datas.push(await api('a3_data', this.month, pg, blank));
      const html = A3.printDoc(datas.map(d => A3.sheet(d, { blank, today: App.today })), `HRM-STOCK-${this.month}${blank ? '-BLANK' : ''}`);
      await printHtml(html, `HRM-STOCK-${this.month}${pages.length === 1 ? '-p' + pages[0] : ''}${blank ? '-blank' : ''}`);
      for (const d of datas) await api('document_printed', d.doc.id);
      toast('ส่งไปพิมพ์แล้ว', `${datas.map(d => d.doc.id).join(', ')} · เลือกกระดาษ A3 แนวนอน`, 'info');
      await App.bumpRev(); this.render($('#content'));
    } catch (e) { toastErr(e); }
  },
  async preview(pg, pages) {
    const mg = await api('month_get', this.month), docs = await api('documents_list');
    const doc = docs.find(d => d.month === this.month && d.page === pg);
    openPanel({
      title: `ตัวอย่างฟอร์ม A3 · หน้า ${pg}`, en: `${fmtMonthEn(this.month)} · A3 LANDSCAPE 420 × 297 MM`, icon: 'a3', wide: true,
      body: `<div class="preview-stage" id="pst"><div class="paper" id="ppr"><style>${A3.CSS}</style>${A3.sheet({ month: this.month, page: pg, pages, days: mg.days, ops: mg.ops, materials: mg.materials.slice((pg - 1) * 6, pg * 6), doc, printed_at: '' }, { today: App.today })}</div></div>`,
      foot: `<div class="seg sm" id="pbw"><button data-bw="0" class="${this.bw ? '' : 'on'}">${ic('eye', 'sm')}สี</button><button data-bw="1" class="${this.bw ? 'on' : ''}">ขาวดำ</button></div><span class="hint" style="margin-right:auto">ขนาดจริง 420 × 297 mm · ตั้งเครื่องพิมพ์เป็น A3 แนวนอน, Scale 100%</span><button class="btn btn-plain" data-b>${ic('doc', 'sm')}พิมพ์ฟอร์มเปล่า</button><button class="btn btn-primary" data-p>${ic('print', 'sm')}พิมพ์ A3</button>`,
      onMount: (p, close) => {
        const ppr = p.querySelector('#ppr'), st = p.querySelector('#pst');
        // black-and-white preview: how the sheet looks from a mono printer (header colours turn grey)
        const bw = on => { this.bw = on; ppr.classList.toggle('bw', on); st.classList.toggle('bw', on); $$('#pbw [data-bw]', p).forEach(b => b.classList.toggle('on', (b.dataset.bw === '1') === on)); };
        bw(!!this.bw);
        p.querySelector('#pbw').onclick = e => { const b = e.target.closest('[data-bw]'); if (b) bw(b.dataset.bw === '1'); };
        requestAnimationFrame(() => { A3.fit(ppr); const s = (st.clientWidth - 40) / 1587; ppr.style.transform = `scale(${s})`; ppr.style.marginBottom = `${-1123 * (1 - s)}px`; });
        p.querySelector('[data-p]').onclick = () => { close(); this.print([pg], false); };
        p.querySelector('[data-b]').onclick = () => { close(); this.print([pg], true); };
      },
    });
  },
};

/* =============================== EXPORT (PDF / Excel · with data or blank) =============================== */
const ExportUI = {
  st: { scope: 'one', blank: false, pdf: true, xlsx: true, sel: [], year: null },
  async open(month) {
    const rng = await api('export_range');
    const st = this.st, have = new Set(rng.data_months || []);
    st.scope = 'one'; st.sel = [month]; st.year = +month.slice(0, 4); st.title = A3.title();
    const y0 = +rng.first.slice(0, 4), y1 = +rng.last.slice(0, 4);
    const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
    const allMonths = () => { const out = []; let d = pd(rng.first + '-01'); while (iso(d).slice(0, 7) <= rng.last) { out.push(iso(d).slice(0, 7)); d.setMonth(d.getMonth() + 1); } return out; };
    // months you can pick: with data → up to this month; blank form → whole year (print forms ahead)
    const pickable = k => k >= rng.first && (st.blank ? k.slice(0, 4) <= rng.last.slice(0, 4) : k <= rng.last);
    const months = () => (st.scope === 'all' ? allMonths() : st.sel.slice()).sort();
    const shortM = k => `${TH_M[+k.slice(5) - 1]} ${k.slice(0, 4)}`;
    const desc = () => {
      const l = months(); if (!l.length) return 'ยังไม่ได้เลือกเดือน';
      if (l.length === 1) return fmtMonth(l[0]);
      const contiguous = l.length === allBetween(l[0], l[l.length - 1]).length;
      return contiguous ? `${l.length} เดือน · ${shortM(l[0])} – ${shortM(l[l.length - 1])}` : `${l.length} เดือน · ${l.map(shortM).join(', ')}`;
    };
    const allBetween = (a, z) => { const out = []; let d = pd(a + '-01'); while (iso(d).slice(0, 7) <= z) { out.push(iso(d).slice(0, 7)); d.setMonth(d.getMonth() + 1); } return out; };
    const fname = ext => {
      const l = months(), b = st.blank ? '_BLANK' : ''; if (!l.length) return '';
      if (l.length === 1) return `HRM-STOCK_${l[0]}${b}.${ext}`;
      const contiguous = l.length === allBetween(l[0], l[l.length - 1]).length;
      if (contiguous) return `HRM-STOCK_${l[0]}_to_${l[l.length - 1]}${b}.${ext}`;
      const sameY = l.every(k => k.slice(0, 4) === l[0].slice(0, 4));
      return `HRM-STOCK_${sameY ? l[0].slice(0, 4) + '_' + l.map(k => k.slice(5)).join('-') : l.join('_')}${b}.${ext}`;
    };
    const opt = (k, v, icon, t, en, d) => `<button class="xopt ${st[k] === v ? 'on' : ''}" data-k="${k}" data-v="${v}">${ic(icon)}<span class="t">${bi(t, en)}<span class="d">${d}</span></span><span class="tick">${ic('check', 'sm')}</span></button>`;
    const chk = (k, icon, t, en, d) => `<button class="xopt ${st[k] ? 'on' : ''}" data-c="${k}">${ic(icon)}<span class="t">${bi(t, en)}<span class="d">${d}</span></span><span class="tick">${ic('check', 'sm')}</span></button>`;
    const grid = () => {
      const sel = new Set(months()), ro = st.scope === 'all';
      const cells = Array.from({ length: 12 }, (_, i) => {
        const k = ym(st.year, i + 1), ok = pickable(k);
        return `<button class="mchip ${sel.has(k) ? 'on' : ''}" data-mo="${k}" ${!ok || ro ? 'disabled' : ''}><b>${TH_M[i]}</b><span>${EN_M[i]}</span>${have.has(k) ? '<i title="มีข้อมูล"></i>' : ''}</button>`;
      }).join('');
      return `<div class="mpick ${ro ? 'ro' : ''}">
        <div class="mpick-h"><button class="icon-btn sm" data-yr="-1" ${st.year <= y0 ? 'disabled' : ''}>${ic('chevL', 'sm')}</button><b>${st.year}</b><button class="icon-btn sm" data-yr="1" ${st.year >= y1 ? 'disabled' : ''}>${ic('chevR', 'sm')}</button>
          <span class="grow"></span>${st.scope === 'many' ? `<button class="link" data-q="year">เลือกทั้งปี ${st.year}</button><button class="link" data-q="clear">ล้าง</button>` : ''}
          <span class="legend"><i></i>มีข้อมูล</span></div>
        <div class="mgrid">${cells}</div></div>`;
    };
    const body = () => `
      <div class="xsec"><div class="flabel">เดือนที่ต้องการ <span class="en">Months</span></div>
        <div class="seg xseg">${[['one', 'เดือนเดียว'], ['all', 'ทุกเดือน'], ['many', 'เลือกหลายเดือน']].map(([k, t]) => `<button data-s="${k}" class="${st.scope === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        <div class="hint">${st.scope === 'one' ? 'แตะเดือนที่ต้องการ 1 เดือน' : st.scope === 'all' ? `ทุกเดือนที่มีในระบบ ${shortM(rng.first)} – ${shortM(rng.last)} รวมไว้ในไฟล์เดียว` : 'แตะเพื่อเลือก/ยกเลิกได้หลายเดือน รวมไว้ในไฟล์เดียว'}</div>
        ${grid()}</div>
      <div class="xsec"><div class="flabel">เนื้อหา <span class="en">Content</span></div><div class="xgrid">
        ${opt('blank', false, 'sheet', 'มีข้อมูล', 'WITH DATA', 'รับสินค้า · ทั้งหมด · ใช้ไป · คงเหลือ · OPS ตามที่บันทึก')}
        ${opt('blank', true, 'doc', 'ฟอร์มเปล่า', 'BLANK FORM', 'มีชื่อ Material และจุดสั่งซื้อ · ช่องว่างสำหรับเขียนมือ · เลือกเดือนล่วงหน้าได้')}</div></div>
      <div class="xsec"><div class="flabel">หัวข้อบนฟอร์ม <span class="en">Heading · แสดงแถวบนสุดของทุกแผ่น</span></div>
        <div class="xtitle"><input class="input" id="xt" maxlength="60" value="${esc(st.title)}" placeholder="ไม่ใส่หัวข้อ">
          <button class="chip-btn ${st.title === 'Stock HRM' ? 'on' : ''}" data-tq="Stock HRM">Stock HRM</button><button class="chip-btn ${st.title ? '' : 'on'}" data-tq="">ไม่ใส่หัวข้อ</button></div>
        <div class="xtitle-pv"><span>UPDATE : ${fmtD(App.today)}</span><b>${st.title ? esc(st.title) : '<i>— ไม่มีหัวข้อ —</i>'}</b><span></span></div></div>
      <div class="xsec"><div class="flabel">รูปแบบไฟล์ <span class="en">Format · เลือกได้ทั้งสองแบบ</span></div><div class="xgrid">
        ${chk('pdf', 'pdf', 'PDF', 'A3 LANDSCAPE', 'ขนาด 420 × 297 mm · พร้อมพิมพ์ 1 บล็อกต่อแผ่น')}
        ${chk('xlsx', 'xls', 'Excel', 'ORIGINAL LAYOUT', 'แบบดั้งเดิม · 1 ชีตต่อเดือน · มีสูตรคำนวณ')}</div></div>
      <div class="xsum">${ic('download')}<div>${bi(`${desc()}${months().length ? ' · ' + ([st.pdf && 'PDF', st.xlsx && 'Excel'].filter(Boolean).join(' + ') || 'ยังไม่เลือกไฟล์') : ''}`, [st.pdf && fname('pdf'), st.xlsx && fname('xlsx')].filter(Boolean).join('  ·  '))}</div></div>
      <div id="xres"></div>`;
    openPanel({
      title: 'ส่งออกไฟล์ฟอร์ม A3', en: 'EXPORT PDF / EXCEL', icon: 'download', body: body(),
      foot: `<span class="hint" style="margin-right:auto">ข้อมูลล่าสุดเสมอ — แก้ย้อนหลังแล้วส่งออกใหม่ได้</span><button class="btn btn-plain" data-close>ปิด</button><button class="btn btn-primary" data-xgo>${ic('download', 'sm')}${bi('ส่งออก', 'Export')}</button>`,
      onMount: (p, close) => {
        const b = p.querySelector('.panel-b'), go = p.querySelector('[data-xgo]');
        const redraw = () => { const keep = b.querySelector('#xres').innerHTML, top = b.scrollTop; b.innerHTML = body(); b.querySelector('#xres').innerHTML = keep; b.scrollTop = top; go.disabled = !(st.pdf || st.xlsx) || !months().length; };
        redraw();
        p.querySelector('[data-close]').onclick = close;
        b.onclick = e => {
          const t = e.target.closest('[data-s],[data-k],[data-c],[data-mo],[data-yr],[data-q],[data-open],[data-dir],[data-dl],[data-url],[data-tq]'); if (!t || t.disabled) return;
          if (t.dataset.tq !== undefined) { st.title = t.dataset.tq; return redraw(); }
          if (t.dataset.url) return openUrl(t.dataset.url);
          if (t.dataset.dl !== undefined) { const r = (this.files || [])[+t.dataset.dl]; if (r && r.b64) downloadB64(r.b64, r.name, r.mime); else if (r) openUrl(r.download || r.url); return; }
          if (t.dataset.open || t.dataset.dir) { api('export_open', t.dataset.open || t.dataset.dir, !!t.dataset.dir).catch(toastErr); return; }
          if (t.dataset.s) {
            const prev = st.scope; st.scope = t.dataset.s;
            if (st.scope === 'one') st.sel = [st.sel.find(pickable) || rng.last];
            if (st.scope === 'many' && prev === 'all') st.sel = allMonths();
          }
          if (t.dataset.k) { st[t.dataset.k] = t.dataset.v === 'true'; st.sel = st.sel.filter(pickable); if (!st.sel.length) st.sel = [rng.last]; }
          if (t.dataset.c) st[t.dataset.c] = !st[t.dataset.c];
          if (t.dataset.yr) st.year += +t.dataset.yr;
          if (t.dataset.mo) {
            const k = t.dataset.mo;
            if (st.scope === 'one') st.sel = [k];
            else st.sel = st.sel.includes(k) ? st.sel.filter(x => x !== k) : [...st.sel, k];
          }
          if (t.dataset.q === 'year') st.sel = [...new Set([...st.sel, ...Array.from({ length: 12 }, (_, i) => ym(st.year, i + 1)).filter(pickable)])];
          if (t.dataset.q === 'clear') st.sel = [];
          redraw();
        };
        b.addEventListener('input', e => {
          if (e.target.id !== 'xt') return;
          st.title = e.target.value.trim();
          const pv = b.querySelector('.xtitle-pv b'); if (pv) pv.innerHTML = st.title ? esc(st.title) : '<i>— ไม่มีหัวข้อ —</i>';
          $$('[data-tq]', b).forEach(x => x.classList.toggle('on', x.dataset.tq === st.title));
        });
        go.onclick = async () => {
          const list = months(), res = [];
          A3.setTitle(st.title);
          if (!list.length) return;
          go.disabled = true; const label = go.innerHTML; go.innerHTML = `<span class="spin"></span>กำลังสร้างไฟล์…`;
          try {
            if (st.xlsx) { const r = await api('export_excel', list, null, st.blank, fname('xlsx'), st.title); if (r) res.push(['xls', r]); }
            if (st.pdf && IS_GAS) { const r = await api('export_pdf_months', list, st.blank, fname('pdf'), st.title); if (r) res.push(['pdf', r]); }
            if (st.pdf && !IS_GAS) {
              const mgs = []; for (const m of list) mgs.push(await api('month_get', m));
              const pages = mgs.flatMap(mg => A3.monthPages(mg, { blank: st.blank, today: App.today, title: st.title }));
              try {
                const r = await api('export_pdf', A3.printDoc(pages, fname('pdf'), false), fname('pdf'), list[0], list[list.length - 1], st.blank);
                if (r) res.push(['pdf', r]);
              } catch (er) {
                if (!String(er.message).startsWith('NOPDF')) throw er;
                await printHtml(A3.printDoc(pages, fname('pdf')), fname('pdf').replace('.pdf', ''));
                toast('เปิดหน้าพิมพ์แทน', 'เครื่องนี้สร้าง PDF อัตโนมัติไม่ได้ — เลือกเครื่องพิมพ์ "Microsoft Print to PDF" · กระดาษ A3 แนวนอน', 'info');
              }
            }
            if (res.length) {
              if (IS_GAS) { this.files = res.map(x => x[1]); res.forEach(([, r]) => { if (r.b64) downloadB64(r.b64, r.name, r.mime); }); }
              b.querySelector('#xres').innerHTML = `<div class="xdone"><div class="flabel" style="color:var(--run)">${ic('check', 'sm')}ส่งออกแล้ว <span class="en">Saved</span></div>${res.map(([k, r], i) => `<div class="xfile">${ic(k)}<div class="t"><b>${esc(r.name)}</b><span>${IS_GAS ? 'เก็บไว้ใน Google Drive › HRM Stock - Export' : esc(r.path)} · ${(r.size / 1024).toFixed(0)} KB</span></div>${IS_GAS
                ? `<button class="btn btn-plain sm" data-dl="${i}">${ic('download', 'sm')}ดาวน์โหลด</button><button class="btn btn-ghost sm" data-url="${esc(r.url)}">${ic('eye', 'sm')}Google Drive</button>`
                : `<button class="btn btn-plain sm" data-open="${esc(r.path)}">เปิดไฟล์</button><button class="btn btn-ghost sm" data-dir="${esc(r.path)}">${ic('folder', 'sm')}โฟลเดอร์</button>`}</div>`).join('')}</div>`;
              toast('ส่งออกไฟล์แล้ว', res.map(([, r]) => esc(r.name)).join(' · '));
            }
          } catch (er) { toastErr(er); }
          go.innerHTML = label; go.disabled = !months().length;
        };
      },
    });
  },
};

/* =============================== MATERIAL MASTER =============================== */
PAGES.master = {
  title: ['จัดการ Material', 'Material Master'], q: '', showInactive: false,
  async render(el) {
    const list = await api('materials_list');
    const pending = list.filter(m => m.status === 'pending');
    el.innerHTML = `<div class="page">
      <div class="toolbar">
        <div class="hint" style="max-width:520px">${ic('db', 'sm')} <b>ONE MATERIAL → ONE MASTER RECORD</b> · ชื่อ หน่วย จุดสั่งซื้อ และ MOQ จากหน้านี้ถูกใช้ทุกหน้า รวมถึงฟอร์ม A3 (ลำดับในตาราง = ลำดับในฟอร์ม, 6 รายการต่อแผ่น)</div>
        <span class="grow"></span>
        <label style="display:flex;gap:8px;align-items:center;font-size:14px;color:var(--fg-2);font-weight:600"><span class="switch"><input type="checkbox" id="mi" ${this.showInactive ? 'checked' : ''}><span></span></span>แสดงที่ปิดใช้งาน</label>
        <label class="search">${ic('search', 'sm')}<input class="input" id="mq" placeholder="ค้นหา…" value="${esc(this.q)}"></label>
        ${App.officer ? `<button class="btn btn-plain" data-openingall>${ic('stock', 'sm')}${bi('ยอดยกมา', 'OPENING · ALL')}</button><button class="btn btn-plain" data-prices>${ic('coins', 'sm')}${bi('ตารางราคา', 'PRICE LIST')}</button>` : ''}
        <button class="btn btn-primary" data-add>${ic('plus', 'sm')}${bi('เพิ่ม Material', App.officer ? 'Add' : 'Request new')}</button>
      </div>
      ${pending.length ? `<section class="card" style="margin-bottom:var(--gap);box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--abn) 40%,transparent)"><div class="card-h">${tile('alert', 'var(--abn)', 'sm')}<div class="title">${bi('รออนุมัติ Material ใหม่', 'Pending approval')}</div><span class="count-chip">${pending.length}</span></div>
        <div class="rows">${pending.map(m => `<div class="rrow" style="grid-template-columns:minmax(0,1fr) 120px 150px auto">${matName(m)}<span class="num">${fmtN(m.reorder_point)} / ${fmtN(m.order_qty)} ${esc(m.unit)}</span><span class="hint">ขอโดย ${esc(m.created_by || '-')}</span>
          <span style="display:flex;gap:8px;justify-content:flex-end">${App.officer ? `<button class="btn btn-danger sm" data-rej="${m.id}">${ic('x', 'sm')}ไม่อนุมัติ</button><button class="btn btn-ok sm" data-app="${m.id}">${ic('check', 'sm')}อนุมัติ</button>` : '<span class="badge ordered">รอ Officer</span>'}</span></div>`).join('')}</div></section>` : ''}
      <div class="rhead g-mat"><span>รหัส<span class="en">ID</span></span><span>ชื่อ Material<span class="en">Name</span></span><span>หน่วย<span class="en">Unit</span></span><span class="r">จุดสั่งซื้อ<span class="en">Required</span></span><span class="r">ส่งครั้งละ<span class="en">Order qty</span></span><span class="r">MOQ</span><span>Supplier</span><span>สถานะ<span class="en">Status</span></span><span></span></div>
      <div class="rows" id="mrows"></div></div>`;
    const draw = () => {
      const q = this.q.toLowerCase();
      const rows = list.filter(m => m.status !== 'pending' && (this.showInactive || m.status === 'active') && (!q || (m.name + m.name_en + m.code + m.supplier).toLowerCase().includes(q)));
      let k = 0;
      $('#mrows').innerHTML = rows.map(m => {
        const pos = m.status === 'active' ? ++k : null;
        return `<div class="rrow g-mat" style="${m.status === 'inactive' ? 'opacity:.55' : ''}">
          <span class="num" style="font-weight:700;font-size:13.5px">${esc(m.code)}${pos ? `<div class="faint" style="font-size:11px;font-weight:600">A3 หน้า ${Math.ceil(pos / 6)} · #${(pos - 1) % 6 + 1}</div>` : ''}</span>
          <div style="display:flex;align-items:center;gap:10px;min-width:0"><span style="width:8px;height:28px;border-radius:3px;flex:none;background:#${esc(m.a3_color || 'FFCC99')}" title="สีหัวคอลัมน์ในฟอร์ม A3"></span>${matName(m)}</div>
          <span>${esc(m.unit)}</span><span class="r num" style="font-weight:700">${fmtN(m.reorder_point)}${m.override_now ? `<div class="tmp-sub" title="${esc(m.override_now.reason || '')}">ชั่วคราว ${fmtN(m.override_now.reorder_point)}</div>` : ''}</span><span class="r num" style="font-weight:700">${fmtN(m.order_qty)}${m.override_now ? `<div class="tmp-sub" title="${esc(m.override_now.reason || '')}">ชั่วคราว ${fmtN(m.override_now.order_qty)}</div>` : ''}</span>
          <span class="r num muted">${m.moq ? fmtN(m.moq) : '—'}</span><span class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.supplier || '—')}${m.unit_price != null ? `<div class="sp-mprice num">${fmtB(m.unit_price)} / ${esc(m.unit)}</div>` : App.officer ? '<div class="sp-mprice none">ยังไม่ใส่ราคา</div>' : ''}</span>
          <span>${m.status === 'active' ? '<span class="badge ok"><span class="dot"></span>ใช้งาน</span>' : '<span class="badge neutral"><span class="dot"></span>ปิดใช้งาน</span>'}</span>
          <span style="display:flex;gap:6px;justify-content:flex-end">${App.officer ? `<button class="icon-btn sm" data-mv="${m.id}|-1" title="เลื่อนขึ้น">${ic('chevU', 'sm')}</button><button class="icon-btn sm" data-mv="${m.id}|1" title="เลื่อนลง">${ic('chevD', 'sm')}</button><button class="icon-btn sm" data-ed="${m.id}" title="แก้ไข">${ic('edit', 'sm')}</button>` : ''}</span></div>`;
      }).join('') || `<div class="card">${emptyState('master', 'ยังไม่มี Material', 'No materials', 'กด เพิ่ม Material เพื่อเริ่ม')}</div>`;
    };
    draw();
    el.querySelector('#mq').oninput = e => { this.q = e.target.value; draw(); };
    el.querySelector('#mi').onchange = e => { this.showInactive = e.target.checked; draw(); };
    el.onclick = async e => {
      if (e.target.closest('[data-add]')) return this.form({});
      if (e.target.closest('[data-openingall]')) return OpeningUI.open();
      if (e.target.closest('[data-prices]')) return PriceTable.open('material');
      const ed = e.target.closest('[data-ed]'); if (ed) return this.form(list.find(m => m.id === +ed.dataset.ed));
      const mv = e.target.closest('[data-mv]'); if (mv) { const [id, d] = mv.dataset.mv.split('|'); try { await api('material_move', +id, +d); await App.bumpRev(); this.render(el); } catch (er) { toastErr(er); } return; }
      const ap = e.target.closest('[data-app],[data-rej]');
      if (ap) { try { await api('material_approve', +(ap.dataset.app || ap.dataset.rej), !!ap.dataset.app); toast(ap.dataset.app ? 'อนุมัติแล้ว — แสดงในหน้า กรอก STOCK' : 'ไม่อนุมัติ — ลบคำขอแล้ว'); await App.bumpRev(); this.render(el); } catch (er) { toastErr(er); } }
    };
  },
  form(m) {
    const edit = !!m.id;
    const units = ['L', 'Pail', 'Drum', 'Roll', 'Box', 'Kg', 'Pcs'];
    const colors = A3_COLORS;
    openPanel({
      title: edit ? `แก้ไข ${m.code}` : 'เพิ่ม Material ใหม่', en: edit ? 'Edit material' : (App.officer ? 'New material' : 'Request new material — Officer approves'), icon: 'master',
      body: `${!App.officer ? `<div class="compare less">${ic('shield', 'sm')}Operator ส่งคำขอได้ — Material จะแสดงในหน้า กรอก STOCK หลัง Officer อนุมัติ</div>` : ''}
        <div class="field"><label>ชื่อ Material (แสดงหลัก) <span class="en">Material name</span></label><input class="input" id="fn" value="${esc(m.name || '')}" placeholder="เช่น เชลล์ โอมาล่า S2 460 หรือ SRR-104"><div id="dup"></div></div>
        <div class="field"><label>ชื่ออังกฤษ / ชื่อเดิม <span class="en">English / original name (optional)</span></label><input class="input" id="fe" value="${esc(m.name_en || '')}" placeholder="SHELL OMALA S2 460"></div>
        <div class="field"><label>หน่วย <span class="en">Unit</span></label><div class="choices" id="fu">${units.map(u => `<button class="choice" data-u="${u}" aria-pressed="${m.unit === u}">${u}</button>`).join('')}<input class="input" id="fuo" placeholder="อื่น ๆ" style="width:120px;height:40px" value="${m.unit && !units.includes(m.unit) ? esc(m.unit) : ''}"></div></div>
        <div class="frow">
          <div class="field"><label>จุดสั่งซื้อ (Required) <span class="en">Reorder point</span></label><input class="input num" id="frp" inputmode="decimal" value="${m.reorder_point ?? ''}"><span class="hint">คงเหลือเท่านี้ → ต้องเริ่มสั่ง</span></div>
          <div class="field"><label>จำนวนที่สั่งซื้อ (ส่งครั้งละ) <span class="en">Order qty</span></label><input class="input num" id="foq" inputmode="decimal" value="${m.order_qty ?? ''}"></div>
        </div>
        <div class="frow">
          <div class="field"><label>MOQ <span class="en">Minimum order</span></label><input class="input num" id="fmoq" inputmode="decimal" value="${m.moq ?? ''}"></div>
          <div class="field"><label>ขนาดบรรจุ <span class="en">Pack size</span></label><input class="input num" id="fpk" inputmode="decimal" value="${m.pack_size ?? ''}"></div>
        </div>
        <div class="frow">
          ${App.officer ? `<div class="field"><label>ราคา/หน่วย (บาท) <span class="en">Unit price · ใช้สรุปค่าใช้จ่าย</span></label><label class="sp-pin wide"><span>฿</span><input class="input num" id="fpr" inputmode="decimal" value="${m.unit_price ?? ''}" placeholder="ต่อ ${esc(m.unit || 'หน่วย')}"></label><span class="hint">เปลี่ยนราคาแล้ว ใบสั่งเดิมยังคิดราคาเดิม</span></div>` : ''}
          <div class="field"><label>Supplier</label><input class="input" id="fs" value="${esc(m.supplier || '')}"></div>
        </div>
        <div class="field"><label>สีหัวคอลัมน์ในฟอร์ม A3 <span class="en">A3 header colour</span></label><div class="a3c-grid" id="fc">${(colors.some(([c]) => c === (m.a3_color || 'FFCC99').toUpperCase()) ? colors : [[(m.a3_color || 'FFCC99').toUpperCase(), 'สีเดิม'], ...colors]).map(([c, t]) => `<button class="choice a3c" data-c="${c}" aria-pressed="${(m.a3_color || 'FFCC99').toUpperCase() === c}" title="${t} — ซ้าย: สีจริง · ขวา: เมื่อพิมพ์ขาวดำ"><span class="a3c-sw" style="--c:#${c}"><i>ก</i><i class="bw">ก</i></span><span>${t}</span></button>`).join('')}</div>
          <div class="hint" style="margin-top:6px">ทุกสีเป็นโทนอ่อน — พิมพ์ขาวดำแล้วยังอ่านชื่อได้ (ช่องขวาของแต่ละสี = ตัวอย่างเมื่อพิมพ์ขาวดำ)</div></div>
        ${edit && App.officer ? `<label style="display:flex;gap:12px;align-items:center;font-weight:600"><span class="switch"><input type="checkbox" id="fa" ${m.status === 'active' ? 'checked' : ''}><span></span></span>${bi('ใช้งาน (แสดงในหน้า กรอก STOCK และฟอร์ม A3)', 'Active')}</label>` : ''}
        <div class="field"><label>หมายเหตุ <span class="en">Remark</span></label><input class="input" id="frm" value="${esc(m.remark || '')}"></div>
        ${!App.officer ? `<div class="field"><label>ผู้ขอ <span class="en">Requested by</span></label><input class="input" id="fby" maxlength="12" style="max-width:200px;text-transform:uppercase"></div>` : ''}
        <div class="err-text" id="ferr"></div>`,
      foot: `<button class="btn btn-plain" data-x2>ยกเลิก</button><button class="btn btn-primary lg" id="fsave">${ic('check')}${bi(edit ? 'บันทึก' : App.officer ? 'เพิ่ม Material' : 'ส่งคำขอ', 'Save')}</button>`,
      onMount: (p, close) => {
        let unit = m.unit || '', color = m.a3_color || 'FFCC99', artSel = m.art || '';
        p.querySelector('[data-x2]').onclick = close;
        p.querySelector('#fu').onclick = e => { const b = e.target.closest('[data-u]'); if (!b) return; unit = b.dataset.u; p.querySelector('#fuo').value = ''; $$('#fu .choice', p).forEach(x => x.setAttribute('aria-pressed', x === b)); };
        p.querySelector('#fuo').oninput = e => { unit = e.target.value; $$('#fu .choice', p).forEach(x => x.setAttribute('aria-pressed', 'false')); };
        p.querySelector('#fc').onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; color = b.dataset.c; $$('#fc .choice', p).forEach(x => x.setAttribute('aria-pressed', x === b)); };
        let tmr;
        p.querySelector('#fn').oninput = e => {
          clearTimeout(tmr); tmr = setTimeout(async () => {
            const hits = e.target.value.trim().length > 1 ? await api('material_check', e.target.value, null, m.id || null) : [];
            p.querySelector('#dup').innerHTML = hits.length ? `<div class="compare ${hits.some(h => h.type === 'name') ? 'less' : 'more'}" style="margin-top:8px">${ic('alert', 'sm')}${hits.some(h => h.type === 'name') ? 'ชื่อซ้ำกับ' : 'ชื่อคล้ายกับ'}: ${hits.map(h => `${esc(h.code)} ${esc(h.name)}`).join(', ')}</div>` : '';
          }, 250);
        };
        setTimeout(() => p.querySelector('#fn').focus(), 60);
        p.querySelector('#fsave').onclick = async () => {
          try {
            await api('material_save', {
              id: m.id, name: p.querySelector('#fn').value, name_en: p.querySelector('#fe').value, unit, reorder_point: p.querySelector('#frp').value, order_qty: p.querySelector('#foq').value,
              moq: p.querySelector('#fmoq').value, pack_size: p.querySelector('#fpk').value, supplier: p.querySelector('#fs').value, remark: p.querySelector('#frm').value,
              a3_color: color, art: artSel, ...(p.querySelector('#fpr') ? { unit_price: p.querySelector('#fpr').value } : {}), status: p.querySelector('#fa') ? (p.querySelector('#fa').checked ? 'active' : 'inactive') : undefined, by: p.querySelector('#fby')?.value,
            });
            close(); toast(edit ? 'บันทึก Material แล้ว' : App.officer ? 'เพิ่ม Material แล้ว' : 'ส่งคำขอแล้ว', App.officer ? 'อัปเดตทุกหน้าที่ใช้ Material นี้' : 'รอ Officer อนุมัติ'); await App.bumpRev(); App.refresh();
          } catch (e) { p.querySelector('#ferr').textContent = e.message; }
        };
      },
    });
  },
};

/* =============================== SETTINGS =============================== */
PAGES.settings = {
  title: ['ตั้งค่า', 'Settings'],
  async render(el) {
    const info = App.info = await api('app_info');
    const audit = await api('audit_list', 60);
    const theme = localStorageGet('theme') || 'auto';
    el.innerHTML = `<div class="page set-grid">
      <section class="card"><div class="card-h">${tile(info.role === 'officer' ? 'shield' : 'user', info.role === 'officer' ? 'var(--maint)' : 'var(--primary)', 'sm')}<div class="title">${bi('เครื่องนี้', 'This computer')}</div></div>
        <div class="kv"><span class="k">ชื่อเครื่อง</span><span>${esc(info.machine)}</span>
          <span class="k">โหมดการใช้งาน</span><span><div class="seg" id="role"><button data-r="operator" class="${info.role !== 'officer' ? 'on' : ''}">${ic('user', 'sm')}Operator</button><button data-r="officer" class="${info.role === 'officer' ? 'on' : ''}">${ic('shield', 'sm')}Officer</button></div></span>
          ${info.role === 'officer' ? `<span class="k">ชื่อ Officer</span><span style="display:flex;gap:8px"><input class="input" id="oname" value="${esc(info.officer_name)}" style="max-width:220px"><button class="btn btn-plain sm" id="osv">บันทึก</button></span>` : ''}
          <span class="k">ธีม</span><span><div class="seg" id="theme">${[['auto', 'อัตโนมัติ'], ['light', 'สว่าง'], ['dark', 'มืด']].map(([k, t]) => `<button data-t="${k}" class="${theme === k ? 'on' : ''}">${t}</button>`).join('')}</div></span></div>
        <p class="hint" style="margin-top:14px">Operator: กรอก STOCK, รับสินค้า, พิมพ์/อัปโหลด A3, ขอเพิ่ม Material · Officer: สั่งซื้อ, กำหนดส่ง, ยืนยันข้อมูล, แก้ Master</p></section>
      ${info.gas ? `<section class="card"><div class="card-h">${tile('db', 'var(--primary)', 'sm')}<div class="title">${bi('ฐานข้อมูล Google Sheets', 'Database')}</div><span class="grow"></span><span class="hpill ${App.online ? '' : 'err'}"><span class="dot"></span>${App.online ? 'เชื่อมต่อ' : 'ขาดการเชื่อมต่อ'}</span></div>
        <div class="pathbox">${esc(info.data_dir)}</div>
        <p class="hint">ข้อมูลทุกเครื่องอยู่ในไฟล์ Google Sheets นี้ · สำรองข้อมูลอัตโนมัติทุกคืนที่โฟลเดอร์ "HRM Stock - Backup" (เก็บ 45 วัน) · ไฟล์สแกนอยู่ที่ "HRM Stock - Scans"</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-plain sm" data-of="data">${ic('sheet', 'sm')}เปิด Google Sheets</button><button class="btn btn-plain sm" data-bk>${ic('db', 'sm')}สำรองข้อมูลตอนนี้</button></div>
        <div class="kv" style="margin-top:14px"><span class="k">ชื่อเครื่องนี้</span><span style="display:flex;gap:8px"><input class="input" id="mname2" value="${esc(info.machine)}" style="max-width:220px"><button class="btn btn-plain sm" id="msv">บันทึก</button></span></div></section>` : `<section class="card"><div class="card-h">${tile('folder', 'var(--primary)', 'sm')}<div class="title">${bi('ไดร์ฟกลาง', 'Shared data folder')}</div><span class="grow"></span><span class="hpill ${App.online ? '' : 'err'}"><span class="dot"></span>${App.online ? 'เชื่อมต่อ' : 'ขาดการเชื่อมต่อ'}</span></div>
        <div class="pathbox">${esc(info.data_dir)}\\hrm_stock.db</div>
        <p class="hint">สำรองข้อมูลอัตโนมัติวันละครั้งไว้ที่โฟลเดอร์ backup (เก็บ 45 วัน) · ไฟล์สแกนอยู่ที่โฟลเดอร์ scans</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-plain sm" data-of="data">${ic('folder', 'sm')}เปิดโฟลเดอร์</button><button class="btn btn-plain sm" data-bk>${ic('db', 'sm')}สำรองข้อมูลตอนนี้</button><button class="btn btn-ghost sm" data-chg>${ic('edit', 'sm')}เปลี่ยนโฟลเดอร์</button></div></section>`}
      ${info.role === 'officer' ? `<section class="card"><div class="card-h">${tile('key', 'var(--maint)', 'sm')}<div class="title">${bi('รหัส Officer', 'Officer PIN')}</div></div>
        <div class="frow"><div class="field"><label>รหัสเดิม</label><input class="input" type="password" id="p0" inputmode="numeric"></div><div class="field"><label>รหัสใหม่ (4–8 หลัก)</label><input class="input" type="password" id="p1" inputmode="numeric"></div></div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-tonal" id="psv">${ic('key', 'sm')}เปลี่ยนรหัส</button></div></section>` : ''}
      ${typeof People !== 'undefined' ? People.card() : ''}
      ${typeof Shift !== 'undefined' ? Shift.card() : ''}
      ${typeof LineUI !== 'undefined' ? LineUI.card() : ''}
      ${typeof QrUI !== 'undefined' ? QrUI.card() : ''}
      ${typeof PushUI !== 'undefined' ? PushUI.card() : ''}
      ${typeof HistImport !== 'undefined' ? HistImport.card() : ''}
      ${typeof BackupUI !== 'undefined' ? BackupUI.card() : ''}
      ${typeof ResetUI !== 'undefined' ? ResetUI.card() : ''}
      <section class="card" style="${info.role === 'officer' ? '' : 'grid-column:1/-1'}"><div class="card-h">${tile('clock', 'var(--fg-2)', 'sm')}<div class="title">${bi('ประวัติการใช้งาน', 'Activity log')}</div><span class="grow"></span>${IS_WEB ? `<button class="btn btn-ghost sm" data-tglogout title="ออกจากระบบทีมบนเครื่องนี้ — ต้องใส่รหัสทีมใหม่">${ic('lock', 'sm')}ออกจากระบบ</button>` : ''}<span class="faint" style="font-size:12px">v${esc(info.version)}</span></div>
        <div style="max-height:360px;overflow:auto">${audit.map(a => `<div class="audit-row"><span class="faint num">${esc(a.at.slice(5, 16))}</span><span style="font-weight:700">${esc(a.who || a.machine || '')}</span><span class="muted">${esc(a.action)} · ${esc(a.detail || '')}</span></div>`).join('') || emptyState('clock', 'ยังไม่มีประวัติ', 'No activity')}</div></section>
    </div>`;
    el.querySelector('#role').onclick = async e => {
      const b = e.target.closest('[data-r]'); if (!b || b.classList.contains('on')) return;
      if (b.dataset.r === 'officer') {
        await modal({ title: 'เข้าสู่โหมด Officer', en: 'Officer mode', icon: 'shield', color: 'var(--maint)', body: `<div class="field"><label>ชื่อ Officer</label><input class="input" id="mn" value="${esc(info.officer_name)}"></div><div class="field" style="margin-top:10px"><label>รหัส Officer</label><input class="input" type="password" id="mp" inputmode="numeric"></div><div class="err-text" style="margin-top:8px"></div>`, ok: 'เข้าสู่โหมด Officer', okEn: 'Unlock', onOk: async m => { App.info = await api('set_role', 'officer', m.querySelector('#mp').value, m.querySelector('#mn').value); } });
      } else { App.info = await api('set_role', 'operator'); }
      App.renderHeader(); this.render(el); App.updateBadges();
    };
    if (typeof People !== 'undefined') People.bindCard(el, () => this.render(el));
    if (typeof Shift !== 'undefined') Shift.bindCard(el, () => this.render(el));
    if (typeof LineUI !== 'undefined') LineUI.bind(el);
    if (typeof QrUI !== 'undefined') QrUI.bind(el, () => this.render(el));
    if (typeof PushUI !== 'undefined') PushUI.bindCard(el);
    el.querySelector('[data-tglogout]')?.addEventListener('click', () => TeamGate.logout());
    if (typeof HistImport !== 'undefined') HistImport.bind(el);
    if (typeof ResetUI !== 'undefined') ResetUI.bind(el);
    if (typeof BackupUI !== 'undefined') BackupUI.bind(el);
    el.querySelector('#theme').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; localStorageSet('theme', b.dataset.t); applyTheme(); this.render(el); };
    el.querySelector('#osv')?.addEventListener('click', async () => { await api('set_officer_name', $('#oname').value); App.info.officer_name = $('#oname').value; App.renderHeader(); toast('บันทึกชื่อแล้ว'); });
    el.querySelector('#psv')?.addEventListener('click', async () => { try { await api('change_pin', $('#p0').value, $('#p1').value); toast('เปลี่ยนรหัส Officer แล้ว', 'ใช้รหัสใหม่ได้ทุกเครื่อง'); $('#p0').value = $('#p1').value = ''; } catch (e) { toastErr(e); } });
    el.querySelector('[data-of]').onclick = async () => { try { const r = await api('open_folder', 'data'); if (r && r.url) openUrl(r.url); } catch (e) { toastErr(e); } };
    el.querySelector('#msv')?.addEventListener('click', async () => { try { App.info = await api('set_machine', $('#mname2').value); App.renderHeader(); toast('บันทึกชื่อเครื่องแล้ว'); } catch (e) { toastErr(e); } });
    el.querySelector('[data-bk]').onclick = async () => { try { const r = await api('backup_now'); toast('สำรองข้อมูล', esc(r.path)); } catch (e) { toastErr(e); } };
    el.querySelector('[data-chg]')?.addEventListener('click', () => Setup.show(1));
  },
};

function applyTheme() {
  const t = localStorageGet('theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

/* ===== home.js ===== */
/* =====================================================================
   HOME — Control Center (v2)
   Hero (situation sentence + actions + order pipeline)
   → Order timeline (each order = a lane from order date to delivery date)
   → Today's deliveries + stock level health
   ===================================================================== */
'use strict';

PAGES.home = {
  title: ['หน้าหลัก', 'Control Center'],
  RANGE_BACK: 12, RANGE_FWD: 12,

  async render(el) {
    const d = await App.dash();
    this.d = d;
    const T = d.today, s = d.summary;
    const open = d.open_orders || [];
    const byStatus = st => open.filter(o => st.includes(o.status));
    const waitDate = byStatus(['waiting_date']);
    const waiting = byStatus(['scheduled', 'today', 'overdue']);
    const overdue = byStatus(['overdue']);
    const received = d.orders.filter(o => o.status === 'received');

    el.innerHTML = `<div class="page cc">
      ${StockFix.banner(d)}
      ${this.notes(d)}
      ${this.hero(d, { waitDate, waiting, overdue, received })}
      ${MyReq.html(d)}
      ${Notif.lanes(d)}
      <div class="cc-grid">
        <section class="cc-card cc-orders">${this.timeline(d, open, received)}</section>
        <div class="cc-side">
          <section class="cc-card sp-card" id="spcard">${SpendUI.skeleton()}</section>
          <section class="cc-card">${this.today(d)}</section>
          <section class="cc-card">${this.levels(d)}</section>
        </div>
      </div>
      </div>`;

    el.onclick = e => {
      if (e.target.closest('[data-spchip]')) return SpendUI.open();
      const sr = e.target.closest('[data-sreq]');
      if (sr) { const r = (d.shop_recent || []).concat(d.shop_open || []).find(x => x.id === sr.dataset.sreq); if (r) PAGES.shophist.detail(r); return; }
      const g = e.target.closest('[data-go]'); if (g) { if (g.dataset.go === 'shop') PAGES.shop.view = 'shop'; return App.go(g.dataset.go, g.dataset.f ? { filter: g.dataset.f } : {}); }
      const bf = e.target.closest('[data-act="backfill"]'); if (bf) return App.go('entry', { date: bf.dataset.day || Shift.workDays(d.missing_days)[0] || d.missing_days[0] });
      const o = e.target.closest('[data-order]'); if (o) { e.stopPropagation(); return OrderUI.form(o.dataset.order === 'new' ? {} : { material_id: +o.dataset.order }); }
      const r = e.target.closest('[data-oid]'); if (r) return OrderUI.detail(r.dataset.oid);
    };
    NoteUI.bind(el.querySelector('.cc'), d.notes || [], () => this.render(el));
    StockFix.bind(el, d, () => this.render(el));
    const mrDraw = () => { const c = el.querySelector('.mr-card'); if (c) { c.outerHTML = MyReq.html(d); MyReq.bind(el, mrDraw); } };
    MyReq.bind(el, mrDraw);
    Notif.bind(el.querySelector('.cc'), d, () => App.refresh());
    SpendUI.mount(el.querySelector('#spcard'));
    requestAnimationFrame(() => el.querySelector('.cc')?.classList.add('in'));
    // progress lines grow after the cards are in place
    setTimeout(() => $$('.sreq .trk', el).forEach(t => t.classList.add('go')), 260);
  },

  /* ---------------- who requested what (HRM Shopping) — progress timeline per request ---------------- */
  shopReq(d) {
    const list = d.shop_recent || [];
    const ago = s => {
      const t = new Date(s.replace(' ', 'T')), m = Math.max(0, Math.round((Date.now() - t) / 60000));
      return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : m < 1440 ? `${Math.round(m / 60)} ชม.ที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`;
    };
    const rows = list.map((r, i) => {
      const items = r.items || [];
      const sum = items.slice(0, 3).map(x => `${itemText(x)} ×${fmtQty(x.qty)}`).join(' · ') + (items.length > 3 ? ` · +${items.length - 3}` : '');
      return `<article class="sreq ${r.status}" data-sreq="${esc(r.id)}" style="--i:${i}">
        <div class="sreq-who">${People.avatar(r.requester, 40)}
          <div><b>${esc(r.requester)}</b><span>${ago(r.created_at)} · ${esc(r.id)}</span></div></div>
        <div class="sreq-items"><span class="pics">${items.slice(0, 4).map(x => shopPic(x.art, 34)).join('')}</span><span class="txt" title="${esc(items.map(x => itemText(x) + ' ×' + fmtQty(x.qty)).join(' · '))}">${esc(sum)}</span></div>
        ${shopTrack(r)}
      </article>`;
    }).join('');
    return `<section class="cc-card sreq-card">
      <header class="sreq-h">${sticker('shopbag', 30)}<div>${bi('ใครสั่งอะไรไปบ้าง', 'SUPPLY REQUESTS · LAST 14 DAYS')}</div>${list.length ? `<span class="count-chip">${list.length}</span>` : ''}
        <span class="grow"></span><button class="btn btn-ghost sm" data-go="shophist">ดูทั้งหมด ${ic('arrowR', 'sm')}</button><button class="btn btn-tonal sm" data-go="shop">${ic('plus', 'sm')}ขอสั่งซื้ออุปกรณ์</button></header>
      ${list.length ? `<div class="sreq-list">${rows}</div>` : `<div class="sreq-empty">${sticker('shopbag', 44)}<div><b>ยังไม่มีคำขอสั่งซื้อในช่วง 14 วัน</b><span>เมื่อมีคนขอสั่งของ จะเห็นความคืบหน้าที่นี่ — สั่งแล้ว › รับคำสั่ง › รอจัดส่ง › จัดส่งสำเร็จ</span></div></div>`}
    </section>`;
  },

  /* ---------------- announcements from Officer ---------------- */
  notes(d) {
    const all = d.notes || [], vis = NoteUI.visible(all), hiddenN = all.length - vis.length;
    if (!all.length && !App.officer) return '';
    const run = vis.filter(n => NoteUI.st(n).mode === 'marquee'), cards = vis.filter(n => NoteUI.st(n).mode !== 'marquee');
    const unseen = vis.some(n => n.id > NoteUI.ackId());
    const soon = App.officer ? all.filter(n => { const l = NoteUI.left(n); return l !== null && l <= 2; }) : [];
    if (!cards.length && !run.length && !App.officer) return '';
    return `${NoteUI.marquee(run)}<section class="nb">
      <div class="nb-bar"><span class="lbl">${sticker('megaphone', 26)}ประกาศ <span class="en">Announcements</span>${vis.length ? `<span class="count-chip">${vis.length}</span>` : ''}</span>
        ${soon.length ? `<span class="nb-soon">${ic('clock', 'sm')}${soon.map(n => `${esc(n.title || n.body.slice(0, 18))} หมดอายุ${NoteUI.left(n) <= 0 ? 'วันนี้' : `ในอีก ${NoteUI.left(n)} วัน`}`).join(' · ')}</span>` : ''}
        <span class="grow"></span>
        ${hiddenN ? `<button class="link" data-note-unhide>แสดงที่ปิดไว้ ${hiddenN}</button>` : ''}
        ${unseen ? `<button class="btn btn-plain sm" data-note-ack>${ic('check', 'sm')}รับทราบ</button>` : ''}
        ${App.officer ? `<button class="btn btn-tonal sm" data-note-new>${ic('plus', 'sm')}เขียนประกาศ</button>` : ''}</div>
      ${cards.length ? `<div class="nb-grid">${NoteUI.html(cards, { manage: true })}</div>` : ''}
    </section>`;
  },

  /* ---------------- hero ---------------- */
  hero(d, g) {
    const T = d.today, dt0 = pd(T), s = d.summary;
    const names = (arr, f = x => x.material?.name || x.name) => {
      if (!arr.length) return '<span class="cc-none">—</span>';
      const n = arr.slice(0, 2).map(x => esc(f(x))).join(', ');
      return n + (arr.length > 2 ? ` <span class="cc-more">+${arr.length - 2}</span>` : '');
    };
    // the one sentence that matters most right now
    let head, sub, tone;
    if (g.overdue.length) { tone = 'need'; head = `มี ${g.overdue.length} รายการเกินกำหนดส่ง`; sub = `ติดตาม Supplier: ${g.overdue.slice(0, 3).map(o => esc(o.material.name)).join(', ')}`; }
    else if (s.need_order) { tone = 'need'; head = `${s.need_order} รายการถึงจุดสั่งซื้อแล้ว`; sub = App.officer ? 'สร้างใบสั่งซื้อได้จากแผง ระดับสต็อก ด้านขวา' : 'แจ้ง Officer เพื่อสั่งซื้อ'; }
    else if (d.deliveries_today.length) { tone = 'sched'; head = `วันนี้มีของเข้า ${d.deliveries_today.length} รายการ`; sub = 'บันทึกรับที่หน้า รับสินค้า เมื่อของมาถึง'; }
    else if (g.waitDate.length) { tone = 'ordered'; head = `${g.waitDate.length} ใบสั่งยังไม่มีกำหนดส่ง`; sub = 'ใส่กำหนดส่งเมื่อ Supplier ยืนยัน'; }
    else { tone = 'ok'; head = 'สต็อกอยู่ในระดับปกติ'; sub = 'ไม่มีรายการที่ต้องจัดการเร่งด่วน'; }

    const missD = Shift.workDays(d.missing_days), miss = missD.length;
    // who is on shift (ทีม A/B/C) — reminders name the team that still has to record
    const tT = Shift.teamOn(T), late = !d.today_recorded && Shift.late(), off = !Shift.works(T);
    const rec = !d.today_recorded && off
      ? `<span class="cc-stat off"><i></i>วันนี้ไม่มีกะเช้า${Shift.note(T) ? ' · ' + esc(Shift.note(T)) : ''} · ไม่ต้องลง STOCK</span>`
      : d.today_recorded
      ? `<span class="cc-stat ok"><i></i>บันทึก STOCK วันนี้แล้ว · ${esc(d.today_ops || '')}${d.today_saved_at ? ' · ' + fmtTime(d.today_saved_at) : ''}${tT ? ' · ทีม ' + Shift.label(tT) : ''}</span>`
      : `<button class="cc-stat ${late ? 'need pulse' : 'warn'} link" data-go="entry" title="${tT ? 'กะวันนี้: ' + esc(Shift.members(tT).join(', ')) : ''}"><i></i>${tT ? `ทีม ${Shift.label(tT)} ยังไม่ลง STOCK วันนี้` : 'ยังไม่บันทึก STOCK วันนี้'}${late ? ` · เลย ${Shift.remindAt()} แล้ว` : ''} ${ic('arrowR', 'sm')}</button>`;
    const groups = Shift.active() ? Shift.missingByTeam(missD) : [];
    const missH = !miss ? '' : groups.length
      ? groups.map(g => `<button class="cc-stat need link" data-act="backfill" data-day="${g.days[0]}" title="${g.days.map(fmtDShort).join(', ')}"><i></i>${g.team ? `ทีม ${Shift.label(g.team)}` : 'ไม่มีทีม'} ค้าง ${g.days.length} วัน ${ic('arrowR', 'sm')}</button>`).join('')
      : `<button class="cc-stat need link" data-act="backfill"><i></i>ค้างบันทึก ${miss} วัน ${ic('arrowR', 'sm')}</button>`;
    const p = d.pending;
    const pendH = App.officer && (p.receipts + p.days + p.docs + p.materials)
      ? `<span class="cc-stat off"><i></i>รอ Officer: ${[p.receipts && `<a data-go="delivery">ยืนยันรับของ ${p.receipts}</a>`, p.days && `<a data-go="entry">ยืนยันวัน ${p.days}</a>`, p.docs && `<a data-go="docs">ตรวจเอกสาร ${p.docs}</a>`, p.materials && `<a data-go="master">อนุมัติ Material ${p.materials}</a>`].filter(Boolean).join(' · ')}</span>` : '';

    const act = (id, icon, th, en, primary) => `<button class="cc-act ${primary ? 'primary' : ''}" data-go="${id}">${art(icon, 34)}<span class="bi"><span class="th">${th}</span><span class="en">${en}</span></span></button>`;
    const stage = (key, n, th, en, cls, list, go, extra = '') => `
      <button class="cc-stage ${n ? '' : 'zero'}" style="--c:var(--cc-${cls})" data-go="${go}" data-f="${key}">
        <span class="cc-bar"></span>
        <span class="cc-num num">${n}</span>
        <span class="cc-lbl"><span class="th">${th}</span><span class="en">${en}</span>${extra}</span>
        <span class="cc-names">${list}</span>
      </button>`;

    return `<section class="cc-hero">
      <div class="cc-hero-top">
        <div class="cc-msg">
          <div class="cc-eyebrow">${TH_WD[dt0.getDay()]} ${dt0.getDate()} ${TH_MF[dt0.getMonth()]} ${dt0.getFullYear()} <span>· ${EN_WD[dt0.getDay()]} ${fmtDEn(T)}</span></div>
          <h1 class="cc-head tone-${tone}"><i></i>${head}</h1>
          <div class="cc-sub">${sub}</div>
          <div class="cc-stats">${rec}${missH}${pendH}</div>
        </div>
        ${SpendUI.heroTile()}
        <div class="cc-acts">
          ${act('entry', 'entry', 'กรอก STOCK', 'Stock entry', true)}
          ${act('orders', 'order', 'สั่งซื้อ', 'Order')}
          ${act('delivery', 'truck', 'รับสินค้า', 'Delivery')}
          ${act('docs', 'a3', 'เอกสาร A3', 'Document')}
        </div>
      </div>
      <div class="cc-pipe">
        ${stage('need', s.need_order, 'ต้องสั่ง', 'Need order', 'need', names(d.need_order, x => x.name), 'stock')}
        ${stage('ordered', s.ordered, 'สั่งแล้ว', 'Ordered', 'ordered', names(g.waitDate), 'orders')}
        ${stage('waiting', s.waiting, 'รอส่ง', 'Waiting delivery', 'sched', names(g.waiting), 'orders', s.overdue ? `<span class="cc-flag">เกินกำหนด ${s.overdue}</span>` : '')}
        ${stage('received', s.received, 'รับแล้ว', `Received · ${EN_M[dt0.getMonth()]}`, 'ok', names(g.received), 'orders')}
      </div>
    </section>`;
  },

  /* ---------------- order timeline ---------------- */
  timeline(d, open, received) {
    const T = d.today, B = this.RANGE_BACK, F = this.RANGE_FWD, N = B + F + 1;
    const start = addDays(T, -B);
    const x = ds => { const i = dayDiff(ds, start); return Math.max(0, Math.min(100, (i + 0.5) / N * 100)); };
    const before = ds => dayDiff(ds, start) < 0;
    const tX = x(T);
    // weekend shading shared by axis + every lane
    const stops = [];
    for (let i = 0; i < N; i++) {
      const wd = pd(addDays(start, i)).getDay();
      if (wd === 0 || wd === 6) stops.push(`var(--cc-wk) ${(i / N * 100).toFixed(3)}% ${((i + 1) / N * 100).toFixed(3)}%`);
    }
    const wk = stops.length ? `linear-gradient(90deg,${stops.map(s => `transparent 0 0,${s}`).join(',')},transparent 0)` : 'none';
    const rows = [...open, ...received.slice(0, Math.max(0, 7 - open.length))].slice(0, 7);

    let axis = '';
    for (let i = 0; i < N; i++) {
      const ds = addDays(start, i), dd = pd(ds).getDate(), isT = ds === T;
      if (isT) continue;
      if (Math.abs(i - B) <= 1) continue; // keep room for the today pill
      if ((i - B) % 2 && dd !== 1) continue; // every other day keeps the axis calm
      axis += `<span class="cc-tick ${dd === 1 ? 'm' : ''}" style="left:${((i + 0.5) / N * 100).toFixed(2)}%">${dd === 1 ? TH_M[pd(ds).getMonth()] : dd}</span>`;
    }
    axis += `<span class="cc-today-pill" style="left:${tX}%">วันนี้ ${pd(T).getDate()}</span>`;

    const lane = o => {
      const cls = { overdue: 'need', waiting_date: 'ordered', requested: 'ordered', today: 'sched', scheduled: 'sched', received: 'ok' }[o.status] || 'sched';
      const oX = x(o.order_date), cut = before(o.order_date);
      let marks = '';
      const seg = (a, b, kind) => b > a ? `<i class="cc-seg ${kind}" style="left:${a}%;width:${b - a}%"></i>` : '';
      if (o.status === 'received') {
        const e = x(o.done_date || T);
        marks += seg(oX, e, 'solid') + `<i class="cc-dot fill" style="left:${e}%"></i>`;
      } else if (o.status === 'overdue') {
        const e = x(o.expected_date);
        marks += seg(oX, e, 'solid') + seg(e, tX, 'late') + `<i class="cc-dot ring" style="left:${e}%"></i>`;
      } else if (o.status === 'waiting_date' || o.status === 'requested') {
        marks += seg(oX, tX, 'solid') + `<i class="cc-seg fade" style="left:${tX}%;width:${100 - tX}%"></i><i class="cc-dot pulse" style="left:${tX}%"></i>`;
      } else {
        const e = x(o.expected_date);
        marks += seg(oX, tX, 'solid') + seg(tX, e, 'dash') + `<i class="cc-dot ${o.status === 'today' ? 'fill' : 'ring'}" style="left:${e}%"></i>`;
      }
      marks = `<i class="cc-start ${cut ? 'cut' : ''}" style="left:${oX}%"></i>` + marks;

      let th, en;
      if (o.status === 'overdue') { const n = -dayDiff(o.expected_date, T); th = `เกินกำหนด ${n} วัน`; en = `OVERDUE · ${fmtDEn(o.expected_date)}`; }
      else if (o.status === 'requested') { th = 'ขอสั่งแล้ว — รอ Officer สั่งซื้อ'; en = `REQUESTED${o.requested_by ? ' · ' + o.requested_by : ''}`; }
      else if (o.status === 'waiting_date') { th = 'สั่งแล้ว — รอกำหนดส่ง'; en = `ORDERED ${fmtDEn(o.order_date)} · NO DATE`; }
      else if (o.status === 'today') { th = 'ส่งวันนี้'; en = 'DELIVERY TODAY'; }
      else if (o.status === 'scheduled') { th = `กำหนดส่ง ${fmtD(o.expected_date)}`; en = relDay(o.expected_date, T)[1]; }
      else { th = `รับเข้าแล้ว ${fmtDShort(o.done_date)}`; en = 'RECEIVED'; }
      const part = o.partial ? `<span class="cc-part num">รับแล้ว ${fmtN(o.received_qty)} / ${fmtN(o.ordered_qty)}</span>` : '';
      return `<div class="cc-lane" style="--c:var(--cc-${cls})" data-oid="${o.id}">
        <div class="cc-mat-w">${mpic(o.material, 36)}<div class="cc-mat"><span class="th" title="${esc(o.material.name)}">${esc(o.material.name)}</span><span class="en">${esc(o.id)}</span></div></div>
        <div class="cc-qty num">${fmtN(o.ordered_qty)}<span>${esc(o.material.unit)}</span></div>
        <div class="cc-track" style="background-image:${wk}"><i class="cc-now" style="left:${tX}%"></i>${marks}</div>
        <div class="cc-st"><span class="th">${th}</span><span class="en">${en}</span>${part}</div>
      </div>`;
    };

    const head = `<header class="cc-h"><div><h2>รายการสั่งซื้อ</h2><span class="en">Order overview · ${d.orders_total} open</span></div>
      <span class="grow"></span>
      <div class="cc-legend"><span><i class="l-solid"></i>สั่งแล้ว</span><span><i class="l-dash"></i>รอส่ง</span><span><i class="l-late"></i>เกินกำหนด</span></div>
      ${App.officer ? `<button class="btn btn-tonal sm" data-order="new">${ic('plus', 'sm')}สร้างใบสั่งซื้อ</button>` : ''}</header>`;

    if (!rows.length) return head + emptyState('order', 'ยังไม่มีรายการสั่งซื้อ', 'NO ORDERS YET',
      d.summary.need_order ? `มี ${d.summary.need_order} รายการถึงจุดสั่งซื้อแล้ว — ${App.officer ? 'กด สร้างใบสั่งซื้อ ได้เลย' : 'แจ้ง Officer เพื่อสั่งซื้อ'}` : 'เมื่อ Officer สร้างใบสั่งซื้อ รายการจะแสดงที่นี่ทันที', '', true);

    return head + `
      <div class="cc-tl">
        <div class="cc-lane cc-axisrow"><div class="cc-colh">Material</div><div class="cc-colh r">สั่ง</div><div class="cc-axis" style="background-image:${wk}">${axis}</div><div class="cc-colh">สถานะ</div></div>
        ${rows.map(lane).join('')}
      </div>
      <footer class="cc-foot"><span class="faint">ช่วง ${fmtDShort(start)} – ${fmtDShort(addDays(T, F))} · คลิกแถวเพื่อดูรายละเอียด</span><span class="grow"></span>
        <button class="link" data-go="orders">ดูรายการทั้งหมด ${ic('arrowR', 'sm')}</button></footer>`;
  },

  /* ---------------- today ---------------- */
  today(d) {
    const T = d.today, list = d.deliveries_today, got = d.received_today;
    const next = (d.open_orders || []).filter(o => o.status === 'scheduled').sort((a, b) => a.expected_date.localeCompare(b.expected_date))[0];
    const rows = list.map(o => `<div class="cc-row" data-oid="${o.id}" style="--c:var(--cc-sched)"><i class="cc-pip"></i>${mpic(o.material, 34)}
        <span class="cc-rname">${esc(o.material.name)}</span><span class="cc-rv num">${fmtN(o.remaining_qty)}<span>${esc(o.material.unit)}</span></span></div>`).join('')
      + got.map(r => `<div class="cc-row" style="--c:var(--cc-ok)"><i class="cc-pip"></i>${mpic(r.material, 34)}
        <span class="cc-rname">${esc(r.material.name)} <span class="cc-tag">รับแล้ว</span></span><span class="cc-rv num">${fmtN(r.qty)}<span>${esc(r.material.unit)}</span></span></div>`).join('');
    return `<header class="cc-h"><div><h2>กำหนดส่งวันนี้</h2><span class="en">Deliveries today</span></div><span class="grow"></span>
        <span class="cc-big num ${list.length ? '' : 'zero'}">${list.length}<small>รายการ</small></span></header>
      ${rows ? `<div class="cc-rows">${rows}</div>${list.length ? `<button class="btn btn-tonal sm cc-wide" data-go="delivery">${ic('inbox', 'sm')}บันทึกรับสินค้า</button>` : ''}`
        : `<div class="cc-empty">${ic('truck')}<div><b>วันนี้ไม่มีรายการจัดส่ง</b><span>No deliveries today</span>${next ? `<span class="cc-next">ส่งถัดไป · ${esc(next.material.name)} · ${fmtD(next.expected_date)}</span>` : ''}</div></div>`}`;
  },

  /* ---------------- stock level health ---------------- */
  levels(d) {
    const L = d.levels || [], n = L.length || 1;
    const below = L.filter(m => m.ratio <= 1).length, near = L.filter(m => m.ratio > 1 && m.ratio <= 1.5).length, ok = L.length - below - near;
    const top = L.slice(0, 5);
    const row = m => {
      const cls = m.ratio <= 1 ? 'need' : m.ratio <= 1.5 ? 'ordered' : 'ok';
      const w = Math.min(100, m.ratio / 2 * 100);
      const state = m.state === 'on_order' ? '<span class="cc-tag">สั่งแล้ว</span>' : (m.state === 'need_order' && App.officer ? `<button class="cc-mini" data-order="${m.id}">${ic('plus', 'sm')}สั่ง</button>` : '');
      return `<div class="cc-lv" style="--c:var(--cc-${cls})">
        <div class="cc-lv-top">${mpic(m, 30)}<span class="cc-rname">${esc(m.name)}</span>${state}${qeBtn(m.id)}<span class="cc-rv num">${fmtN(m.balance)}<span>/ ${fmtN(m.reorder_point)} ${esc(m.unit)}</span></span></div>
        <div class="cc-meter"><i style="width:${w}%"></i><b></b></div></div>`;
    };
    return `<header class="cc-h"><div><h2>ระดับสต็อก</h2><span class="en">Stock level · ${L.length} materials</span></div><span class="grow"></span>
        <button class="link" data-go="stock">ทั้งหมด ${ic('arrowR', 'sm')}</button></header>
      <div class="cc-mix">
        <i style="flex:${below};--c:var(--cc-need)"></i><i style="flex:${near};--c:var(--cc-ordered)"></i><i style="flex:${ok};--c:var(--cc-ok)"></i>
      </div>
      <div class="cc-mixl"><span style="--c:var(--cc-need)"><i></i>ต่ำกว่าจุดสั่ง <b class="num">${below}</b></span><span style="--c:var(--cc-ordered)"><i></i>ใกล้จุดสั่ง <b class="num">${near}</b></span><span style="--c:var(--cc-ok)"><i></i>ปกติ <b class="num">${ok}</b></span></div>
      <div class="cc-sublbl">ต่ำสุด 5 รายการ <span>· เส้นกลาง = จุดสั่งซื้อ</span></div>
      <div class="cc-lvs">${top.map(row).join('')}</div>`;
  },
};

/* ===== shop.js ===== */
/* =====================================================================
   HRM SHOPPING — Purchase Request (separate menu from stock control)
   Manual input → search → category accordions → cart → checkout → confirmation → history
   Requests are saved to the shared database (Officer sees them in ประวัติคำขอ).
   The UI never says the request has reached Purchasing.
   ===================================================================== */
'use strict';

const Cart = {
  key: 'shopCart',
  load() { try { return JSON.parse(localStorageGet(this.key) || '[]'); } catch (e) { return []; } },
  save(c) { localStorageSet(this.key, JSON.stringify(c)); App.updateShopBadge && App.updateShopBadge(); },
  norm: s => String(s || '').toLowerCase().replace(/\s+/g, ''),
  key(x) { return this.norm(x.name) + '|' + this.norm(x.spec); },
  add(item, step = 1) {   // {name, cat, art, unit, item_id, spec}  — same name + same colour/spec → one line
    const c = this.load();
    const hit = c.find(x => this.key(x) === this.key(item));
    if (hit) hit.qty = (+hit.qty || 0) + step;
    else c.push({ uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), qty: step, ...item });
    this.save(c);
    return { cart: c, merged: !!hit };
  },
  count() { return this.load().length; },
};
const shopArt = a => (typeof SHOP_ART !== 'undefined') ? (SHOP_ART[a] || SHOP_ART.custom) : `img/shop/${a || 'custom'}.svg`;
const shopPic = (a, size, cls = '') => String(a || '').startsWith('emoji:')
  ? `<span class="spic emo ${cls}" style="--s:${size}px" role="img">${esc(String(a).slice(6))}</span>`
  : `<img class="spic ${cls}" src="${shopArt(a)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`;
/* pictures the Officer can pick for a catalogue item: our hand-drawn set + emoji */
const SHOP_ART_KEYS = ['absorb-pad', 'absorb-sock', 'air-gun', 'air-hose', 'bag-black', 'bag-red', 'broom', 'brush-flat', 'cleaner-gallon', 'cleaner-spray', 'cloth-tape',
  'dust-cloth', 'dust-liquid', 'dustpan', 'floor-paint', 'label-ink', 'label-paper', 'lacquer-tape', 'mop', 'nail-glue', 'pen', 'rag-color', 'rag-white', 'roller-l',
  'roller-s', 'shampoo', 'shower-cream', 'silicone', 'sling-l', 'sling-s', 'squeegee', 'tape-measure', 'wall-paint', 'glove-white', 'custom'];
const SHOP_EMOJI = ['🧹', '🧽', '🧴', '🧼', '🧻', '🪣', '🧺', '🗑️', '🧤', '🥽', '🦺', '⛑️', '👢', '😷', '🔧', '🔨', '🪛', '🪚', '🔩', '⚙️', '🧰', '🪜', '🧲', '🔦',
  '📏', '📐', '✂️', '🖊️', '✏️', '🖍️', '📎', '📌', '🏷️', '📦', '🧾', '📋', '🛢️', '🧪', '💡', '🔋', '🔌', '🧯', '🧵', '🪢', '🎨', '🖌️', '🧷', '🩹', '💧', '🧊', '☕', '🥤', '👕', '🧦'];
const fmtQty = q => fmtN(+q);
/** item name with its colour / spec — "เทปกาวแลคซีน (สีแดง)" */
const itemText = x => x.spec ? `${x.name} (${x.spec})` : x.name;
const specChip = x => x.spec ? `<span class="spec-chip">${esc(x.spec)}</span>` : '';
/** item code PR-HRM{หมวด}-{ลำดับในหมวด} — e.g. PR-HRM01-01 = ปากกาเขียน Liner (category order, then item order) */
const ShopCode = {
  map: null,
  build(cat) { const m = {}, p2 = n => String(n).padStart(2, '0'); (cat?.cats || []).forEach((c, i) => (c.items || []).forEach((it, j) => { m[it.id] = it.code || `PR-HRM${p2(i + 1)}-${p2(j + 1)}`; })); this.map = m; return m; },   // stored code (locked) — position only as a fallback
  of(x) { const id = x && typeof x === 'object' ? (x.item_id ?? null) : x; return (this.map && id !== null && id !== undefined && this.map[id]) || ''; },
  tag(x, cls = '') { if (!this.map) return ''; const c = this.of(x); return c ? `<span class="icode ${cls}">${c}</span>` : `<span class="icode none ${cls}">พิมพ์เอง</span>`; },
  async ensure() { if (!this.map) this.build(PAGES.shop.cat || await api('shop_catalog')); return this.map; },
};
/** requester name as a coloured pill — the same person always gets the same colour */
const WHO_HUES = [212, 158, 28, 276, 338, 190, 118, 8, 244, 48];
const whoPill = (n, cls = '') => { const t = String(n || '-'); let h = 0; for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = typeof People !== 'undefined' ? People.hue(t) : WHO_HUES[h % WHO_HUES.length];   // same colour as the person's avatar
  return `<span class="who-pill ${cls}" style="--wh:${hue}">${esc(t)}</span>`; };
const SWATCH = { 'แดง': '#D63B3B', 'ขาว': '#F6F5EF', 'เหลือง': '#F2C230', 'น้ำเงิน': '#2350B5', 'เขียว': '#2F9D5B', 'น้ำตาล': '#8B5A34', 'เทา': '#8D949B', 'ดำ': '#26282B' };
/* request progress: สั่งแล้ว → รับคำสั่ง → รอจัดส่ง → จัดส่งสำเร็จ */
const SHOP_FLOW = [['saved', 'สั่งแล้ว', 'ORDERED', 'order'], ['acknowledged', 'รับคำสั่ง', 'ACCEPTED', 'check'], ['ordered', 'รอจัดส่ง', 'SHIPPING', 'truck'], ['delivered', 'จัดส่งสำเร็จ', 'DELIVERED', 'received']];
/** generic 4-step progress: สั่งแล้ว › รับคำสั่ง › รอจัดส่ง › จัดส่งสำเร็จ
    idx = current step (0–3) · when = {0..3: datetime} · due = วันที่ของจะมาส่ง (shown on the รอจัดส่ง step) */
function flowTrack(idx, { when = {}, due = null, late = false, cls = '' } = {}) {
  const done = idx >= 3;
  const t = s => s ? `<span title="${fmtD(s)}${s.length > 10 ? ' ' + fmtTime(s) : ''}">${fmtD(s)}</span>` : '';
  return `<div class="trk ${done ? 'done' : ''} ${late ? 'late' : ''} ${cls}" style="--p:${Math.min(3, idx) / 3 * 100}%"><div class="trk-line"><i></i></div>${SHOP_FLOW.map(([k, th, en, icn], i) => {
    const st = i <= idx ? 'ok' : i === idx + 1 ? 'cur' : '';
    let sub = st === 'ok' && when[i] ? t(when[i]) : en;
    if (i === 2 && due && !done) sub = `<span class="due ${late ? 'late' : ''}">${late ? 'เลย ' : 'ส่ง '}${fmtD(due)}</span>`;
    if (i === 3 && done && when[3]) sub = t(when[3]);
    return `<div class="trk-st ${st}" style="--d:${(i * .22).toFixed(2)}s"><span class="dot">${st === 'ok' ? ic(i === 3 ? 'check' : icn, 'sm') : st === 'cur' ? '<i></i>' : ''}</span><b>${th}</b><small>${sub}</small></div>`;
  }).join('')}</div>`;
}
function shopTrack(r, cls = '') {
  if (r.status === 'cancelled') return `<div class="trk-cancel">${ic('ban', 'sm')}ยกเลิกคำขอ${r.status_note ? ' · ' + esc(r.status_note) : ''}</div>`;
  const idx = Math.max(0, SHOP_FLOW.findIndex(f => f[0] === r.status));
  const when = {}; (r.history || []).forEach(h => { const i = SHOP_FLOW.findIndex(f => f[0] === h.status); if (i >= 0) when[i] = h.at; });
  if (!when[0]) when[0] = r.created_at;
  return flowTrack(idx, { when, due: r.expected_date, late: !!(r.expected_date && idx < 3 && r.expected_date < App.today), cls });
}
/** material purchase order on the same 4 steps: สั่งแล้ว (ยังไม่มีวันส่ง) › รับคำสั่ง (Supplier ให้วันส่ง) › รอจัดส่ง (ถึงกำหนด / รับบางส่วน) › จัดส่งสำเร็จ */
function orderTrack(o, cls = '') {
  if (o.status === 'cancelled') return `<div class="trk-cancel">${ic('ban', 'sm')}ยกเลิกใบสั่งซื้อ</div>`;
  // สั่งแล้ว (ขอสั่ง) › รับคำสั่ง (Officer สั่งซื้อแล้ว) › รอจัดส่ง (มีวันส่ง / ถึงกำหนด / รับบางส่วน) › จัดส่งสำเร็จ
  const idx = o.status === 'received' ? 3 : o.status === 'requested' ? 0 : o.status === 'waiting_date' && !o.partial ? 1 : 2;
  return flowTrack(idx, { when: { 0: o.order_date, 3: o.done_date }, due: o.expected_date, late: o.status === 'overdue', cls });
}
/** delivery-date cell used by both lanes */
function dueCell(date, { done = false, doneDate = null } = {}) {
  if (done) return `<div class="due-c ok"><b>${doneDate ? fmtD(doneDate) : 'ส่งแล้ว'}</b><span>จัดส่งสำเร็จ</span></div>`;
  if (!date) return `<div class="due-c none"><b>—</b><span>ยังไม่มีกำหนดส่ง</span></div>`;
  const n = Math.round((pd(date) - pd(App.today)) / 864e5);
  const tone = n < 0 ? 'late' : n === 0 ? 'today' : n <= 2 ? 'soon' : '';
  return `<div class="due-c ${tone}"><b>${fmtD(date)}</b><span>${n < 0 ? `เลยกำหนด ${-n} วัน` : n === 0 ? 'ส่งวันนี้' : `อีก ${n} วัน`}</span></div>`;
}

function requestText(r) {
  const d = pd(r.created_at.slice(0, 10));
  return [`คำขอสั่งซื้อ ${r.id}`, `วันที่ ${fmtD(r.created_at)} ${fmtTime(r.created_at)}`, `ผู้ขอสั่งซื้อ ${r.requester}`, '',
    ...r.items.map((it, i) => `${i + 1}. ${itemText(it)} — ${fmtQty(it.qty)} ${it.unit}`),
    ...(r.note ? ['', `หมายเหตุ: ${r.note}`] : [])].join('\n');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { }
  const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
  ta.remove(); return ok;
}
/* ---------- printable forms (A4) — modern, light ink, readable in black & white ---------- */
const SHOP_FORM_CSS = `
  @font-face{font-family:"HRM Thai";font-weight:400;src:url(__FONTS__noto-sans-thai-looped-thai-400-normal.woff2)}
  @font-face{font-family:"HRM Thai";font-weight:700;src:url(__FONTS__noto-sans-thai-looped-thai-700-normal.woff2)}
  *{box-sizing:border-box} body{font-family:"Leelawadee UI","HRM Thai",Tahoma,sans-serif;color:#1b2230;font-size:10.5pt;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .mono{font-family:Consolas,"Courier New",monospace}
  .hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:2pt solid #1b2230}
  .brand{display:flex;gap:12px;align-items:center} .logo{width:40px;height:40px;border-radius:12px;background:#2350B5;color:#fff;display:grid;place-items:center;font-weight:700;font-size:13pt}
  .brand h1{font-size:19pt;margin:0;line-height:1.1} .brand small{display:block;font-size:8.5pt;letter-spacing:.14em;color:#6b7686;margin-top:3px}
  .rid{text-align:right} .rid .mono{display:inline-block;font-size:15pt;font-weight:700;padding:5px 12px;border:1.5pt solid #1b2230;border-radius:9px}
  .rid small{display:block;font-size:8.5pt;color:#6b7686;margin-top:5px}
  .tiles{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:8px;margin:14px 0 12px}
  .tile{border:.8pt solid #cfd6e0;border-radius:10px;padding:8px 11px} .tile span{display:block;font-size:8pt;color:#6b7686;letter-spacing:.04em} .tile b{font-size:12.5pt}
  .tile.who b{font-size:15pt}
  .steps{display:grid;grid-template-columns:repeat(4,1fr);margin:4px 0 14px;position:relative}
  .steps:before{content:"";position:absolute;left:12.5%;right:12.5%;top:8px;height:2pt;background:#d5dbe3}
  .steps .bar{position:absolute;left:12.5%;top:8px;height:2pt;background:#2350B5}
  .st{display:grid;justify-items:center;gap:3px;position:relative;font-size:9pt;text-align:center} .st i{width:18px;height:18px;border-radius:50%;border:2pt solid #c3cbd6;background:#fff}
  .st.ok i{background:#2350B5;border-color:#2350B5} .st.cur i{border-color:#2350B5;box-shadow:0 0 0 3px #dbe5fb} .st b{font-size:9.5pt} .st small{color:#6b7686;font-size:8pt}
  table{width:100%;border-collapse:separate;border-spacing:0} th{font-size:8.5pt;font-weight:700;color:#4a5566;text-align:left;padding:7px 9px;background:#eef2f7;border-bottom:.8pt solid #c3cbd6}
  th:first-child{border-radius:8px 0 0 0} th:last-child{border-radius:0 8px 0 0}
  td{padding:8px 9px;border-bottom:.6pt solid #e2e7ee;vertical-align:middle} tr:nth-child(even) td{background:#fafbfd}
  .c{text-align:center;width:30px;color:#6b7686} .r{text-align:right} .code{width:104px;white-space:nowrap;font-size:9pt;font-weight:700;color:#2350B5} th{white-space:nowrap}
  .nm b{font-size:11pt} .nm small{display:block;color:#5b6676;font-size:8.5pt} .qty{font-size:13pt;font-weight:700;width:64px} .unit{width:60px} .chk{width:40px;text-align:center}
  .chk i{display:inline-block;width:14px;height:14px;border:1pt solid #8a95a6;border-radius:4px}
  .blank td{height:30px}
  .note{margin-top:12px;border:.8pt solid #cfd6e0;border-radius:10px;padding:9px 11px;min-height:52px} .note span{font-size:8pt;color:#6b7686;display:block}
  .sig{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:26px} .sig div{border:.8pt solid #cfd6e0;border-radius:10px;padding:10px 12px 8px;text-align:center;font-size:9.5pt}
  .sig .ln{height:38px;border-bottom:.8pt dotted #1b2230;margin-bottom:6px} .sig small{display:block;color:#6b7686;font-size:8pt;margin-top:3px}
  .ft{display:flex;justify-content:space-between;margin-top:14px;font-size:8pt;color:#8a95a6}
  .kpi{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:14px 0} .kpi div{border:.8pt solid #cfd6e0;border-radius:10px;padding:8px 10px} .kpi span{display:block;font-size:8pt;color:#6b7686} .kpi b{font-size:16pt}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;border:.8pt solid #9aa5b5;font-size:8.5pt;font-weight:700}
  .items{font-size:9.5pt;line-height:1.5} .items .mono{color:#2350B5;font-size:8.5pt;font-weight:700}
`;
function shopFormDoc(title, body, landscape = false) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:12mm}${SHOP_FORM_CSS}</style></head><body>${body}
  <script>window.addEventListener('load',()=>document.fonts.ready.then(()=>setTimeout(()=>window.print(),300)))</script></body></html>`;
}
function printRequest(r) {
  const idx = Math.max(0, SHOP_FLOW.findIndex(f => f[0] === r.status)), when = {};
  (r.history || []).forEach(h => { const i = SHOP_FLOW.findIndex(f => f[0] === h.status); if (i >= 0) when[i] = h.at; });
  if (!when[0]) when[0] = r.created_at;
  const cancelled = r.status === 'cancelled';
  const steps = SHOP_FLOW.map(([k, th], i) => `<div class="st ${!cancelled && i <= idx ? 'ok' : !cancelled && i === idx + 1 ? 'cur' : ''}"><i></i><b>${th}</b><small>${when[i] ? fmtD(when[i]) : i === 2 && r.expected_date ? 'กำหนดส่ง ' + fmtD(r.expected_date) : '—'}</small></div>`).join('');
  const rows = r.items.map((it, i) => `<tr><td class="c">${i + 1}</td><td class="code mono">${ShopCode.of(it) || '—'}</td><td class="nm"><b>${esc(it.name)}</b>${it.spec ? `<small>${esc(it.spec)}</small>` : ''}</td><td>${esc(it.cat || '')}</td><td class="r qty">${fmtQty(it.qty)}</td><td class="unit">${esc(it.unit)}</td><td class="chk"><i></i></td></tr>`).join('');
  const blank = Array.from({ length: Math.max(0, 10 - r.items.length) }, () => '<tr class="blank"><td></td><td></td><td></td><td></td><td></td><td></td><td class="chk"><i></i></td></tr>').join('');
  const html = shopFormDoc(r.id, `
  <div class="hd"><div class="brand"><div class="logo">HRM</div><div><h1>ใบขอสั่งซื้ออุปกรณ์</h1><small>PURCHASE REQUEST · HRM SHOPPING</small></div></div>
    <div class="rid"><span class="mono">${esc(r.id)}</span><small>${fmtD(r.created_at)} · ${fmtTime(r.created_at)} น.</small></div></div>
  <div class="tiles"><div class="tile who"><span>ผู้ขอสั่งซื้อ · REQUESTER</span><b>${esc(r.requester)}</b></div>
    <div class="tile"><span>จำนวนรายการ · ITEMS</span><b>${r.items.length} รายการ</b></div>
    <div class="tile"><span>สถานะ · STATUS</span><b>${esc(r.status_th || 'สั่งแล้ว')}</b></div>
    <div class="tile"><span>กำหนดส่ง · DELIVERY</span><b>${r.expected_date ? fmtD(r.expected_date) : '—'}</b></div></div>
  ${cancelled ? '' : `<div class="steps"><div class="bar" style="width:${Math.min(3, idx) / 3 * 75}%"></div>${steps}</div>`}
  <table><thead><tr><th class="c">#</th><th>รหัสสินค้า</th><th>รายการ / สเปค</th><th>หมวดหมู่</th><th class="r">จำนวน</th><th>หน่วย</th><th class="chk">รับแล้ว</th></tr></thead><tbody>${rows}${blank}</tbody></table>
  <div class="note"><span>หมายเหตุ · NOTE</span>${esc(r.note || '')}</div>
  <div class="sig"><div><div class="ln"></div>ผู้ขอสั่งซื้อ<small>(${esc(r.requester)}) · วันที่ ____/____/______</small></div><div><div class="ln"></div>ผู้ตรวจสอบ · Officer<small>วันที่ ____/____/______</small></div><div><div class="ln"></div>ผู้อนุมัติ<small>วันที่ ____/____/______</small></div></div>
  <div class="ft"><span>HRM Stock Control Management · ใบขอสั่งซื้อภายในแผนก ใช้ประกอบการสั่งซื้อตามขั้นตอนของบริษัท</span><span>พิมพ์ ${fmtD(App.today)}</span></div>`);
  return printHtml(html, r.id);
}
/** summary form of many requests (A4 landscape) */
function printRequestSummary(list, label) {
  const cnt = k => list.filter(r => r.status === k).length, items = list.reduce((t, r) => t + r.items.length, 0);
  const rows = list.map((r, i) => `<tr><td class="c">${i + 1}</td><td class="mono" style="font-weight:700">${esc(r.id)}</td><td>${fmtD(r.created_at)}</td><td><b>${esc(r.requester)}</b></td>
    <td class="items">${r.items.map(it => `<span class="mono">${ShopCode.of(it) || 'พิมพ์เอง'}</span> ${esc(it.name)}${it.spec ? ` (${esc(it.spec)})` : ''} <b>×${fmtQty(it.qty)} ${esc(it.unit)}</b>`).join('<br>')}</td>
    <td><span class="pill">${esc(r.status_th || '')}</span></td><td>${r.expected_date ? fmtD(r.expected_date) : '—'}</td></tr>`).join('');
  const html = shopFormDoc('สรุปคำขอสั่งซื้ออุปกรณ์', `
  <div class="hd"><div class="brand"><div class="logo">HRM</div><div><h1>สรุปคำขอสั่งซื้ออุปกรณ์</h1><small>PURCHASE REQUEST SUMMARY · HRM SHOPPING</small></div></div>
    <div class="rid"><span class="mono" style="font-size:12pt">${esc(label)}</span><small>พิมพ์ ${fmtD(App.today)}</small></div></div>
  <div class="kpi"><div><span>คำขอ</span><b>${list.length}</b></div><div><span>รายการรวม</span><b>${items}</b></div><div><span>สั่งแล้ว</span><b>${cnt('saved')}</b></div><div><span>รับคำสั่ง</span><b>${cnt('acknowledged')}</b></div><div><span>รอจัดส่ง</span><b>${cnt('ordered')}</b></div><div><span>จัดส่งสำเร็จ</span><b>${cnt('delivered')}</b></div></div>
  <table><thead><tr><th class="c">#</th><th>เลขที่คำขอ</th><th>วันที่</th><th>ผู้ขอ</th><th>รายการ (รหัส · ชื่อ · จำนวน)</th><th>สถานะ</th><th>กำหนดส่ง</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="ft"><span>HRM Stock Control Management</span><span>${list.length} คำขอ · ${items} รายการ</span></div>`, true);
  return printHtml(html, 'HRM-SHOP-SUMMARY');
}
/** backup every request to Excel: sheet "คำขอ" (one row per request) + "รายการ" (one row per item) */
async function backupRequestsXlsx(list) {
  const XLSX = await HistImport.lib();
  await ShopCode.ensure().catch(() => null);
  const head1 = ['เลขที่คำขอ', 'วันที่', 'เวลา', 'ผู้ขอสั่งซื้อ', 'จำนวนรายการ', 'สถานะ', 'กำหนดส่ง', 'อัปเดตโดย', 'อัปเดตเมื่อ', 'หมายเหตุ'];
  const s1 = [head1, ...list.map(r => [r.id, r.created_at.slice(0, 10), fmtTime(r.created_at), r.requester, r.items.length, r.status_th || r.status, r.expected_date || '', r.status_by || '', r.status_at || '', r.note || ''])];
  const head2 = ['เลขที่คำขอ', 'วันที่', 'ผู้ขอสั่งซื้อ', 'รหัสสินค้า', 'รายการ', 'สเปค / ขนาด / สี', 'จำนวน', 'หน่วย', 'หมวดหมู่', 'สถานะ'];
  const s2 = [head2, ...list.flatMap(r => r.items.map(it => [r.id, r.created_at.slice(0, 10), r.requester, ShopCode.of(it) || 'พิมพ์เอง', it.name, it.spec || '', +it.qty, it.unit, it.cat || '', r.status_th || r.status]))];
  const wb = XLSX.utils.book_new(), w1 = XLSX.utils.aoa_to_sheet(s1), w2 = XLSX.utils.aoa_to_sheet(s2);
  w1['!cols'] = [16, 12, 8, 18, 12, 14, 12, 14, 18, 30].map(wch => ({ wch })); w1['!autofilter'] = { ref: `A1:J${s1.length}` };
  w2['!cols'] = [16, 12, 18, 14, 28, 30, 8, 8, 24, 14].map(wch => ({ wch })); w2['!autofilter'] = { ref: `A1:J${s2.length}` };
  XLSX.utils.book_append_sheet(wb, w1, 'คำขอ'); XLSX.utils.book_append_sheet(wb, w2, 'รายการ');
  const name = `HRM-Shopping-backup_${App.today}.xlsx`;
  downloadB64(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return { name, requests: list.length, items: s2.length - 1 };
}
const shopStatusBadge = r => {
  const cls = { saved: 'ordered', acknowledged: 'sched', ordered: 'sched', delivered: 'ok', cancelled: 'neutral' }[r.status] || 'sched';
  return `<span class="badge ${cls}"><span class="dot"></span>${esc(r.status_th)}</span>`;
};

/* ---------- unit chip: click → pick from the list · double-click → type your own unit ---------- */
const UnitPick = {
  units() { return (PAGES.shop.cat?.units || ['ชิ้น', 'อัน', 'ม้วน', 'คู่', 'กล่อง', 'แพ็ค', 'ขวด', 'กระป๋อง', 'ถุง', 'เส้น', 'ด้าม']); },
  html(v, attrs = '') {
    return `<span class="unitpk" ${attrs} data-value="${esc(v)}" title="คลิกเพื่อเลือก · ดับเบิลคลิกเพื่อพิมพ์หน่วยเอง"><button type="button" class="unitpk-b"><span>${esc(v)}</span>${ic('chevD', 'sm')}</button></span>`;
  },
  set(box, v, touched = true) {
    v = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 20); if (!v) return;
    box.dataset.value = v; if (touched) box.dataset.touched = '1'; else delete box.dataset.touched;
    box.innerHTML = `<button type="button" class="unitpk-b"><span>${esc(v)}</span>${ic('chevD', 'sm')}</button>`;
    box.dispatchEvent(new CustomEvent('unitchange', { bubbles: true, detail: v }));
  },
  close() { $$('.unitpk-m').forEach(m => m.remove()); $$('.unitpk.open').forEach(b => b.classList.remove('open')); },
  menu(box) {
    this.close(); box.classList.add('open');
    const cur = box.dataset.value, m = document.createElement('div');
    m.className = 'unitpk-m';
    m.innerHTML = `<div class="upm-list">${[...new Set([cur, ...this.units()])].map(u => `<button type="button" data-u="${esc(u)}" class="${u === cur ? 'on' : ''}">${esc(u)}</button>`).join('')}</div>
      <button type="button" class="upm-type" data-utype>${ic('edit', 'sm')}พิมพ์หน่วยเอง…</button>`;
    document.body.appendChild(m);
    const r = box.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    m.style.top = (r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6) + 'px';
    m.onclick = e => {
      const u = e.target.closest('[data-u]'); if (u) { this.close(); return this.set(box, u.dataset.u); }
      if (e.target.closest('[data-utype]')) { this.close(); this.edit(box); }
    };
  },
  edit(box) {
    this.close();
    const old = box.dataset.value;
    box.innerHTML = `<input class="input unitpk-in" maxlength="20" value="${esc(old)}" placeholder="หน่วย">`;
    const i = box.querySelector('input'); i.focus(); i.select();
    let done = false;
    const fin = ok => { if (done) return; done = true; const v = i.value.trim(); ok && v ? this.set(box, v) : this.set(box, old, box.dataset.touched === '1'); };
    i.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); fin(true); } else if (e.key === 'Escape') { e.preventDefault(); fin(false); } };
    i.onblur = () => fin(true);
  },
};
(() => {
  let tm = null;
  document.addEventListener('click', e => {
    const b = e.target.closest('.unitpk-b');
    if (!b) { if (!e.target.closest('.unitpk-m')) UnitPick.close(); return; }
    e.preventDefault(); e.stopPropagation();
    const box = b.closest('.unitpk'); clearTimeout(tm);
    if (box.classList.contains('open')) return UnitPick.close();
    tm = setTimeout(() => UnitPick.menu(box), 230);       // wait — a double-click means "type my own"
  }, true);
  document.addEventListener('dblclick', e => {
    const b = e.target.closest('.unitpk-b'); if (!b) return;
    e.preventDefault(); clearTimeout(tm); UnitPick.edit(b.closest('.unitpk'));
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') UnitPick.close(); });
  window.addEventListener('scroll', () => UnitPick.close(), true);
})();

/* =============================== SHOP =============================== */
PAGES.shop = {
  title: ['ขอสั่งซื้ออุปกรณ์', 'HRM Shopping · Purchase Request'],
  view: 'shop', q: '', open: new Set([1]), cat: null, last: null,
  header(slot) {
    const n = Cart.count();
    slot.innerHTML = `<button class="cartbtn" id="hcart" title="ตะกร้าสินค้า">${sticker('shopbag', 30)}<span>ตะกร้า</span>${n ? `<b class="num">${n}</b>` : ''}</button>`;
    slot.querySelector('#hcart').onclick = () => { if (this.view !== 'shop') { this.view = 'shop'; this.render($('#content')); } else $('#cartpane')?.scrollIntoView({ behavior: 'smooth' }); };
  },
  async render(el, params = {}) {
    const [cat, hist] = await Promise.all([api('shop_catalog'), api('shop_requests').catch(() => [])]);
    this.cat = cat;
    this.items = this.cat.cats.flatMap(c => c.items.map(i => ({ ...i, cat: c.name })));
    ShopCode.build(cat);
    this.memo = this.buildMemo(hist);
    if (this.view === 'checkout') return this.checkout(el);
    if (this.view === 'done') return this.done(el);
    el.innerHTML = `<div class="page shop">
      <div class="shop-main">
        <section class="shop-manual">
          <div class="sm-lbl">${sticker('pencil', 30)}<div>${bi('พิมพ์รายการเอง', 'Add an item that is not in the list')}</div></div>
          <div class="sm-grid">
            <label class="sm-f sm-name"><span>ชื่ออุปกรณ์ <b class="req">*</b></span><input class="input" id="sm-in" list="sm-names" placeholder="เช่น ถุงมือผ้า, แปรงลวด, ไขควง…" autocomplete="off" maxlength="120"><datalist id="sm-names">${this.memo.list.slice(0, 60).map(x => `<option value="${esc(x.name)}">${esc(x.label)}</option>`).join('')}</datalist></label>
            <label class="sm-f"><span>สเปค / รุ่น</span><input class="input" id="sm-spec" placeholder="เช่น 3M, หัวแฉก, เบอร์ 2" autocomplete="off" maxlength="40"></label>
            <label class="sm-f"><span>ขนาด</span><input class="input" id="sm-size" placeholder="เช่น 2 นิ้ว, 10 มม., L" autocomplete="off" maxlength="30"></label>
            <label class="sm-f"><span>สี</span><input class="input" id="sm-color" list="sm-colors" placeholder="เช่น แดง" autocomplete="off" maxlength="20"><datalist id="sm-colors">${Object.keys(SWATCH).map(c => `<option value="${c}">`).join('')}</datalist></label>
            <div class="sm-f sm-qty"><span>จำนวน · หน่วย</span><div class="sm-qu"><div class="step"><button type="button" data-smdec aria-label="ลด">${ic('minus', 'sm')}</button><input class="num" id="sm-q" inputmode="decimal" value="1"><button type="button" data-sminc aria-label="เพิ่ม">${ic('plus', 'sm')}</button></div>${UnitPick.html('ชิ้น', 'id="sm-unit"')}</div></div>
            <button class="btn btn-primary lg sm-go" id="sm-add">${ic('plus')}${bi('เพิ่มลงตะกร้า', 'Add to cart')}</button>
          </div>
          <div class="sm-auto" id="sm-auto"></div><div class="sm-hint" id="sm-hint">${this.hintIdle()}</div>
        </section>
        ${this.promoteStrip()}
        <label class="search shop-search">${ic('search', 'sm')}<input class="input" id="sq" placeholder="ค้นหาสินค้าจากทุกหมวดหมู่…" value="${esc(this.q)}" autocomplete="off"></label>
        <div id="shop-list"></div>
      </div>
      <aside class="cart" id="cartpane"></aside>
    </div>`;
    this.drawList(); this.drawCart(); this.bind(el);
  },
  sel: {},   // chosen colour / typed spec per catalogue item (kept while the page is open)
  inCart() {   // by name — colour / spec variants are summed
    const m = {}; Cart.load().forEach(x => { const k = Cart.norm(x.name); if (m[k]) m[k] = { ...m[k], qty: +m[k].qty + +x.qty, n: m[k].n + 1 }; else m[k] = { ...x, n: 1 }; }); return m;
  },
  optsOf(it) { return it.opts || {}; },
  card(it) {
    const inc = this.inCart()[Cart.norm(it.name)], o = this.optsOf(it), step = +it.default_qty || 1;
    const hasOpt = !!(o.colors?.length || o.spec);
    const sel = this.sel[it.id];
    let optHtml = '';
    if (o.colors?.length) optHtml = `<div class="sw-lbl ${sel ? '' : 'need'}">${sel ? 'สี' + esc(sel) : 'เลือกสี'}</div>
      <div class="sw-row">${o.colors.map(c => `<button class="sw ${sel === c ? 'on' : ''}" data-sw="${it.id}" data-c="${esc(c)}" title="สี${esc(c)}" aria-label="สี${esc(c)}"><i style="--sw:${SWATCH[c] || '#ccc'}"></i></button>`).join('')}</div>`;
    else if (o.spec) optHtml = `<label class="spec-in">${esc(o.spec.label === 'ความยาว' ? 'ยาว' : o.spec.label)}<input class="input num" data-spec="${it.id}" inputmode="decimal" value="${esc(sel ?? (o.spec.default ?? ''))}" placeholder="?">${esc(o.spec.unit || '')}</label>`;
    const btn = inc ? `${ic('plus', 'sm')}เพิ่มอีก ${fmtQty(step)}` : `${ic('order', 'sm')}ใส่ตะกร้า${step !== 1 ? ` ${fmtQty(step)} ${esc(it.unit)}` : ''}`;
    return `<article class="prod ${inc ? 'in' : ''} ${hasOpt ? 'has-opt' : ''}" ${hasOpt ? `data-prod="${it.id}"` : `data-add="${it.id}"`}>
      <div class="prod-pic">${App.officer ? `<button class="prod-edit" data-edititem="${it.id}" title="แก้ไขสินค้า (Officer)">${ic('edit', 'sm')}</button>` : ''}${shopPic(it.art, 112)}${inc ? `<span class="prod-in">${ic('check', 'sm')}ในตะกร้า ${fmtQty(inc.qty)} ${esc(inc.unit)}${inc.n > 1 ? ` · ${inc.n} แบบ` : ''}</span>` : ''}</div>
      <div class="prod-code">${ShopCode.of(it.id)}</div><div class="prod-name" title="${esc(it.name)}">${esc(it.name)}</div>
      ${optHtml || `<div class="prod-unit">หน่วยแนะนำ · ${esc(it.unit)}${step !== 1 ? ` · สั่งทีละ ${fmtQty(step)}` : ''}</div>`}
      <button class="btn ${inc ? 'btn-tonal' : 'btn-primary'} sm prod-btn" ${hasOpt ? `data-addopt="${it.id}"` : ''}>${btn}</button>
    </article>`;
  },
  drawList() {
    const box = $('#shop-list'); if (!box) return;
    const q = this.q.trim().toLowerCase();
    if (q) {
      const hits = this.items.filter(i => (i.name + ' ' + i.cat).toLowerCase().includes(q));
      box.innerHTML = `<div class="shop-results"><div class="sr-h">${bi(`ผลการค้นหา “${esc(this.q)}”`, `${hits.length} RESULTS`)}<span class="grow"></span><button class="btn btn-ghost sm" data-clearq>${ic('x', 'sm')}ล้างคำค้น</button></div>
        ${hits.length ? `<div class="prod-grid">${hits.map(i => this.card(i)).join('')}</div>`
          : `<div class="sr-empty">${sticker('info', 56)}<div><b>ไม่พบ “${esc(this.q)}” ในรายการ</b><span>เพิ่มเป็นรายการใหม่ได้เลย</span></div><button class="btn btn-primary" data-addq>${ic('plus', 'sm')}เพิ่ม “${esc(this.q)}” ลงตะกร้า</button></div>`}</div>`;
      return;
    }
    const inc = this.inCart();
    box.innerHTML = `<div class="acc">${this.cat.cats.map((c, i) => {
      const n = c.items.filter(it => inc[Cart.norm(it.name)]).length;
      const open = this.open.has(c.id);
      return `<section class="acc-i ${open ? 'open' : ''}" data-cat="${c.id}">
        <button class="acc-h" data-tog="${c.id}" aria-expanded="${open}">
          <span class="acc-pic">${shopPic(c.art, 48)}</span>
          <span class="acc-no num">${String(i + 1).padStart(2, '0')}</span>
          <span class="acc-t">${bi(c.name, c.en)}</span>
          <span class="grow"></span>
          ${n ? `<span class="acc-incart">${ic('check', 'sm')}ในตะกร้า ${n}</span>` : ''}
          <span class="count-chip">${c.items.length} รายการ</span>
          <span class="acc-chev">${ic('chevD')}</span>
        </button>
        <div class="acc-b"><div class="acc-in">
          <div class="prod-grid">${c.items.map(it => this.card({ ...it, cat: c.name })).join('')}
            ${App.officer ? `<button class="prod prod-new" data-newitem="${c.id}">${ic('plus', 'lg')}<span>เพิ่มสินค้าในหมวดนี้</span><small>เฉพาะ Officer</small></button>` : ''}</div>
        </div></div>
      </section>`;
    }).join('')}</div>`;
  },
  drawCart() {
    const pane = $('#cartpane'); if (!pane) return;
    const c = Cart.load(), units = this.cat.units;
    const bad = c.some(x => !(+x.qty > 0));
    const total = c.reduce((s, x) => s + (+x.qty > 0 ? +x.qty : 0), 0);
    pane.innerHTML = `<header class="cart-h">${sticker('shopbag', 34)}<div>${bi('ตะกร้าสินค้า', 'Shopping cart')}</div><span class="grow"></span><span class="count-chip">${c.length} รายการ</span></header>
      ${c.length ? `<div class="cart-list">${c.map(x => `<div class="ci ${+x.qty > 0 ? '' : 'bad'}" data-uid="${x.uid}">
          ${shopPic(x.art, 48)}
          <div class="ci-main"><div class="ci-name" title="${esc(itemText(x))}">${esc(x.name)}${x.spec ? `<button class="spec-chip ed" data-espec title="คลิกเพื่อแก้สเปค / ขนาด / สี">${esc(x.spec)}${ic('edit', 'sm')}</button>` : `<button class="spec-add" data-espec title="เพิ่มสเปค / ขนาด / สี">${ic('plus', 'sm')}รายละเอียด</button>`}</div><div class="ci-cat">${ShopCode.tag(x)}${esc(x.cat || 'รายการเพิ่มเอง')}</div>
            <div class="ci-ctl">
              <div class="step"><button data-dec aria-label="ลด">${ic('minus', 'sm')}</button><input class="num" data-qty inputmode="decimal" value="${esc(x.qty)}"><button data-inc aria-label="เพิ่ม">${ic('plus', 'sm')}</button></div>
              ${UnitPick.html(x.unit, 'data-unit')}
            </div>
            ${+x.qty > 0 ? '' : '<div class="err-text">จำนวนต้องมากกว่า 0</div>'}
          </div>
          <button class="icon-btn sm ci-x" data-rm title="ลบออกจากตะกร้า">${ic('x', 'sm')}</button>
        </div>`).join('')}</div>`
        : `<div class="cart-empty">${sticker('shopbag', 84, 'hero')}<b>ตะกร้ายังว่าง</b><span>เลือกสินค้าจากหมวดหมู่ หรือพิมพ์รายการเองด้านบน</span></div>`}
      <footer class="cart-f">
        <div class="cart-sum"><span>${c.length} รายการ</span><span class="faint">· รวมจำนวน ${fmtN(total)}</span>${c.length ? `<span class="grow"></span><button class="link" data-clear>ล้างตะกร้า</button>` : ''}</div>
        <button class="btn btn-primary lg cart-go" id="checkout" ${!c.length || bad ? 'disabled' : ''}>${ic('check')}${bi('สั่งซื้อ', 'Place request')}</button>
      </footer>`;
    App.renderHeader();
  },
  toastAdd(name, merged) { toast(merged ? 'เพิ่มจำนวนแล้ว' : 'ใส่ตะกร้าแล้ว', esc(name), 'ok'); },
  addById(id, spec = '') {
    const it = this.items.find(i => i.id === id); if (!it) return;
    const line = { name: it.name, cat: it.cat, art: it.art, unit: it.unit, item_id: it.id };
    if (spec) line.spec = spec;
    const r = Cart.add(line, +it.default_qty || 1);
    this.toastAdd(itemText(line), r.merged); this.drawList(); this.drawCart();
  },
  /** items with colours / spec: need a choice first, otherwise the card shakes */
  addWithOpt(id, card) {
    const it = this.items.find(i => i.id === id); if (!it) return;
    const o = this.optsOf(it);
    let spec = '';
    if (o.colors?.length) { const c = this.sel[id]; if (c) spec = 'สี' + c; }
    else if (o.spec) {
      const v = (card?.querySelector('[data-spec]')?.value ?? this.sel[id] ?? '').toString().trim();
      if (v && +v > 0) { this.sel[id] = v; spec = `${o.spec.label === 'ความยาว' ? 'ยาว' : o.spec.label} ${fmtN(+v)} ${o.spec.unit || ''}`.trim(); }
    }
    if (!spec) {
      if (card) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); card.querySelector('[data-spec]')?.focus(); }
      toast(o.colors?.length ? 'กรุณาเลือกสีก่อน' : `กรุณาระบุ${o.spec?.label || 'สเปค'}`, esc(it.name), 'warn');
      return;
    }
    this.addById(id, spec);
  },
  /** typed-in items remembered from earlier requests (all computers) — newest first */
  buildMemo(reqs) {
    const by = new Map();
    (reqs || []).filter(r => r.status !== 'cancelled').forEach(r => (r.items || []).forEach(x => {
      if (x.item_id) return;
      const k = Cart.norm(x.name); if (!k || this.items.some(i => Cart.norm(i.name) === k)) return;
      let m = by.get(k);
      if (!m) by.set(k, m = { name: x.name, last: x, rid: r.id, at: r.created_at, n: 0, colors: new Set(), units: new Set() });
      m.n++; m.units.add(x.unit);
      const c = this.specParts(x.spec).color; if (c) m.colors.add(c);
    }));
    const list = [...by.values()].map(m => ({ ...m, label: [m.last.spec, `${fmtQty(m.last.qty)} ${m.last.unit}`].filter(Boolean).join(' · ') }));
    return { by, list };
  },
  specParts(t) {
    const out = { spec: [], size: '', color: '' };
    String(t || '').split(' · ').map(x => x.trim()).filter(Boolean).forEach(x => {
      if (/^ขนาด\s*/.test(x)) out.size = x.replace(/^ขนาด\s*/, '');
      else if (/^สี/.test(x) && x.length <= 14) out.color = x.replace(/^สี\s*/, '');
      else out.spec.push(x);
    });
    return { spec: out.spec.join(' · '), size: out.size, color: out.color };
  },
  /** typed name matches an earlier request → fill spec / size / colour / qty / unit (only the empty fields) */
  autofill(el) {
    const F = id => el.querySelector(id), name = F('#sm-in').value, note = F('#sm-auto');
    const m = this.memo?.by.get(Cart.norm(name));
    if (!m) { note.innerHTML = ''; return; }
    const p = this.specParts(m.last.spec), filled = [];
    [['#sm-spec', p.spec], ['#sm-size', p.size], ['#sm-color', p.color]].forEach(([id, v]) => { const i = F(id); if (v && !i.value.trim()) { i.value = v; i.classList.add('auto'); filled.push(v); } });
    const u = F('#sm-unit'); if (m.last.unit && u.dataset.touched !== '1') { UnitPick.set(u, m.last.unit, false); u.classList.add('auto'); }
    const q = F('#sm-q'); if (q.value === '1' && +m.last.qty > 0) { q.value = fmtQty(m.last.qty); q.classList.add('auto'); }
    note.innerHTML = `${ic('clock', 'sm')}<span>เติมจากครั้งก่อน · <b>${esc(m.rid)}</b> · ${fmtD(m.at)}${m.n > 1 ? ` · สั่งมาแล้ว ${m.n} ครั้ง` : ''}</span><button type="button" class="link" data-autoclr>ล้างที่เติม</button>`;
  },
  clearAuto(el) {
    el.querySelectorAll('.sm-grid .auto').forEach(i => { if (i.id === 'sm-q') i.value = '1'; else if (i.id === 'sm-unit') UnitPick.set(i, 'ชิ้น', false); else i.value = ''; i.classList.remove('auto'); });
    el.querySelector('#sm-auto').innerHTML = '';
  },
  /** Officer: typed-in items that keep coming back → make them catalogue items */
  promoteStrip() {
    if (!App.officer || !this.memo?.list.length) return '';
    const top = this.memo.list.slice().sort((a, b) => b.n - a.n || String(b.at).localeCompare(String(a.at))).slice(0, 8);
    return `<section class="promo"><div class="promo-h">${ic('plus', 'sm')}<b>รายการที่พิมพ์เอง</b><span>เพิ่มเป็นสินค้าในหมวดหมู่ได้ — ครั้งหน้าเลือกจากรูปได้เลย (Officer)</span></div>
      <div class="promo-list">${top.map(m => `<button class="promo-i" data-promote="${esc(m.name)}" title="เพิ่ม “${esc(m.name)}” เป็นสินค้าในหมวดหมู่">
        <b>${esc(m.name)}</b><small>${m.n} ครั้ง · ${esc([...m.units].join('/'))}${m.colors.size ? ` · ${m.colors.size} สี` : ''}</small><span class="promo-go">${ic('plus', 'sm')}เพิ่มเข้าหมวด</span></button>`).join('')}</div></section>`;
  },
  promote(name, unit) {
    const m = this.memo?.by.get(Cart.norm(name));
    const colors = m ? [...m.colors] : [];
    this.itemEditor({ name: m?.name || name, unit: unit || m?.last.unit || 'ชิ้น', default_qty: 1, art: 'custom', opts: colors.length ? { colors } : {} });
  },
  /** cart line: edit สเปค / ขนาด / สี without removing the line */
  async editSpec(uid) {
    const c = Cart.load(), x = c.find(z => z.uid === uid); if (!x) return;
    const p = this.specParts(x.spec);
    const res = await modal({
      title: `รายละเอียด ${x.name}`, en: 'EDIT DETAILS', icon: 'edit', color: 'var(--primary)', ok: 'บันทึก', okEn: 'Save',
      body: `<div class="frow"><div class="field"><label>สเปค / รุ่น</label><input class="input" id="es-s" maxlength="40" value="${esc(p.spec)}" placeholder="เช่น 3M, หัวแฉก"></div>
          <div class="field"><label>ขนาด</label><input class="input" id="es-z" maxlength="30" value="${esc(p.size)}" placeholder="เช่น 2 นิ้ว"></div></div>
        <div class="field" style="margin-top:10px"><label>สี</label><input class="input" id="es-c" list="sm-colors" maxlength="20" value="${esc(p.color)}" placeholder="เช่น แดง"></div>
        <div class="es-prev" id="es-prev"></div><div class="err-text" style="margin-top:6px"></div>`,
      onOk: box => ({ spec: this.specText({ spec: box.querySelector('#es-s').value, size: box.querySelector('#es-z').value, color: box.querySelector('#es-c').value }) }),
    });
    if (!res) return;
    const cur = Cart.load(), line = cur.find(z => z.uid === uid); if (!line) return;
    if (res.spec) line.spec = res.spec; else delete line.spec;
    const twin = cur.find(z => z !== line && Cart.key(z) === Cart.key(line) && z.unit === line.unit);
    if (twin) { twin.qty = (+twin.qty || 0) + (+line.qty || 0); cur.splice(cur.indexOf(line), 1); toast('รวมกับรายการเดิมแล้ว', esc(itemText(twin)), 'info'); }
    Cart.save(cur); this.drawCart(); this.drawList();
  },
  /** สเปค · ขนาด · สี → one spec text, e.g. "3M · ขนาด 2 นิ้ว · สีแดง" */
  specText({ spec = '', size = '', color = '' } = {}) {
    const t = v => String(v || '').replace(/\s+/g, ' ').trim();
    const c = t(color);
    return [t(spec), t(size) && (/^ขนาด/.test(t(size)) ? t(size) : 'ขนาด ' + t(size)), c && (/^สี/.test(c) ? c : 'สี' + c)].filter(Boolean).join(' · ');
  },
  addManual(name, det = {}) {
    name = (name || '').replace(/\s+/g, ' ').trim();
    if (!name) return false;
    const known = this.items.find(i => Cart.norm(i.name) === Cart.norm(name));
    const spec = this.specText(det), qty = det.qty > 0 ? det.qty : 1;
    const unit = det.unit && (det.unitTouched || !known) ? det.unit : known ? known.unit : 'ชิ้น';
    const line = known ? { name: known.name, cat: known.cat, art: known.art, unit, item_id: known.id } : { name, cat: 'รายการเพิ่มเอง', art: 'custom', unit, item_id: null };
    if (spec) line.spec = spec;
    const r = Cart.add(line, det.qty > 0 ? qty : (known ? +known.default_qty || 1 : 1));
    this.toastAdd(itemText(line), r.merged);
    if (known && !r.merged) toast('มีสินค้านี้ในรายการอยู่แล้ว', `ใช้ “${esc(known.name)}” จากหมวด ${esc(known.cat)}`, 'info');
    this.drawList(); this.drawCart(); return true;
  },
  bind(el) {
    const inp = el.querySelector('#sm-in'), F = id => el.querySelector(id);
    const add = () => {
      if (!inp.value.trim()) { const box = el.querySelector('.shop-manual'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); toast('กรุณาพิมพ์ชื่ออุปกรณ์', '', 'warn'); return inp.focus(); }
      const q = parseNum(F('#sm-q').value);
      if (!(q > 0)) { toast('จำนวนต้องมากกว่า 0', esc(inp.value), 'warn'); return F('#sm-q').focus(); }
      const u = F('#sm-unit');
      const ok = this.addManual(inp.value, { spec: F('#sm-spec').value, size: F('#sm-size').value, color: F('#sm-color').value, qty: q, unit: u.dataset.value, unitTouched: u.dataset.touched === '1' });
      if (ok) {
        inp.value = F('#sm-spec').value = F('#sm-size').value = F('#sm-color').value = ''; F('#sm-q').value = '1';
        UnitPick.set(u, 'ชิ้น', false); this.hint(''); el.querySelectorAll('.sm-grid .auto').forEach(i => i.classList.remove('auto')); el.querySelector('#sm-auto').innerHTML = '';
      }
      inp.focus();
    };
    el.querySelector('.sm-grid').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input') && !e.target.closest('.unitpk')) { e.preventDefault(); add(); } });
    el.querySelector('.sm-qu .step').addEventListener('click', e => {
      const qi = F('#sm-q'), v = parseNum(qi.value) || 0;
      if (e.target.closest('[data-sminc]')) qi.value = fmtQty(v + 1); else if (e.target.closest('[data-smdec]')) qi.value = fmtQty(Math.max(1, v - 1));
    });
    F('#sm-q').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d.]/g, ''); });
    el.querySelector('#sm-add').onclick = add;
    inp.oninput = () => { this.hint(inp.value); this.autofill(el); };
    el.querySelector('.sm-grid').addEventListener('input', e => { if (e.target.id !== 'sm-in') e.target.classList.remove('auto'); });
    el.querySelector('.sm-grid').addEventListener('unitchange', e => { if (e.target.id === 'sm-unit' && e.target.dataset.touched === '1') e.target.classList.remove('auto'); });
    el.querySelector('#sq').oninput = e => { this.q = e.target.value; this.drawList(); };
    el.addEventListener('click', async e => {
      const t = e.target;
      const tog = t.closest('[data-tog]');
      if (tog) { const id = +tog.dataset.tog; this.open.has(id) ? this.open.delete(id) : this.open.add(id); tog.closest('.acc-i').classList.toggle('open', this.open.has(id)); tog.setAttribute('aria-expanded', this.open.has(id)); return; }
      if (t.closest('[data-autoclr]')) return this.clearAuto(el);
      const es = t.closest('[data-espec]'); if (es) { e.stopPropagation(); return this.editSpec(es.closest('.ci').dataset.uid); }
      const pm = t.closest('[data-promote]'); if (pm) return this.promote(pm.dataset.promote);
      const ei = t.closest('[data-edititem]'); if (ei) { e.stopPropagation(); return this.itemEditor(this.items.find(i => i.id === +ei.dataset.edititem)); }
      const nw = t.closest('[data-newitem]'); if (nw) return this.itemEditor(null, +nw.dataset.newitem);
      const sw = t.closest('[data-sw]'); if (sw) { this.sel[+sw.dataset.sw] = sw.dataset.c; return this.drawList(); }
      const ao = t.closest('[data-addopt]'); if (ao) return this.addWithOpt(+ao.dataset.addopt, ao.closest('.prod'));
      if (t.closest('[data-spec]')) return;
      const ad = t.closest('[data-add]'); if (ad) return this.addById(+ad.dataset.add);
      if (t.closest('[data-clearq]')) { this.q = ''; el.querySelector('#sq').value = ''; return this.drawList(); }
      if (t.closest('[data-addq]')) { this.addManual(this.q); this.q = ''; el.querySelector('#sq').value = ''; return this.drawList(); }
      const sug = t.closest('[data-sug]'); if (sug) { this.addById(+sug.dataset.sug); inp.value = ''; this.hint(''); return; }
      const ci = t.closest('.ci'); const c = Cart.load();
      if (ci) {
        const x = c.find(z => z.uid === ci.dataset.uid); if (!x) return;
        if (t.closest('[data-inc]')) x.qty = (+x.qty || 0) + 1;
        else if (t.closest('[data-dec]')) x.qty = Math.max(1, (+x.qty || 1) - 1);
        else if (t.closest('[data-rm]')) c.splice(c.indexOf(x), 1);
        else return;
        Cart.save(c); this.drawCart(); this.drawList(); return;
      }
      if (t.closest('[data-clear]')) { if (await modal({ title: 'ล้างตะกร้า?', en: 'Clear cart', body: '<p class="muted">รายการทั้งหมดในตะกร้าจะถูกลบ</p>', ok: 'ล้างตะกร้า', okEn: 'Clear', danger: true })) { Cart.save([]); this.drawCart(); this.drawList(); } return; }
      if (t.closest('#checkout')) { this.view = 'checkout'; this.render(el); }
    });
    el.addEventListener('unitchange', e => {
      const ci = e.target.closest('.ci'); if (!ci) return;
      const c = Cart.load(), x = c.find(z => z.uid === ci.dataset.uid); if (!x) return;
      x.unit = e.detail; Cart.save(c); this.drawCart(); this.drawList();
    });
    el.addEventListener('change', e => {
      if (e.target.matches('[data-spec]')) { this.sel[+e.target.dataset.spec] = e.target.value; return; }
      const ci = e.target.closest('.ci'); if (!ci || e.target.closest('.unitpk')) return;
      const c = Cart.load(), x = c.find(z => z.uid === ci.dataset.uid); if (!x) return;
      if (e.target.matches('[data-qty]')) { const v = parseNum(e.target.value); x.qty = Number.isNaN(v) || v === null ? 0 : v; }
      Cart.save(c); this.drawCart(); this.drawList();
    });
    el.addEventListener('input', e => { if (e.target.matches('[data-qty],[data-spec]')) e.target.value = e.target.value.replace(/[^\d.]/g, ''); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-spec]')) { e.preventDefault(); this.addWithOpt(+e.target.dataset.spec, e.target.closest('.prod')); } });
  },
  hintIdle() { return '<kbd>Enter</kbd> เพิ่มได้ทันที · <b>ดับเบิลคลิกที่หน่วย</b> เพื่อพิมพ์หน่วยเอง · ชื่อที่ตรงกับสินค้าที่มีอยู่จะรวมจำนวนให้'; },
  hint(v) {
    const h = $('#sm-hint'); if (!h) return;
    const q = v.trim().toLowerCase();
    if (q.length < 2) { h.innerHTML = this.hintIdle(); return; }
    const hits = this.items.filter(i => i.name.toLowerCase().includes(q)).slice(0, 5);
    if (!hits.length && this.memo?.by.has(Cart.norm(v))) { h.innerHTML = this.hintIdle(); return; }
    h.innerHTML = hits.length ? `มีในรายการแล้ว: ${hits.map(i => `<button class="sug" data-sug="${i.id}">${shopPic(i.art, 22)}${esc(i.name)}</button>`).join('')}` : `<span>“${esc(v.trim())}” เป็นรายการใหม่ — กด Enter เพื่อเพิ่ม</span>`;
  },
  /* ---------- Officer: catalogue item editor (name · หมวด · หน่วย · สั่งได้ทีละ · สี/สเปค · รูป/Emoji) ---------- */
  itemEditor(it, catId) {
    const isNew = !it?.id;
    const v = {
      id: it?.id || null, cat_id: it?.cat_id || catId || this.cat.cats[0]?.id, name: it?.name || '', unit: it?.unit || 'ชิ้น',
      default_qty: it?.default_qty || 1, art: it?.art || 'custom', opts: JSON.parse(JSON.stringify(it?.opts || {})), price: it?.price ?? '',
    };
    let mode = v.opts.colors?.length ? 'colors' : v.opts.spec ? 'spec' : 'none', tab = String(v.art).startsWith('emoji:') ? 'emoji' : 'draw';
    const colorChips = () => (v.opts.colors || []).map((c, i) => `<span class="cchip"><i style="--sw:${SWATCH[c] || '#ccc'}"></i>${esc(c)}<button data-crm="${i}" aria-label="ลบ">${ic('x', 'sm')}</button></span>`).join('');
    const artGrid = () => tab === 'draw'
      ? SHOP_ART_KEYS.map(k => `<button class="art-opt ${v.art === k ? 'on' : ''}" data-art="${k}">${shopPic(k, 54)}</button>`).join('')
      : SHOP_EMOJI.map(e => `<button class="art-opt emo ${v.art === 'emoji:' + e ? 'on' : ''}" data-art="emoji:${e}">${e}</button>`).join('');
    const body = () => `<div class="ie">
      <div class="ie-top"><div class="ie-pic" id="ie-pic">${shopPic(v.art, 96)}</div>
        <div class="ie-f"><div class="field"><label>ชื่อสินค้า <span class="req">*</span></label><input class="input" id="ie-n" maxlength="120" value="${esc(v.name)}" placeholder="เช่น ถุงมือผ้า"></div>
          <div class="field"><label>หมวด</label><select class="input" id="ie-c">${this.cat.cats.map(c => `<option value="${c.id}" ${c.id === v.cat_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div></div>
      <div class="frow">
        <div class="field"><label>หน่วย <span class="en">พิมพ์เองได้</span></label><input class="input" id="ie-u" list="ie-units" maxlength="20" value="${esc(v.unit)}"><datalist id="ie-units">${this.cat.units.map(u => `<option value="${esc(u)}">`).join('')}</datalist></div>
        <div class="field"><label>สั่งได้ทีละ <span class="en">กด “ใส่ตะกร้า” 1 ครั้ง = จำนวนนี้</span></label><div class="ie-step"><button class="btn btn-plain stp" data-st="-1">−</button><input class="input num" id="ie-q" inputmode="decimal" value="${esc(v.default_qty)}"><button class="btn btn-plain stp" data-st="1">+</button><span id="ie-qu">${esc(v.unit)}</span></div></div>
        <div class="field"><label>ราคา/หน่วย (บาท) <span class="en">ใช้สรุปค่าใช้จ่าย · เว้นว่างได้</span></label><label class="sp-pin wide"><span>฿</span><input class="input num" id="ie-pr" inputmode="decimal" value="${esc(v.price)}" placeholder="ต่อ ${esc(v.unit)}"></label></div>
      </div>
      <div class="field"><label>ตัวเลือกตอนสั่ง</label>
        <div class="seg" id="ie-mode">${[['none', 'ไม่มี'], ['colors', 'เลือกสี'], ['spec', 'ระบุสเปค / ขนาด']].map(([k, t]) => `<button data-m="${k}" class="${mode === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        ${mode === 'colors' ? `<div class="ie-colors"><div class="cchips" id="ie-cc">${colorChips()}</div>
          <div class="ie-preset">${Object.keys(SWATCH).map(c => `<button class="sw ${(v.opts.colors || []).includes(c) ? 'on' : ''}" data-pc="${esc(c)}" title="สี${esc(c)}"><i style="--sw:${SWATCH[c]}"></i></button>`).join('')}
          <input class="input" id="ie-cn" placeholder="สีอื่น ๆ พิมพ์แล้ว Enter" maxlength="20"></div></div>` : ''}
        ${mode === 'spec' ? `<div class="frow ie-spec"><div class="field"><label>ชื่อสเปค</label><input class="input" id="ie-sl" value="${esc(v.opts.spec?.label || 'ความยาว')}" maxlength="20"></div>
          <div class="field"><label>หน่วยของสเปค</label><input class="input" id="ie-su" value="${esc(v.opts.spec?.unit || 'เมตร')}" maxlength="12"></div>
          <div class="field"><label>ค่าเริ่มต้น <span class="en">เว้นว่าง = ต้องกรอกเอง</span></label><input class="input num" id="ie-sd" inputmode="decimal" value="${esc(v.opts.spec?.default ?? '')}"></div></div>` : ''}
      </div>
      <div class="field"><label>รูปสินค้า</label>
        <div class="seg" id="ie-tab"><button data-t="draw" class="${tab === 'draw' ? 'on' : ''}">${ic('edit', 'sm')}รูปวาด</button><button data-t="emoji" class="${tab === 'emoji' ? 'on' : ''}">😀 Emoji</button></div>
        <div class="art-grid ${tab}" id="ie-art">${artGrid()}</div></div>
      <div class="err-text" id="ie-err"></div></div>`;
    openPanel({
      title: isNew ? 'เพิ่มสินค้า' : 'แก้ไขสินค้า', en: isNew ? 'NEW ITEM · OFFICER' : `EDIT ITEM · ${v.name}`, icon: isNew ? 'plus' : 'edit', body: body(),
      foot: `${isNew ? '' : `<button class="btn btn-danger" data-irm>${ic('x', 'sm')}ลบออกจากรายการ</button>`}<span style="flex:1"></span><button class="btn btn-plain" data-icancel>ยกเลิก</button><button class="btn btn-primary" data-isave>${ic('check', 'sm')}บันทึก</button>`,
      onMount: (p, close) => {
        const b = p.querySelector('.panel-b');
        const grab = () => {   // keep what was typed before redrawing
          const g = id => b.querySelector(id);
          if (g('#ie-n')) v.name = g('#ie-n').value; if (g('#ie-c')) v.cat_id = +g('#ie-c').value; if (g('#ie-u')) v.unit = g('#ie-u').value; if (g('#ie-q')) v.default_qty = g('#ie-q').value; if (g('#ie-pr')) v.price = g('#ie-pr').value;
          if (mode === 'spec' && g('#ie-sl')) v.opts = { spec: { label: g('#ie-sl').value, unit: g('#ie-su').value, default: g('#ie-sd').value } };
        };
        const redraw = () => { grab(); const st = b.scrollTop; b.innerHTML = body(); b.scrollTop = st; };
        b.addEventListener('click', e => {
          const t = e.target.closest('[data-m],[data-t],[data-art],[data-pc],[data-crm],[data-st]'); if (!t) return;
          if (t.dataset.m) { grab(); mode = t.dataset.m; if (mode === 'colors') v.opts = { colors: v.opts.colors || [] }; else if (mode === 'spec') v.opts = { spec: v.opts.spec || { label: 'ความยาว', unit: 'เมตร', default: '' } }; else v.opts = {}; b.innerHTML = body(); return; }
          if (t.dataset.t) { tab = t.dataset.t; return redraw(); }
          if (t.dataset.art) { v.art = t.dataset.art; b.querySelector('#ie-pic').innerHTML = shopPic(v.art, 96); $$('.art-opt', b).forEach(x => x.classList.toggle('on', x === t)); return; }
          if (t.dataset.pc) { const c = t.dataset.pc, l = v.opts.colors || []; v.opts.colors = l.includes(c) ? l.filter(x => x !== c) : [...l, c]; return redraw(); }
          if (t.dataset.crm !== undefined) { v.opts.colors.splice(+t.dataset.crm, 1); return redraw(); }
          if (t.dataset.st) { const q = b.querySelector('#ie-q'); q.value = Math.max(1, (parseNum(q.value) || 0) + +t.dataset.st); }
        });
        b.addEventListener('input', e => { if (e.target.id === 'ie-u') b.querySelector('#ie-qu').textContent = e.target.value; });
        b.addEventListener('keydown', e => {
          if (e.target.id === 'ie-cn' && e.key === 'Enter') { e.preventDefault(); const c = e.target.value.trim().replace(/^สี/, ''); if (c && !(v.opts.colors || []).includes(c)) { v.opts.colors = [...(v.opts.colors || []), c]; redraw(); setTimeout(() => b.querySelector('#ie-cn')?.focus(), 0); } }
        });
        p.querySelector('[data-icancel]').onclick = close;
        p.querySelector('[data-irm]')?.addEventListener('click', async () => {
          const ok = await modal({ title: `ลบ “${v.name}” ออกจากรายการ?`, en: 'Remove item', body: '<p class="muted">คำขอสั่งซื้อเดิมที่มีสินค้านี้ยังอยู่ครบ — แค่ไม่แสดงในรายการให้เลือกอีก</p>', ok: 'ลบออก', okEn: 'Remove', danger: true });
          if (!ok) return;
          try { await api('shop_item_remove', v.id); toast('ลบสินค้าออกจากรายการแล้ว', esc(v.name)); close(); this.render($('#content')); } catch (er) { toastErr(er); }
        });
        p.querySelector('[data-isave]').onclick = async ev => {
          grab();
          if (mode === 'colors' && !(v.opts.colors || []).length) { b.querySelector('#ie-err').textContent = 'เลือกสีอย่างน้อย 1 สี หรือเปลี่ยนตัวเลือกเป็น “ไม่มี”'; return; }
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            await api('shop_item_save', { ...v, default_qty: parseNum(v.default_qty) || v.default_qty, opts: mode === 'none' ? {} : v.opts });
            toast(isNew ? 'เพิ่มสินค้าแล้ว' : 'บันทึกสินค้าแล้ว', `${esc(v.name)} · สั่งได้ทีละ ${esc(String(v.default_qty))} ${esc(v.unit)}`);
            close(); App.page === 'shop' ? this.render($('#content')) : App.refresh();
          } catch (er) { b.querySelector('#ie-err').textContent = er.message; btn.disabled = false; }
        };
        setTimeout(() => b.querySelector('#ie-n')?.focus(), 80);
      },
    });
  },

  /* ---------- checkout ---------- */
  checkout(el) {
    const c = Cart.load();
    if (!c.length) { this.view = 'shop'; return this.render(el); }
    const now = new Date();
    el.innerHTML = `<div class="page shop-co">
      <section class="co-card">
        <header class="co-h">${sticker('clipboard', 44)}<div>${bi('ตรวจสอบคำขอสั่งซื้อ', 'Review your request')}</div><span class="grow"></span><span class="co-date">${ic('cal', 'sm')}${TH_WD[now.getDay()]} ${fmtD(iso(now))} · ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}</span></header>
        <div class="co-form">
          <div class="field"><label>ชื่อผู้ขอสั่งซื้อ <span class="req">*</span> <span class="en">Requester (required)</span></label><input class="input lg" id="co-name" maxlength="60" value="${esc(localStorageGet('shopName') || '')}" placeholder="ชื่อ-นามสกุล หรือชื่อเล่น"></div>
          <div class="field"><label>หมายเหตุ <span class="en">Note (optional)</span></label><textarea class="input" id="co-note" rows="2" maxlength="500" placeholder="เช่น ใช้งานพื้นที่ใด / ต้องการด่วนภายในวันที่…"></textarea></div>
        </div>
        <div class="co-table">
          <div class="co-row co-th"><span>#</span><span>รายการ</span><span>หมวดหมู่</span><span class="r">จำนวน</span><span>หน่วย</span></div>
          ${c.map((x, i) => `<div class="co-row"><span class="faint num">${i + 1}</span><span class="co-name">${shopPic(x.art, 40)}<span class="co-n"><span>${esc(x.name)}${specChip(x)}</span>${ShopCode.tag(x, 'sm')}</span></span><span class="muted">${esc(x.cat || 'รายการเพิ่มเอง')}</span><span class="r num co-q">${fmtQty(x.qty)}</span><span>${esc(x.unit)}</span></div>`).join('')}
        </div>
        <div class="err-text" id="co-err"></div>
        <footer class="co-f"><button class="btn btn-plain lg" id="co-back">${ic('chevL')}${bi('กลับไปแก้ไข', 'Back to cart')}</button><span class="grow"></span>
          <span class="muted">${c.length} รายการ</span><button class="btn btn-primary lg" id="co-ok">${ic('check')}${bi('ยืนยันสั่งซื้อ', 'Confirm request')}</button></footer>
      </section></div>`;
    el.querySelector('#co-back').onclick = () => { this.view = 'shop'; this.render(el); };
    setTimeout(() => { const n = el.querySelector('#co-name'); n.value ? el.querySelector('#co-note').focus() : n.focus(); }, 60);
    el.querySelector('#co-ok').onclick = async () => {
      const name = el.querySelector('#co-name').value.trim(), err = el.querySelector('#co-err');
      if (!name) { err.textContent = 'กรุณากรอกชื่อผู้ขอสั่งซื้อ'; el.querySelector('#co-name').classList.add('err'); el.querySelector('#co-name').focus(); return; }
      if (Cart.load().some(x => !(+x.qty > 0))) { err.textContent = 'มีรายการที่จำนวนไม่ถูกต้อง — กลับไปแก้ไขในตะกร้า'; return; }
      const b = el.querySelector('#co-ok'); b.disabled = true;
      try {
        const r = await api('shop_request_save', name, el.querySelector('#co-note').value, Cart.load().map(x => ({ name: x.name, qty: x.qty, unit: x.unit, spec: x.spec || '' })));
        localStorageSet('shopName', name); Cart.save([]); this.last = r; this.view = 'done'; App.renderHeader(); await App.bumpRev(); this.render(el);
      } catch (e) { err.textContent = e.message; b.disabled = false; }
    };
  },

  /* ---------- confirmation ---------- */
  done(el) {
    const r = this.last; if (!r) { this.view = 'shop'; return this.render(el); }
    el.innerHTML = `<div class="page shop-co"><section class="co-card done">
      <div class="done-top">${sticker('check', 92, 'hero')}<div><div class="done-t">สั่งแล้ว — บันทึกคำขอเรียบร้อย</div><div class="done-s">Request saved in HRM Stock · Officer เห็นคำขอนี้ได้ที่เมนู ประวัติคำขอ</div></div>
        <span class="grow"></span><div class="done-id"><span>เลขที่คำขอ · Request ID</span><b>${esc(r.id)}</b></div></div>
      <div class="kv done-kv"><span class="k">วันที่</span><span>${fmtD(r.created_at)} ${fmtTime(r.created_at)}</span><span class="k">ผู้ขอสั่งซื้อ</span><span><b>${esc(r.requester)}</b></span>
        ${r.note ? `<span class="k">หมายเหตุ</span><span>${esc(r.note)}</span>` : ''}</div>
      <div class="co-table">
        <div class="co-row co-th"><span>#</span><span>รายการ</span><span>หมวดหมู่</span><span class="r">จำนวน</span><span>หน่วย</span></div>
        ${r.items.map((x, i) => `<div class="co-row"><span class="faint num">${i + 1}</span><span class="co-name">${shopPic(x.art, 40)}<span class="co-n"><span>${esc(x.name)}${specChip(x)}</span>${ShopCode.tag(x, 'sm')}</span></span><span class="muted">${esc(x.cat)}</span><span class="r num co-q">${fmtQty(x.qty)}</span><span>${esc(x.unit)}</span></div>`).join('')}
      </div>
      <div class="done-trk">${shopTrack(r, 'go')}</div>
      <p class="hint">ติดตามความคืบหน้าได้ที่หน้าหลัก · คำขอนี้บันทึกไว้ในระบบภายในแผนกเท่านั้น — ยังไม่ได้ส่งถึงฝ่ายจัดซื้อ ใช้ปุ่ม พิมพ์ หรือ คัดลอก เพื่อส่งต่อตามขั้นตอนของบริษัท</p>
      <footer class="co-f"><button class="btn btn-plain lg" id="d-copy">${ic('doc')}${bi('คัดลอกรายการ', 'Copy')}</button><button class="btn btn-plain lg" id="d-print">${ic('print')}${bi('พิมพ์ใบขอสั่งซื้อ', 'Print')}</button>
        <span class="grow"></span><button class="btn btn-primary lg" id="d-new">${ic('plus')}${bi('สร้างคำขอสั่งซื้อใหม่', 'New request')}</button></footer>
    </section></div>`;
    el.querySelector('#d-copy').onclick = async () => toast(await copyText(requestText(r)) ? 'คัดลอกรายการแล้ว' : 'คัดลอกไม่สำเร็จ', r.id, 'info');
    el.querySelector('#d-print').onclick = () => printRequest(r);
    el.querySelector('#d-new').onclick = () => { this.view = 'shop'; this.last = null; this.render(el); };
  },
};

/* =============================== HISTORY =============================== */
PAGES.shophist = {
  title: ['ประวัติคำขอสั่งซื้อ', 'Request history'], q: '', f: 'all',
  async render(el) {
    const [list] = await Promise.all([api('shop_requests'), ShopCode.ensure()]);
    const cnt = k => list.filter(r => k === 'all' || r.status === k).length;
    el.innerHTML = `<div class="page">
      <div class="toolbar"><div class="seg" id="hf">${[['all', 'ทั้งหมด'], ['saved', 'สั่งแล้ว'], ['acknowledged', 'รับคำสั่ง'], ['ordered', 'รอจัดส่ง'], ['delivered', 'จัดส่งสำเร็จ'], ['cancelled', 'ยกเลิก']].map(([k, t]) => `<button data-f="${k}" class="${this.f === k ? 'on' : ''}">${t}<span class="n">${cnt(k)}</span></button>`).join('')}</div>
        <span class="grow"></span><label class="search">${ic('search', 'sm')}<input class="input" id="hq" placeholder="ค้นหาเลขที่ / ผู้ขอ / สินค้า…" value="${esc(this.q)}"></label>
        <button class="btn btn-plain" data-hbk title="ดาวน์โหลดคำขอทั้งหมดเป็น Excel">${ic('download', 'sm')}${bi('Backup Excel', 'ALL REQUESTS')}</button>
        <button class="btn btn-plain" data-hsum title="พิมพ์ / บันทึก PDF ฟอร์มสรุปตามตัวกรองที่เลือก">${ic('print', 'sm')}${bi('ฟอร์มสรุป', 'SUMMARY FORM')}</button>
        <button class="btn btn-primary" data-go="shop">${ic('plus', 'sm')}${bi('สร้างคำขอใหม่', 'New request')}</button></div>
      <div class="rhead g-req"><span>เลขที่คำขอ<span class="en">Request ID</span></span><span>วันที่</span><span>ผู้ขอสั่งซื้อ</span><span class="r">รายการ</span><span>รายละเอียดสินค้า</span><span>สถานะ</span></div>
      <div class="rows" id="hrows"></div></div>`;
    const draw = () => {
      const q = this.q.toLowerCase();
      const rows = list.filter(r => (this.f === 'all' || r.status === this.f) && (!q || (r.id + ' ' + r.requester + ' ' + r.items.map(itemText).join(' ')).toLowerCase().includes(q)));
      $('#hrows').innerHTML = rows.length ? rows.map(r => `<div class="rrow g-req click" data-rid="${esc(r.id)}">
          <span class="req-id">${esc(r.id)}</span><span>${bi(fmtD(r.created_at), fmtTime(r.created_at))}</span><span>${whoPill(r.requester)}</span>
          <span class="r num" style="font-weight:700">${r.items.length}</span>
          <span class="req-pics">${r.items.slice(0, 5).map(i => shopPic(i.art, 30)).join('')}<span class="req-names">${r.items.map(i => `<b>${esc(i.name)}</b>${i.spec ? ` <small>(${esc(i.spec)})</small>` : ''} <span class="q">×${fmtQty(i.qty)} ${esc(i.unit)}</span>`).join('<i>·</i>')}</span></span>
          <span>${shopStatusBadge(r)}</span></div>`).join('')
        : `<div class="card">${emptyState('history', list.length ? 'ไม่พบคำขอที่ตรงกับตัวกรอง' : 'ยังไม่มีคำขอสั่งซื้อ', 'No requests', list.length ? '' : 'เริ่มได้ที่เมนู ขอสั่งซื้ออุปกรณ์', `<button class="btn btn-primary" data-go="shop">${ic('plus', 'sm')}สร้างคำขอ</button>`, true)}</div>`;
    };
    draw();
    el.querySelector('#hf').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; this.f = b.dataset.f; $$('#hf button').forEach(x => x.classList.toggle('on', x === b)); draw(); };
    el.querySelector('#hq').oninput = e => { this.q = e.target.value; draw(); };
    const filtered = () => { const q = this.q.toLowerCase(); return list.filter(r => (this.f === 'all' || r.status === this.f) && (!q || (r.id + ' ' + r.requester + ' ' + r.items.map(itemText).join(' ')).toLowerCase().includes(q))); };
    el.onclick = async e => {
      if (e.target.closest('[data-hbk]')) { try { const r = await backupRequestsXlsx(list); toast('Backup คำขอแล้ว', `${esc(r.name)} · ${r.requests} คำขอ · ${r.items} รายการ`); } catch (er) { toastErr(er); } return; }
      if (e.target.closest('[data-hsum]')) { const l = filtered(); if (!l.length) return toast('ไม่มีคำขอตามตัวกรอง', '', 'warn'); const lbl = { all: 'ทั้งหมด', saved: 'สั่งแล้ว', acknowledged: 'รับคำสั่ง', ordered: 'รอจัดส่ง', delivered: 'จัดส่งสำเร็จ', cancelled: 'ยกเลิก' }[this.f] || ''; return printRequestSummary(l, `${lbl}${this.q ? ' · “' + this.q + '”' : ''} · ${l.length} คำขอ`); }
      const g = e.target.closest('[data-go]'); if (g) { PAGES.shop.view = 'shop'; return App.go(g.dataset.go); }
      const r = e.target.closest('[data-rid]'); if (r) this.detail(list.find(x => x.id === r.dataset.rid));
    };
  },
  async detail(r) {
    await ShopCode.ensure().catch(() => null);
    const cat = await api('shop_catalog').catch(() => null), cp = {};
    (cat?.cats || []).forEach(c => (c.items || []).forEach(i => { if (i.price != null) cp[i.id] = i.price; }));
    const priceOf = x => x.price != null ? x.price : (x.item_id != null && cp[x.item_id] != null ? cp[x.item_id] : null);
    const costRows = () => {
      let sum = 0, miss = 0;
      const rows = r.items.map((x, i) => {
        const pr = priceOf(x), amt = pr == null ? null : pr * x.qty; if (amt == null) miss++; else sum += amt;
        return `<div class="rq-cost-r"><span class="nm">${esc(x.name)}<small>${fmtQty(x.qty)} ${esc(x.unit)}</small></span>
          ${App.officer ? `<label class="sp-pin"><span>฿</span><input class="input num" data-pi="${i}" inputmode="decimal" value="${x.price ?? ''}" placeholder="${x.item_id != null && cp[x.item_id] != null ? 'ตามรายการ ' + nf.format(cp[x.item_id]) : 'ราคา/' + esc(x.unit)}"></label>` : `<span class="pr num">${pr == null ? '—' : fmtB(pr)}</span>`}
          <span class="amt num ${amt == null ? 'none' : ''}">${amt == null ? 'ยังไม่มีราคา' : fmtB(amt)}</span></div>`;
      }).join('');
      return `${rows}<div class="rq-cost-t"><span>รวม${miss ? ` <small>(ไม่รวม ${miss} รายการที่ยังไม่มีราคา)</small>` : ''}</span><b class="num">${fmtB(sum)}</b></div>`;
    };
    openPanel({
      title: r.id, en: `Purchase request · ${r.requester}`, icon: 'doc',
      body: `<div style="display:flex;align-items:center;gap:12px">${shopStatusBadge(r)}<span class="muted">${fmtD(r.created_at)} ${fmtTime(r.created_at)}</span></div>
        <div class="done-trk">${shopTrack(r)}</div>
        <div class="kv"><span class="k">ผู้ขอสั่งซื้อ</span><span><b>${esc(r.requester)}</b></span>${r.note ? `<span class="k">หมายเหตุ</span><span>${esc(r.note)}</span>` : ''}
          ${r.status_by ? `<span class="k">อัปเดตสถานะ</span><span>${esc(r.status_by)} · ${fmtD(r.status_at)} ${fmtTime(r.status_at)}${r.status_note ? ' · ' + esc(r.status_note) : ''}</span>` : ''}</div>
        <div class="co-table">${r.items.map((x, i) => `<div class="co-row sm"><span class="faint num">${i + 1}</span><span class="co-name">${shopPic(x.art, 36)}<span class="co-n"><span>${esc(x.name)}${specChip(x)}</span>${ShopCode.tag(x, 'sm')}</span>${App.officer && !x.item_id ? `<button class="link promo-l" data-promote="${esc(x.name)}" data-pu="${esc(x.unit)}" title="เพิ่มเป็นสินค้าในหมวดหมู่">${ic('plus', 'sm')}เพิ่มเป็นสินค้าถาวร</button>` : ''}</span><span class="r num co-q">${fmtQty(x.qty)}</span><span>${esc(x.unit)}</span></div>`).join('')}</div>
        ${App.officer ? `<div class="field"><label>อัปเดตสถานะ <span class="en">Officer</span></label><div class="seg" id="st">${Object.entries({ saved: 'สั่งแล้ว', acknowledged: 'รับคำสั่ง', ordered: 'รอจัดส่ง', delivered: 'จัดส่งสำเร็จ', cancelled: 'ยกเลิก' }).map(([k, t]) => `<button data-st="${k}" class="${r.status === k ? 'on' : ''}">${t}</button>`).join('')}</div></div>
          <div class="field" style="margin-top:12px"><label>วันที่ของจะมาส่ง <span class="en">EXPECTED DELIVERY · เว้นว่างได้</span></label><div style="display:flex;gap:8px"><input class="input" type="date" id="rq-due" value="${esc(r.expected_date || '')}" style="max-width:220px"><button class="btn btn-plain sm" data-due>${ic('check', 'sm')}บันทึกวันส่ง</button></div></div>`
          : r.expected_date ? `<div class="hint" style="margin-top:8px">${ic('truck', 'sm')} กำหนดส่ง ${fmtD(r.expected_date)}</div>` : ''}
        <section class="rq-cost"><header>${ic('coins', 'sm')}${bi('ค่าใช้จ่าย', 'COST · รวมในสรุปค่าใช้จ่ายรายเดือน')}<span class="grow"></span>${App.officer ? `<button class="btn btn-plain sm" data-psave>${ic('check', 'sm')}บันทึกราคา</button>` : ''}</header>
          <div id="rq-cost">${costRows()}</div>${App.officer ? '<div class="hint">เว้นว่าง = ใช้ราคาจากรายการสินค้า · รายการพิมพ์เองต้องใส่ราคาที่นี่</div>' : ''}</section>`,
      foot: `<button class="btn btn-plain" data-copy>${ic('doc', 'sm')}คัดลอกรายการ</button><button class="btn btn-primary" data-print>${ic('print', 'sm')}พิมพ์ใบขอสั่งซื้อ</button>`,
      onMount: (p, close) => {
        setTimeout(() => p.querySelector('.trk')?.classList.add('go'), 120);
        p.addEventListener('click', e => {
          const pm = e.target.closest('[data-promote]'); if (!pm) return;
          close(); PAGES.shop.cat ? PAGES.shop.promote(pm.dataset.promote, pm.dataset.pu) : api('shop_catalog').then(c => { PAGES.shop.cat = c; PAGES.shop.items = c.cats.flatMap(k => k.items.map(i => ({ ...i, cat: k.name }))); PAGES.shop.memo = PAGES.shop.memo || { by: new Map(), list: [] }; PAGES.shop.promote(pm.dataset.promote, pm.dataset.pu); });
        });
        p.querySelector('[data-copy]').onclick = async () => toast(await copyText(requestText(r)) ? 'คัดลอกรายการแล้ว' : 'คัดลอกไม่สำเร็จ', r.id, 'info');
        p.querySelector('[data-print]').onclick = () => printRequest(r);
        p.querySelector('[data-psave]')?.addEventListener('click', async ev => {
          const btn = ev.currentTarget, prices = r.items.map((x, i) => p.querySelector(`[data-pi="${i}"]`)?.value ?? '');
          btn.disabled = true;
          try { r = await api('shop_request_prices', r.id, prices); p.querySelector('#rq-cost').innerHTML = costRows(); toast('บันทึกราคาแล้ว', `${esc(r.id)} · อัปเดตสรุปค่าใช้จ่ายแล้ว`); App.bumpRev(); }
          catch (er) { toastErr(er); } finally { btn.disabled = false; }
        });
        p.querySelector('[data-due]')?.addEventListener('click', async () => {
          try { await api('shop_request_date', r.id, p.querySelector('#rq-due').value || ''); close(); toast('บันทึกวันส่งแล้ว', r.id); await App.bumpRev(); App.refresh(); } catch (er) { toastErr(er); }
        });
        p.querySelector('#st')?.addEventListener('click', async e => {
          const b = e.target.closest('[data-st]'); if (!b || b.dataset.st === r.status) return;
          try { await api('shop_request_status', r.id, b.dataset.st, '', b.dataset.st === 'ordered' ? (p.querySelector('#rq-due')?.value || null) : null); close(); toast('อัปเดตสถานะแล้ว', r.id); await App.bumpRev(); App.refresh(); } catch (er) { toastErr(er); }
        });
      },
    });
  },
};

App.updateShopBadge = () => { const a = $('#side [data-go="shop"] .cnt'); if (!a) return; const n = Cart.count(); a.textContent = n; a.className = 'cnt abn' + (n ? '' : ' hidden'); };

/* ===== people.js ===== */
/* =====================================================================
   PEOPLE & EMOJI — hand-drawn chibi faces next to names (requests, notifications, header)
   12 operator emotions (no two people share one) + the Officer (long golden hair).
   The Officer can rename people and swap faces in Settings → ทีมงาน & Emoji.
   ===================================================================== */
'use strict';

const FACES = [
  ['happy', 'ยิ้มแฉ่ง', 'Happy'], ['laugh', 'ขำกลิ้ง', 'Laughing'], ['think', 'ครุ่นคิด', 'Thinking'], ['shock', 'ตกใจ', 'Surprised'],
  ['sleepy', 'ง่วงนอน', 'Sleepy'], ['fight', 'มุ่งมั่น', 'Determined'], ['shy', 'เขินอาย', 'Shy'], ['wink', 'ขยิบตา', 'Wink'],
  ['grumpy', 'หงุดหงิด', 'Grumpy'], ['sad', 'เศร้า', 'Sad'], ['cool', 'เท่ๆ', 'Cool'], ['starry', 'ตาเป็นประกาย', 'Excited'],
].map(([k, th, en]) => ({ k, th, en }));
const OFFICER_FACE = { k: 'officer', th: 'ยิ้มหวาน', en: 'Officer' };
/* the team (names as the Officer gave them) — each with one of the 12 faces; JILL is the Officer and always shows the Officer face.
   3 shift teams: A · B · C (the Officer can move people between teams later in ตั้งค่า › ทีมงาน) */
const TEAMS = ['A', 'B', 'C'];
const TEAM_NAMES = ['NES', 'NU', 'JOE', 'SONG', 'WAT', 'NOOM', 'BAS', 'TIME', 'JILL', 'SUT', 'OIL', 'MOS'];
const DEFAULT_PEOPLE = [['NES', 'happy', 'A'], ['NU', 'shy', 'A'], ['JOE', 'cool', 'A'], ['SONG', 'laugh', 'A'],
  ['WAT', 'think', 'B'], ['NOOM', 'sleepy', 'B'], ['BAS', 'fight', 'B'], ['TIME', 'starry', 'B'],
  ['JILL', 'wink', 'C'], ['SUT', 'grumpy', 'C'], ['OIL', 'shock', 'C'], ['MOS', 'sad', 'C']].map(([name, face, team]) => ({ name, face, team }));
const TEAM_OF = Object.fromEntries(DEFAULT_PEOPLE.map(p => [p.name, p.team]));

/* one background colour per person — never shared (14 colours ≥ 12 faces; the first 12 sit 30° apart on the colour wheel), gold stays the Officer's */
const PERSON_COLORS = [['c1', 210, 'ฟ้า'], ['c2', 122, 'เขียว'], ['c3', 0, 'แดง'], ['c4', 270, 'ม่วง'], ['c5', 28, 'ส้ม'], ['c6', 180, 'เขียวน้ำทะเล'],
  ['c7', 62, 'เหลืองมะนาว'], ['c8', 300, 'บานเย็น'], ['c9', 240, 'คราม'], ['c10', 152, 'มิ้นต์'], ['c11', 332, 'ชมพู'], ['c12', 92, 'เขียวอ่อน'],
  ['c13', 195, 'ฟ้าน้ำแข็ง'], ['c14', 285, 'พลัม']].map(([k, h, th]) => ({ k, h, th }));

const People = {
  /** every name the helper can suggest: saved team + the default team + the Officer */
  names() {
    const out = [], seen = new Set();
    [...this.list().map(p => p.name), ...TEAM_NAMES, App.info?.officer_name].forEach(n => { const k = this.key(n); if (k && !seen.has(k)) { seen.add(k); out.push(String(n).trim()); } });
    return out;
  },
  raw() { return (App.info && Array.isArray(App.info.people) && App.info.people.length) ? App.info.people : DEFAULT_PEOPLE; },
  /** team with a colour each — saved colours kept, anyone without one gets the first free colour (so no two people share) */
  list() {
    const raw = this.raw();
    if (this._lc && this._lc.src === raw) return this._lc.out;
    const used = new Set(), out = raw.map(p => ({ ...p }));
    out.forEach(p => { if (p.color && PERSON_COLORS.some(c => c.k === p.color) && !used.has(p.color)) used.add(p.color); else delete p.color; });
    out.forEach(p => { if (!p.color) { const f = PERSON_COLORS.find(c => !used.has(c.k)); if (f) { p.color = f.k; used.add(f.k); } } });
    out.forEach(p => { if (!TEAMS.includes(p.team)) { const t = p.team === '' ? '' : TEAM_OF[String(p.name || '').trim().toUpperCase()]; p.team = t || ''; } });   // saved lists from before teams → default team by name
    this._lc = { src: raw, out }; return out;
  },
  /** ทีม A / B / C of a name ('' = no team) */
  teamOf(name) { const k = this.key(name), p = this.list().find(x => this.key(x.name) === k); return p ? p.team || '' : (k === this.key(App.info?.officer_name) ? TEAM_OF[k] || '' : ''); },
  /** hue of a name's colour: team member → their colour · Officer → gold · anyone else → a stable colour from the name */
  hue(name) {
    const k = this.key(name); if (!k) return 220;
    const off = this.key(App.info?.officer_name);
    if (k === 'OFFICER' || (off && k === off)) return 44;
    const p = this.list().find(x => this.key(x.name) === k), c = p && PERSON_COLORS.find(x => x.k === p.color);
    if (c) return c.h;
    let h = 0; for (const ch of k) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PERSON_COLORS[h % PERSON_COLORS.length].h;
  },
  key(n) { return String(n || '').replace(/\s+/g, '').toUpperCase(); },
  faceSrc(k) { return (typeof FACE_ART !== 'undefined' && FACE_ART[k]) || `img/faces/${k}.svg`; },
  faceInfo(k) { return k === 'officer' ? OFFICER_FACE : FACES.find(f => f.k === k) || FACES[0]; },
  /** which face a name gets: Officer name → Officer · known person → their face · anyone else → a stable face from the name */
  faceOf(name) {
    const k = this.key(name);
    if (!k) return null;
    const off = this.key(App.info?.officer_name);
    if (k === 'OFFICER' || (off && k === off)) return 'officer';
    const p = this.list().find(x => this.key(x.name) === k);
    if (p) return p.face;
    let h = 0; for (const c of k) h = (h * 31 + c.codePointAt(0)) >>> 0;
    return FACES[h % FACES.length].k;
  },
  /** <img> avatar (round tile) — size in px */
  avatar(name, size = 36, cls = '') {
    const f = this.faceOf(name);
    if (!f) return `<span class="pav none ${cls}" style="--s:${size}px">?</span>`;
    const info = this.faceInfo(f);
    return `<span class="pav f-${f} ${cls}" style="--s:${size}px;--wh:${this.hue(name)}" title="${esc(name)} · ${esc(info.th)}"><img src="${this.faceSrc(f)}" alt="" loading="lazy" decoding="async"></span>`;
  },

  /* ---------- Settings card (Officer edits names / faces) ---------- */
  card() {
    if (this._draft) { App.info.people = this._draft; this._draft = null; }   // unsaved edits survive the page's app_info refresh
    const ppl = this.list(), off = App.info?.officer_name || 'Officer';
    const row = (p, i) => `<div class="ppl-row" data-i="${i}" style="--wh:${(PERSON_COLORS.find(c => c.k === p.color) || PERSON_COLORS[0]).h}">${this.avatar(p.name || '?', 44)}
        <input class="input" data-n value="${esc(p.name)}" placeholder="ชื่อเล่น" maxlength="30">
        <button class="ppl-face" data-pick="${i}" title="เปลี่ยน Emoji"><img src="${this.faceSrc(p.face)}" alt=""><span>${esc(this.faceInfo(p.face).th)}</span>${ic('chevD', 'sm')}</button>
        <button class="ppl-col" data-col="${i}" style="--wh:${(PERSON_COLORS.find(c => c.k === p.color) || PERSON_COLORS[0]).h}" title="สีพื้นหลัง · ${esc((PERSON_COLORS.find(c => c.k === p.color) || PERSON_COLORS[0]).th)} — คลิกเพื่อเปลี่ยน" aria-label="เปลี่ยนสีพื้นหลัง"><i></i></button>
        <span class="ppl-team" role="group" aria-label="ทีม">${TEAMS.map(t => `<button data-team="${i}|${t}" class="${p.team === t ? 'on' : ''}" title="ย้ายไปทีม ${t}">${t}</button>`).join('')}</span>
        <button class="icon-btn sm" data-del="${i}" title="ลบ">${ic('x', 'sm')}</button></div>`;
    const groups = [...TEAMS, ''].map(t => ({ t, rows: ppl.map((p, i) => [p, i]).filter(([p]) => (p.team || '') === t) })).filter(g => g.t || g.rows.length);
    // the Officer belongs to a team too (JILL → C); shown on that team's header when not listed as a member
    const offK = this.key(off), offListed = ppl.some(p => this.key(p.name) === offK), offTeam = offListed ? '' : (TEAM_OF[offK] || '');
    const grp = g => `<div class="ppl-tg" data-tg="${g.t}"><div class="ppl-th"><span class="ppl-tb">${g.t ? 'ทีม ' + g.t : 'ยังไม่มีทีม'}</span><span class="en">${g.t ? 'TEAM ' + g.t : 'NO TEAM'} · ${g.rows.length + (offTeam === g.t && g.t ? 1 : 0)} คน</span>${offTeam === g.t && g.t ? `<span class="ppl-offchip">${this.avatar(off, 22)}${esc(off)} · Officer</span>` : ''}<span class="grow"></span>
        ${App.officer && g.t ? `<button class="link" data-padd="${g.t}">${ic('plus', 'sm')}เพิ่มคนในทีม ${g.t}</button>` : ''}</div>
      <div class="ppl-grid">${g.rows.map(([p, i]) => row(p, i)).join('') || `<div class="ppl-none">ยังไม่มีสมาชิก — กด “เพิ่มคน” หรือย้ายคนจากทีมอื่นด้วยปุ่ม A / B / C</div>`}</div></div>`;
    return `<section class="card ppl-card" style="grid-column:1/-1"><div class="card-h">${tile('user', 'var(--primary)', 'sm')}<div class="title">${bi('ทีมงาน & Emoji', 'TEAM · EMOJI FACES')}</div><span class="grow"></span>
        ${App.officer ? `<button class="btn btn-plain sm" data-shuffle>${ic('refresh', 'sm')}สุ่มใหม่</button><button class="btn btn-primary sm" data-psave>${ic('check', 'sm')}บันทึก</button>` : ''}</div>
      <div class="ppl-officer">${this.avatar(off, 64)}<div>${bi(`${off} · Officer`, 'ผมยาวสีทอง · ' + OFFICER_FACE.th)}<span class="hint">Officer ใช้ Emoji นี้เสมอ (ตามชื่อ Officer ในหน้า ตั้งค่า)</span></div></div>
      <div class="ppl-teams" id="pplg">${groups.map(grp).join('')}</div>
      ${App.officer ? `<p class="hint">3 ทีม A · B · C — ย้ายทีมด้วยปุ่ม A / B / C ท้ายแถว · ชื่อที่พิมพ์ตอนบันทึก (OPS / ผู้ขอสั่งซื้อ) ตรงกับชื่อในรายการนี้ จะแสดง Emoji ของคนนั้น · 1 Emoji และ 1 สีต่อ 1 คน ไม่ซ้ำกัน · แก้แล้วกด บันทึก</p>` : '<p class="hint">เฉพาะ Officer แก้ไขรายชื่อและทีมได้</p>'}
    </section>`;
  },
  bindCard(el, rerender) {
    const box = el.querySelector('.ppl-card'); if (!box) return;
    let ppl = this.list().map(p => ({ ...p }));
    const sync = () => { $$('.ppl-row', box).forEach(r => { ppl[+r.dataset.i].name = r.querySelector('[data-n]').value.trim(); }); };
    const redraw = () => { App.info.people = this._draft = ppl; rerender(); };
    if (!App.officer) { $$('input', box).forEach(i => i.disabled = true); $$('[data-pick],[data-del],[data-col],[data-team]', box).forEach(b => b.disabled = true); return; }
    box.addEventListener('click', async e => {
      const t = e.target.closest('[data-pick],[data-del],[data-padd],[data-shuffle],[data-psave],[data-col],[data-team]'); if (!t) return;
      sync();
      if (t.dataset.del !== undefined) { ppl.splice(+t.dataset.del, 1); return redraw(); }
      if (t.dataset.padd !== undefined) {
        const used = new Set(ppl.map(p => p.face)), free = FACES.find(f => !used.has(f.k));
        if (!free) return toast('ครบ 12 Emoji แล้ว', '1 Emoji ต่อ 1 คน — ลบหรือเปลี่ยนคนเดิมก่อน', 'warn');
        const usedC = new Set(ppl.map(p => p.color)), freeC = PERSON_COLORS.find(c => !usedC.has(c.k));
        ppl.push({ name: '', face: free.k, color: freeC && freeC.k, team: TEAMS.includes(t.dataset.padd) ? t.dataset.padd : '' }); return redraw();
      }
      if (t.dataset.team !== undefined) {
        const [i, tm] = t.dataset.team.split('|'); ppl[+i].team = ppl[+i].team === tm ? '' : tm; return redraw();
      }
      if (t.dataset.shuffle !== undefined) {
        const f = FACES.map(x => x.k).sort(() => Math.random() - .5); ppl = ppl.map((p, i) => ({ ...p, face: f[i % f.length] })); return redraw();
      }
      if (t.dataset.psave !== undefined) {
        try { App.info.people = await api('people_save', ppl.filter(p => p.name)); toast('บันทึกทีมงานแล้ว', 'Emoji แสดงทุกเครื่อง'); rerender(); } catch (er) { toastErr(er); }
        return;
      }
      if (t.dataset.col !== undefined) {
        const i = +t.dataset.col;
        const pick = await this.pickColor(ppl[i].color, ppl.map((p, j) => j !== i && p.color).filter(Boolean));
        if (!pick) return;
        const other = ppl.findIndex((p, j) => j !== i && p.color === pick);
        if (other >= 0) ppl[other].color = ppl[i].color;        // swap — colours stay unique
        ppl[i].color = pick; return redraw();
      }
      if (t.dataset.pick !== undefined) {
        const i = +t.dataset.pick;
        const pick = await this.pickFace(ppl[i].face, ppl.map((p, j) => j !== i && p.face).filter(Boolean));
        if (!pick) return;
        const other = ppl.findIndex((p, j) => j !== i && p.face === pick);
        if (other >= 0) ppl[other].face = ppl[i].face;          // swap — faces stay unique
        ppl[i].face = pick; redraw();
      }
    });
  },
  pickColor(cur, taken) {
    return new Promise(res => {
      let done = false;
      openPanel({
        title: 'เลือกสีพื้นหลัง', en: 'PICK A COLOUR · 1 คน 1 สี', icon: 'user',
        body: `<div class="col-grid">${PERSON_COLORS.map(c => { const who = this.list().find(p => p.color === c.k && taken.includes(c.k));
          return `<button class="col-opt ${c.k === cur ? 'on' : ''}" data-c="${c.k}" style="--wh:${c.h}"><i></i><b>${esc(c.th)}</b><small>${who ? 'ใช้อยู่ · ' + esc(who.name) + ' · สลับกัน' : 'ว่าง'}</small></button>`; }).join('')}</div>`,
        onMount: (p, close) => {
          p.querySelector('.col-grid').onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; done = true; close(); res(b.dataset.c); };
          const obs = new MutationObserver(() => { if (!p.isConnected) { obs.disconnect(); if (!done) res(null); } });
          obs.observe(document.body, { childList: true });
        },
      });
    });
  },
  pickFace(cur, taken) {
    return new Promise(res => {
      let done = false;
      openPanel({
        title: 'เลือก Emoji', en: 'PICK A FACE · 1 คน 1 Emoji', icon: 'user',
        body: `<div class="face-grid">${FACES.map(f => `<button class="face-opt ${f.k === cur ? 'on' : ''}" data-f="${f.k}"><img src="${this.faceSrc(f.k)}" alt=""><b>${esc(f.th)}</b><small>${taken.includes(f.k) ? 'มีคนใช้แล้ว · สลับกัน' : f.en}</small></button>`).join('')}</div>`,
        onMount: (p, close) => {
          p.querySelector('.face-grid').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; done = true; close(); res(b.dataset.f); };
          const obs = new MutationObserver(() => { if (!p.isConnected) { obs.disconnect(); if (!done) res(null); } });
          obs.observe(document.body, { childList: true });
        },
      });
    });
  },
};

/* =====================================================================
   NAME HELPER — type "J" → JILL / JOE … on every name field (OPS, ผู้ขอสั่งซื้อ, ลงชื่อผู้สั่ง, มือถือ)
   ↑ ↓ choose · Enter / Tab accept · Esc close · tap on the phone
   ===================================================================== */
const NameAssist = {
  SEL: '#ops, #mops, #co-name, #ob-who, #no-w, #mb-name, .ops-in, [data-names]',
  box: null, inp: null, items: [], at: 0,
  /* names this computer uses most come first — counted per device (no server traffic) */
  uses() { try { return JSON.parse(localStorage.getItem('hrmNameUse') || '{}') || {}; } catch (e) { return {}; } },
  count(n) {
    const k = People.key(n); if (!k || !People.names().some(x => People.key(x) === k)) return;
    const u = this.uses(); u[k] = (u[k] || 0) + 1;
    try { localStorage.setItem('hrmNameUse', JSON.stringify(u)); } catch (e) { /* private window — ranking just stays alphabetical */ }
  },
  /** the date a name field belongs to (OPS of that day) → team on shift that day */
  dateOf(inp) {
    if (inp?.dataset?.date) return inp.dataset.date;
    if (inp?.id === 'ops') return PAGES.entry?.date || App.today;
    if (inp?.id === 'mops' && typeof Mobile !== 'undefined') return Mobile.date || App.today;
    return App.today;
  },
  shiftTeam: '',
  match(v) {
    const q = People.key(v), u = this.uses(), all = People.names(), ST = this.shiftTeam;
    const onShift = n => ST && People.teamOf(n) && ST.includes(People.teamOf(n)) ? 1 : 0;   // people of the team on shift come first
    const rank = (a, b) => onShift(b) - onShift(a) || (u[People.key(b)] || 0) - (u[People.key(a)] || 0) || People.key(a).localeCompare(People.key(b));
    if (!q) return all.slice().sort((a, b) => onShift(b) - onShift(a) || (u[People.key(b)] || 0) - (u[People.key(a)] || 0)).slice(0, 12);
    const st = all.filter(n => People.key(n).startsWith(q)).sort(rank), inn = all.filter(n => !st.includes(n) && People.key(n).includes(q)).sort(rank);
    return st.concat(inn).slice(0, 8);
  },
  often(n) { const u = this.uses(), c = u[People.key(n)] || 0; if (c < 3) return false; return Object.values(u).filter(x => x > c).length < 3; },
  show(inp) {
    this.shiftTeam = typeof Shift !== 'undefined' && /^(ops|mops)$/.test(inp.id || '') || inp.classList?.contains('ops-in') ? Shift.teamOn(this.dateOf(inp)) : '';
    const v = inp.value, list = this.match(v);
    if (!list.length || (list.length === 1 && People.key(list[0]) === People.key(v))) return this.hide();
    this.inp = inp; this.items = list; this.at = 0;
    if (!this.box) { this.box = document.createElement('div'); this.box.className = 'nmx'; document.body.appendChild(this.box);
      this.box.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('[data-nm]'); if (b) this.pick(b.dataset.nm); }); }
    const q = People.key(v);
    this.box.innerHTML = list.map((n, i) => { const k = People.key(n), hit = q && k.startsWith(q) ? `<b>${esc(n.slice(0, q.length))}</b>${esc(n.slice(q.length))}` : esc(n);
      return `<button type="button" class="nmx-i ${i === 0 ? 'on' : ''}" data-nm="${esc(n)}">${People.avatar(n, 26)}<span>${hit}</span>${People.teamOf(n) ? `<i class="nmx-t ${this.shiftTeam && this.shiftTeam.includes(People.teamOf(n)) ? 'on' : ''}">${this.shiftTeam && this.shiftTeam.includes(People.teamOf(n)) ? 'เข้ากะ · ' : ''}ทีม ${People.teamOf(n)}</i>` : ''}${this.often(n) ? '<em>ใช้บ่อย</em>' : ''}</button>`; }).join('') +
      `<div class="nmx-h"><kbd>↑</kbd><kbd>↓</kbd> เลือก · <kbd>Enter</kbd> ใส่ชื่อ</div>`;
    const r = inp.getBoundingClientRect(), w = Math.max(r.width, 200);
    this.box.style.width = w + 'px'; this.box.style.left = Math.min(innerWidth - w - 8, r.left) + 'px';
    const h = this.box.offsetHeight; this.box.style.top = (r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6) + 'px';
    this.box.classList.add('open');
  },
  hide() { if (this.box) this.box.classList.remove('open'); this.inp = null; this.items = []; },
  move(d) { if (!this.items.length) return; this.at = (this.at + d + this.items.length) % this.items.length; $$('.nmx-i', this.box).forEach((b, i) => b.classList.toggle('on', i === this.at)); },
  pick(n) {
    const inp = this.inp; if (!inp) return;
    inp.value = n; this.hide();
    inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.focus();
  },
};
document.addEventListener('focusin', e => { if (e.target.matches?.(NameAssist.SEL)) NameAssist.show(e.target); });
document.addEventListener('input', e => { if (e.target.matches?.(NameAssist.SEL) && e.isTrusted) NameAssist.show(e.target); });
document.addEventListener('change', e => { if (e.target.matches?.(NameAssist.SEL) && e.target.value.trim()) NameAssist.count(e.target.value); });
document.addEventListener('focusout', e => { if (e.target === NameAssist.inp) setTimeout(() => { if (document.activeElement !== NameAssist.inp) NameAssist.hide(); }, 120); });
document.addEventListener('keydown', e => {   // capture: an open list takes Enter / Tab before the field's own handler
  if (!NameAssist.inp || e.target !== NameAssist.inp || !NameAssist.box?.classList.contains('open')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); NameAssist.move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); NameAssist.move(-1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); NameAssist.hide(); }
  else if ((e.key === 'Enter' || e.key === 'Tab') && NameAssist.items.length && e.target.value.trim()) {
    const n = NameAssist.items[NameAssist.at];
    if (People.key(n) !== People.key(e.target.value)) { e.preventDefault(); e.stopPropagation(); NameAssist.pick(n); }
    else NameAssist.hide();
  }
}, true);
window.addEventListener('scroll', e => { if (NameAssist.inp && !NameAssist.box?.contains(e.target)) NameAssist.hide(); }, true);

/* ===== shift.js ===== */
/* =====================================================================
   SHIFT ROTATION — ทีม A / B / C เข้ากะ (ใครรับผิดชอบลง STOCK วันไหน)
   Plan = a repeating cycle from an anchor date + per-day changes + a reminder time.
   Used by: name helper (OPS → people of the team on shift first) · Home (who hasn't recorded) · entry banner · Widget reminder.
   ===================================================================== */
'use strict';

const Shift = {
  /** saved plan (rotation fallback + remind time), or null when the Officer has not set one yet */
  plan() { const p = App.info?.shift_plan; return p && Array.isArray(p.cycle) && p.cycle.length && p.anchor ? p : null; },
  /** UACJ shift calendar {date: "DAY|NIGHT"} — from the "ปฏิทินกะ" sheet */
  cal() { return App.info?.shift_cal || null; },
  /** {day, night, note} from the calendar, or null when the date is outside it */
  calOn(ds) { const c = this.cal(), v = c && ds ? c[ds] : null; if (v == null) return null; const [day, night, note] = String(v).split('|'); return { day: day || '', night: night || '', note: note || '' }; },
  calRange() { const k = Object.keys(this.cal() || {}).sort(); return k.length ? [k[0], k[k.length - 1]] : null; },
  /** calendar or rotation in use? */
  active() { return !!(this.plan() || this.calRange()); },
  /** day-shift team(s) that record STOCK that day ('' = none; may be 'AC' on a substitution day) */
  teamOn(ds) {
    if (!ds) return '';
    const p = this.plan();
    if (p && p.overrides && Object.prototype.hasOwnProperty.call(p.overrides, ds)) return p.overrides[ds] || '';
    const c = this.calOn(ds); if (c) return c.day;
    if (!p) return '';
    const n = p.cycle.length, i = ((dayDiff(ds, p.anchor) % n) + n) % n;
    return p.cycle[i] || '';
  },
  /** is there a day shift that has to record STOCK? (unknown → yes) */
  works(ds) { return !this.active() || !!this.teamOn(ds); },
  workDays(days) { return (days || []).filter(ds => this.works(ds)); },
  note(ds) { const c = this.calOn(ds); return c ? (c.note || (!c.day && !c.night ? 'หยุด' : '')) : ''; },
  label(t) { return String(t || '').split('').join('+'); },
  members(t) {
    if (!t) return [];
    const out = People.list().filter(p => p.team && t.includes(p.team)).map(p => p.name);
    const off = App.info?.officer_name, ot = off && TEAM_OF[People.key(off)];
    if (ot && t.includes(ot) && !out.some(n => People.key(n) === People.key(off))) out.push(off);
    return out;
  },
  /** 15 min before the day shift ends (08:00–20:00) unless the Officer set another time */
  remindAt() { return this.plan()?.remind_at || '19:45'; },
  /** past the reminder time today, on a day that has a day shift? */
  late() { if (!this.works(App.today)) return false; const now = new Date(), [h, m] = this.remindAt().split(':').map(Number); return now.getHours() * 60 + now.getMinutes() >= h * 60 + m; },
  /** missing days grouped by the team that was on shift: [{team, days:[…]}] (oldest first) */
  missingByTeam(days) {
    const g = {};
    (days || []).forEach(ds => { const t = this.teamOn(ds) || '-'; (g[t] = g[t] || []).push(ds); });
    return Object.entries(g).map(([team, ds]) => ({ team: team === '-' ? '' : team, days: ds.sort() })).sort((a, b) => b.days.length - a.days.length);
  },
  /** small "ทีม X" pill */
  pill(t, cls = '') { return t ? `<span class="sh-pill ${cls}" data-t="${t[0]}">ทีม ${this.label(t)}</span>` : ''; },

  /* ---------------- Settings card ---------------- */
  card() {
    const p = this.plan() || { anchor: App.today, cycle: ['A', 'B', 'C'], overrides: {}, remind_at: '19:45' }, rg = this.calRange(), set = !!(this.plan() || rg);
    const inCal = rg && App.today >= rg[0] && App.today <= rg[1];
    this._draft = this._draft || JSON.parse(JSON.stringify(p));
    const d = this._draft, T = App.today, ed = App.officer;
    const slot = (t, i) => `<button class="sh-slot" data-slot="${i}" data-t="${t || ''}" ${ed ? '' : 'disabled'} title="วันที่ ${i + 1} ของรอบ — คลิกเพื่อเปลี่ยนทีม"><small>วัน ${i + 1}</small><b>${t || '—'}</b></button>`;
    const days = Array.from({ length: 21 }, (_, i) => addDays(T, i - 3));
    const save0 = this.plan(); App.info.shift_plan = d;            // preview uses the draft
    const prev = days.map(ds => { const t = this.teamOn(ds), ov = d.overrides && Object.prototype.hasOwnProperty.call(d.overrides, ds), dt0 = pd(ds), c = this.calOn(ds), nt = this.note(ds);
      return `<button class="sh-day ${ds === T ? 'today' : ''} ${ov ? 'ov' : ''} ${c ? 'cal' : ''}" data-day="${ds}" data-t="${t.slice(0, 1)}" ${ed ? '' : 'disabled'} title="${fmtD(ds)}${c ? ` · กะเช้า ${this.label(c.day) || '–'} · กะดึก ${this.label(c.night) || '–'}` : ''}${nt ? ' · ' + esc(nt) : ''} — คลิกเพื่อเปลี่ยนเฉพาะวันนี้">
        <small>${TH_WD[dt0.getDay()].slice(0, 2)}</small><span class="num">${dt0.getDate()}</span><b>${this.label(t) || '—'}</b>${c ? `<em>${c.night ? 'ดึก ' + this.label(c.night) : esc(nt || '')}</em>` : ''}${ov ? '<i></i>' : ''}</button>`; }).join('');
    App.info.shift_plan = save0;
    const legend = TEAMS.map(t => `<div class="sh-leg" data-t="${t}"><b>ทีม ${t}</b><span>${this.members(t).map(esc).join(' · ') || '—'}</span></div>`).join('');
    const calBox = rg ? `<div class="sh-src ${inCal ? 'on' : 'warn'}">${ic(inCal ? 'check' : 'alert', 'sm')}<span><b>ใช้ปฏิทินกะ UACJ · 3 กลุ่ม 2 กะ</b><small>${fmtDShort(rg[0])} – ${fmtDShort(rg[1])} · กะเช้า 08:00–20:00 เป็นคนลง STOCK วันละครั้ง${inCal ? '' : ' · วันนี้อยู่นอกช่วงปฏิทิน ใช้รอบสำรองด้านล่าง'}${App.info?.gas ? ' · แก้ได้ที่แผ่น “ปฏิทินกะ” ใน Google Sheet' : ''}</small></span></div>` : '';
    return `<section class="card sh-card" style="grid-column:1/-1"><div class="card-h">${tile('cal', 'var(--primary)', 'sm')}<div class="title">${bi('ปฏิทินกะ · ทีมที่ลง STOCK', 'SHIFT CALENDAR · WHO RECORDS EACH DAY')}</div><span class="grow"></span>
        ${set ? '' : '<span class="badge abn"><span class="dot"></span>ยังไม่ได้ตั้ง</span>'}${ed ? `<button class="btn btn-primary sm" data-shsave>${ic('check', 'sm')}บันทึกตารางกะ</button>` : ''}</div>
      ${calBox}
      <div class="sh-grid">
        <div class="sh-col">
          ${inCal ? `<div class="frow sh-top1"><div class="field"><label>เตือนถ้ายังไม่ลง STOCK <span class="en">Remind at</span></label><input class="input" type="time" id="sh-rt" value="${esc(d.remind_at || '19:45')}" ${ed ? '' : 'disabled'}></div></div>
          <details class="sh-fb" ${this._fbOpen ? 'open' : ''}><summary>รอบสำรอง <span class="en">ใช้เมื่อวันที่อยู่นอกช่วงปฏิทิน</span></summary>` : ''}
          <div class="frow sh-top">
            <div class="field"><label>เริ่มรอบวันที่ <span class="en">Cycle starts</span></label><input class="input" type="date" id="sh-anchor" value="${esc(d.anchor)}" ${ed ? '' : 'disabled'}></div>
            <div class="field"><label>รอบละ <span class="en">Cycle length</span></label><div class="step sh-len"><button data-len="-1" ${ed ? '' : 'disabled'}>−</button><input class="num" id="sh-len" value="${d.cycle.length}" readonly><button data-len="1" ${ed ? '' : 'disabled'}>+</button></div></div>
            ${inCal ? '' : `<div class="field"><label>เตือนถ้ายังไม่ลง STOCK <span class="en">Remind at</span></label><input class="input" type="time" id="sh-rt" value="${esc(d.remind_at || '19:45')}" ${ed ? '' : 'disabled'}></div>`}
          </div>
          <label class="sh-lbl">รอบกะ <span class="en">กดช่องเพื่อสลับ A → B → C → ว่าง</span></label>
          <div class="sh-cycle">${d.cycle.map(slot).join('')}</div>
          ${ed ? `<div class="sh-presets"><span>แบบด่วน:</span><button class="chip" data-pre="ABC">ทีมละ 1 วัน</button><button class="chip" data-pre="AABBCC">ทีมละ 2 วัน</button><button class="chip" data-pre="AAABBBCCC">ทีมละ 3 วัน</button><button class="chip" data-pre="AAAAAAABBBBBBBCCCCCCC">ทีมละ 1 สัปดาห์</button></div>` : ''}
          ${inCal ? '</details>' : ''}
          <div class="sh-legend">${legend}</div>
        </div>
        <div class="sh-col">
          <label class="sh-lbl">3 สัปดาห์นี้ <span class="en">ตัวใหญ่ = กะเช้า (ลง STOCK) · กดวันเพื่อสลับเฉพาะวันนั้น (จุด = เปลี่ยนจากปฏิทิน)</span></label>
          <div class="sh-cal">${prev}</div>
          <p class="hint">ทีมกะเช้าวันไหน ตัวช่วยพิมพ์ชื่อ OPS จะเสนอชื่อคนในทีมนั้นก่อน · ถ้าเลยเวลาเตือนแล้วยังไม่ลง STOCK หน้าหลัก, Widget และกลุ่ม LINE จะเตือนทีมนั้น · วันที่ไม่มีกะเช้า (หยุดโรงงาน) ไม่เตือนและไม่นับค้าง</p>
        </div>
      </div></section>`;
  },
  bindCard(el, rerender) {
    const box = el.querySelector('.sh-card'); if (!box || !App.officer) return;
    const d = this._draft, redraw = () => rerender();
    const cyc = s => { const i = ['A', 'B', 'C', ''].indexOf(s); return ['A', 'B', 'C', ''][(i + 1) % 4]; };
    box.querySelector('.sh-fb')?.addEventListener('toggle', e => { this._fbOpen = e.target.open; });
    box.querySelector('#sh-anchor').onchange = e => { d.anchor = e.target.value || App.today; redraw(); };
    box.querySelector('#sh-rt').onchange = e => { d.remind_at = e.target.value; };
    box.addEventListener('click', async e => {
      const s = e.target.closest('[data-slot]'); if (s) { d.cycle[+s.dataset.slot] = cyc(d.cycle[+s.dataset.slot] || ''); return redraw(); }
      const l = e.target.closest('[data-len]'); if (l) { const n = Math.max(1, Math.min(28, d.cycle.length + +l.dataset.len)); while (d.cycle.length < n) d.cycle.push(TEAMS[d.cycle.length % 3]); d.cycle.length = n; return redraw(); }
      const pr = e.target.closest('[data-pre]'); if (pr) { d.cycle = pr.dataset.pre.split(''); return redraw(); }
      const dy = e.target.closest('[data-day]'); if (dy) {
        const ds = dy.dataset.day; d.overrides = d.overrides || {};
        const save0 = App.info.shift_plan; App.info.shift_plan = Object.assign({}, d, { overrides: {} }); const base = this.teamOn(ds); App.info.shift_plan = save0;
        const cur = Object.prototype.hasOwnProperty.call(d.overrides, ds) ? d.overrides[ds] : base, nx = cyc(cur);
        if (nx === base) delete d.overrides[ds]; else d.overrides[ds] = nx;
        return redraw();
      }
      if (e.target.closest('[data-shsave]')) {
        d.remind_at = box.querySelector('#sh-rt').value;
        try { App.info.shift_plan = await api('shift_plan_save', d); this._draft = null; toast('บันทึกปฏิทินกะแล้ว', `วันนี้กะเช้า ทีม ${this.label(this.teamOn(App.today)) || '–'} · เตือน ${this.remindAt()}`); App.bumpRev(); redraw(); }
        catch (er) { toastErr(er); }
      }
    });
  },
};

/* =====================================================================
   LINE OA — แจ้งเตือนกลุ่ม LINE (บอทของระบบ Stock แยกจาก Hydraulic) · เฉพาะเวอร์ชัน Google
   token เขียนอย่างเดียว (เก็บใน Script Properties ไม่แสดงกลับ) · เปิด/ปิด · ส่งทดสอบ · ยกเลิกกลุ่ม
   ===================================================================== */
const LineUI = {
  on() { return !!(App.info?.gas && App.officer); },
  card() {
    if (!this.on()) return '';
    return `<section class="card ln-card"><div class="card-h">${tile('bell', '#06C755', 'sm')}<div class="title">${bi('แจ้งเตือนกลุ่ม LINE', 'LINE OA · STOCK BOT')}</div><span class="grow"></span><span class="ln-st" id="ln-st"></span></div>
      <div id="ln-body"><div class="ln-load">${ic('refresh', 'sm')} กำลังโหลด…</div></div></section>`;
  },
  body(s) {
    const step = (ok, th, sub) => `<li class="${ok ? 'ok' : ''}"><i>${ic(ok ? 'check' : 'minus', 'sm')}</i><span><b>${th}</b><small>${sub}</small></span></li>`;
    return `<ol class="ln-steps">
        ${step(s.has_token, 'Channel access token', s.has_token ? 'บันทึกแล้ว (ซ่อนไว้ใน Script Properties)' : 'จาก LINE Developers → Messaging API ของบอท Stock')}
        ${step(!!s.webhook, 'Webhook URL', s.webhook ? `<code>${esc(s.webhook)}</code>` : 'Deploy เป็น Web app ก่อน')}
        ${step(s.group, 'ผูกกลุ่ม', s.group ? `ผูกกลุ่มแล้ว (${esc(s.group_hint || '')}) · พิมพ์ “เช็ค” ในกลุ่มเพื่อดูสถานะ (ถ้าบอทเป็นของระบบนี้)` : 'เชิญบอทเข้ากลุ่ม แล้วพิมพ์ “ตั้งกลุ่ม” — หรือใส่ Group ID ด้านล่าง ถ้าใช้บอทร่วมกับระบบอื่น')}
        ${step(s.on && s.trigger, 'แจ้งเตือนอัตโนมัติ', s.on ? `ตรวจทุก 5 นาที · ส่งการ์ด 1 ครั้ง/วัน เมื่อเลย ${esc(s.remind_at)} แล้วกะเช้ายังไม่ลง STOCK${s.last_sent ? ' · ล่าสุด ' + fmtDShort(s.last_sent) : ''}` : 'ปิดอยู่')}
      </ol>
      <div class="frow ln-row"><div class="field"><label>${s.has_token ? 'เปลี่ยน token' : 'Channel access token'} <span class="en">write-only</span></label><input class="input" type="password" id="ln-tok" autocomplete="off" placeholder="${s.has_token ? '•••••••• (เว้นว่าง = ใช้ค่าเดิม)' : 'วาง token ที่นี่'}"></div>
        <div class="field"><label>Group ID <span class="en">ใช้บอทร่วมกับระบบอื่น · ไม่บังคับ</span></label><input class="input" id="ln-gid" autocomplete="off" spellcheck="false" placeholder="${s.group ? 'ตั้งแล้ว ' + esc(s.group_hint || '') + ' (เว้นว่าง = ใช้ค่าเดิม)' : 'C… (33 ตัว)'}"></div></div>
      <div class="ln-act"><label class="bk-sw"><span class="switch"><input type="checkbox" id="ln-on" ${s.on ? 'checked' : ''}><span></span></span><b>เปิดแจ้งเตือน LINE</b></label><span class="grow"></span>
        ${s.group ? `<button class="btn btn-ghost sm" data-ln="unbind">${ic('x', 'sm')}ยกเลิกกลุ่ม</button><button class="btn btn-tonal sm" data-ln="test">${ic('bell', 'sm')}ส่งการ์ดทดสอบ</button>` : ''}
        <button class="btn btn-primary sm" data-ln="save">${ic('check', 'sm')}บันทึก</button></div>`;
  },
  async bind(el) {
    const box = el.querySelector('.ln-card'); if (!box) return;
    const body = box.querySelector('#ln-body'), stEl = box.querySelector('#ln-st');
    const paint = s => { this.s = s; body.innerHTML = this.body(s);
      stEl.innerHTML = s.on && s.group && s.has_token ? '<span class="badge ok"><span class="dot"></span>ทำงาน</span>' : '<span class="badge"><span class="dot"></span>ยังไม่พร้อม</span>'; };
    try { paint(await api('line_status')); } catch (er) { body.innerHTML = `<div class="err-text">${esc(er.message || er)}</div>`; return; }
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-ln]'); if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.ln === 'save') { paint(await api('line_save', { token: box.querySelector('#ln-tok').value, group: box.querySelector('#ln-gid').value, on: box.querySelector('#ln-on').checked })); toast('บันทึกการแจ้งเตือน LINE แล้ว', this.s.on ? 'เปิดอยู่ · ตรวจทุก 5 นาที' : 'ปิดอยู่'); }
        else if (b.dataset.ln === 'test') { await api('line_test'); toast('ส่งการ์ดเข้ากลุ่ม LINE แล้ว'); }
        else if (b.dataset.ln === 'unbind') { paint(await api('line_unbind')); toast('ยกเลิกกลุ่มแล้ว', 'พิมพ์ “ตั้งกลุ่ม” ในกลุ่มใหม่ได้เลย'); }
      } catch (er) { toastErr(er); } finally { b.disabled = false; }
    });
  },
};

/* ===== spend.js ===== */
/* =====================================================================
   SPEND — ค่าใช้จ่ายรายเดือน
   Home card: total this month · Material vs อุปกรณ์ · Top 3 (realtime, refreshes with every change)
   Monthly summary panel: 12-month chart · every item · lines still missing a price (Officer fills them in place)
   Prices live in Material Master (ราคา/หน่วย) and the HRM Shopping catalogue; typed-in items get theirs here or on the request.
   ===================================================================== */
'use strict';

const fmtB = v => '฿' + nf.format(Math.round((+v || 0) * 100) / 100);
const fmtBk = v => v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : nf.format(v);
const SP_KIND = { material: ['Material', 'วัตถุดิบ'], supply: ['อุปกรณ์', 'Supplies'] };
const monthTh = m => `${TH_MF[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const monthEn = m => `${EN_M[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

const SpendUI = {
  cache: {},      // month → last summary (cards redraw instantly, then refresh)
  topKind: 'all',

  async get(month) {
    const d = await api('spend_summary', month || null);
    this.cache[d.month] = d; this.cache._now = this.cache._now || d.month;
    return d;
  },

  /* ---------------- Home card ---------------- */
  skeleton() {
    const d = this.cache[this.cache._now];
    return d ? this.card(d) : `<header class="cc-h">${tile('coins', 'var(--sp-mat)', 'sm')}<div><h2>ค่าใช้จ่ายเดือนนี้</h2><span class="en">Spend this month</span></div></header>
      <div class="sp-skel"><i></i><i></i><i></i></div>`;
  },
  async mount(box) {
    if (!box) return;
    box.onclick = e => {
      if (e.target.closest('[data-spsum]')) return this.open(this.cache._now);
      const k = e.target.closest('[data-spk]'); if (k) { this.topKind = k.dataset.spk; box.innerHTML = this.card(this.cache[this.cache._now]); }
    };
    try { const d = await this.get(); this.cache._now = d.month; if (box.isConnected) box.innerHTML = this.card(d); this.chip(d); }
    catch (e) { if (box.isConnected && !this.cache._now) box.innerHTML = `<header class="cc-h">${tile('coins', 'var(--sp-mat)', 'sm')}<div><h2>ค่าใช้จ่ายเดือนนี้</h2><span class="en">Spend this month</span></div></header>
      <div class="cc-empty">${ic('alert')}<div><b>โหลดสรุปค่าใช้จ่ายไม่ได้</b><span>${esc(e.message || e)}</span></div></div>`; }
  },
  /* ---------------- Home hero tile — the month's spend at a glance, no scrolling ---------------- */
  heroTile() {
    const d = this.cache[this.cache._now];
    return `<button class="cc-spend" id="spchip" data-spchip aria-label="ค่าใช้จ่ายเดือนนี้ — เปิดสรุปรายเดือน">${d ? this.heroInner(d) : `<span class="ccs-ico">${sticker('moneybag', 64)}</span><span class="ccs-tx"><span class="ccs-l">เดือนนี้จ่ายไปแล้ว</span><span class="sp-skel"><i></i></span></span>`}</button>`;
  },
  heroInner(d, shown) {
    const m = d.material.amount, s = d.supply.amount, miss = d.material.unpriced.length + d.supply.unpriced.length;
    return `<span class="ccs-ico">${sticker('moneybag', 64)}</span>
      <span class="ccs-tx">
        <span class="ccs-l">เดือนนี้จ่ายไปแล้ว <span class="en">SPENT · ${EN_M[+d.month.slice(5, 7) - 1]}</span></span>
        <b class="ccs-amt num" data-v="${d.total}">${fmtB(shown ?? d.total)}</b>
        <span class="ccs-split"><i class="m" style="flex:${m || 0}"></i><i class="s" style="flex:${s || 0}"></i>${d.total ? '' : '<i class="z"></i>'}</span>
        <span class="ccs-keys"><span class="m"><i></i>Material ฿${fmtBk(m)}</span><span class="s"><i></i>อุปกรณ์ ฿${fmtBk(s)}</span></span>
        ${miss ? `<span class="ccs-miss">${ic('alert', 'sm')}ยังไม่ใส่ราคา ${miss} รายการ</span>` : this.delta(d) || '<span class="ccs-ok">ใส่ราคาครบทุกรายการ</span>'}
      </span>`;
  },
  /** fill the hero tile; the amount counts up from what was on screen before */
  chip(d) {
    const c = $('#spchip'); if (!c) return;
    const from = +(c.querySelector('.ccs-amt')?.dataset.v ?? 0);
    c.innerHTML = this.heroInner(d, from);
    const el = c.querySelector('.ccs-amt'), to = d.total;
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmtB(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmtB(from + (to - from) * e); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  },
  delta(d) {
    const prev = (d.months || []).slice(-2)[0];
    if (!prev || !prev.total || !d.total) return '';
    const p = Math.round((d.total - prev.total) / prev.total * 100);
    if (!p) return `<span class="sp-delta flat">เท่าเดือนก่อน</span>`;
    return `<span class="sp-delta ${p > 0 ? 'up' : 'down'}" title="${TH_M[+prev.month.slice(5, 7) - 1]} ${fmtB(prev.total)}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% จากเดือนก่อน</span>`;
  },
  card(d) {
    const m = d.material, s = d.supply, tot = d.total;
    const miss = m.unpriced.length + s.unpriced.length, lines = m.lines + s.lines;
    const list = (this.topKind === 'all' ? d.items : d.items.filter(i => i.kind === this.topKind)).slice(0, 3);
    const max = list[0]?.amount || 1;
    const head = `<header class="cc-h">${tile('coins', 'var(--sp-mat)', 'sm')}<div><h2>ค่าใช้จ่ายเดือนนี้</h2><span class="en">Spend · ${monthEn(d.month)}</span></div><span class="grow"></span>
      <button class="link" data-spsum>สรุปรายเดือน ${ic('arrowR', 'sm')}</button></header>`;
    if (!lines) return head + `<div class="cc-empty">${ic('coins')}<div><b>เดือนนี้ยังไม่มีการสั่งซื้อ</b><span>ยอดจะขึ้นทันทีที่มีใบสั่ง Material หรือคำขออุปกรณ์</span></div></div>`;
    const seg = (k, th) => `<button data-spk="${k}" class="${this.topKind === k ? 'on' : ''}">${th}</button>`;
    return head + `
      <div class="sp-total"><span class="sp-big num">${fmtB(tot)}</span>${this.delta(d)}</div>
      <div class="sp-split" role="img" aria-label="Material ${fmtB(m.amount)} · อุปกรณ์ ${fmtB(s.amount)}">
        <i class="m" style="flex:${m.amount || 0};${m.amount ? 'min-width:6px' : ''}"></i><i class="s" style="flex:${s.amount || 0};${s.amount ? 'min-width:6px' : ''}"></i>${tot ? '' : '<i class="z"></i>'}</div>
      <div class="sp-keys">
        <div class="sp-k m"><i></i><span>Material<small>${m.lines} ใบสั่ง</small></span><b class="num">${fmtB(m.amount)}</b></div>
        <div class="sp-k s"><i></i><span>อุปกรณ์<small>${s.lines} รายการ${s.waiting ? ` · รอยืนยัน ${fmtB(s.waiting)}` : ''}</small></span><b class="num">${fmtB(s.amount)}</b></div>
      </div>
      <div class="sp-toph"><span>สั่งซื้อสูงสุด <b>Top 3</b></span><span class="grow"></span><div class="seg sm">${seg('all', 'ทั้งหมด')}${seg('material', 'Material')}${seg('supply', 'อุปกรณ์')}</div></div>
      ${list.length ? `<ol class="sp-top">${list.map((it, i) => `<li class="${it.kind}">
          <span class="rk">${i + 1}</span>
          <div class="nm"><b>${esc(it.name)}</b><small>${fmtN(it.qty)} ${esc(it.unit)} · ${SP_KIND[it.kind][0]}</small><span class="bar"><i style="width:${Math.max(4, it.amount / max * 100)}%"></i></span></div>
          <span class="amt num">${fmtB(it.amount)}</span></li>`).join('')}</ol>`
        : `<div class="sp-none">ยังไม่มีรายการที่ใส่ราคาแล้ว${this.topKind !== 'all' ? 'ในหมวดนี้' : ''}</div>`}
      ${miss ? `<button class="sp-miss" data-spsum>${ic('alert', 'sm')}<span><b>ยังไม่ใส่ราคา ${miss} รายการ</b> — ยอดด้านบนยังไม่รวมรายการเหล่านี้</span>${ic('arrowR', 'sm')}</button>` : ''}`;
  },

  /* ---------------- monthly summary panel ---------------- */
  open(month) {
    let cur = month || this.cache._now, d = this.cache[cur] || null, busy = false;
    const close = openPanel({
      title: 'สรุปค่าใช้จ่ายรายเดือน', en: 'Monthly spend summary', icon: 'coins', color: 'var(--sp-mat)', wide: true,
      body: `<div id="spp">${d ? '' : '<div class="sp-skel big"><i></i><i></i><i></i></div>'}</div>`,
      foot: `<span class="hint">ยอด Material = จำนวนที่สั่ง × ราคา/หน่วย (นับตามวันที่สั่ง) · อุปกรณ์ = จำนวนที่ขอ × ราคา (นับตามวันที่ขอ ไม่รวมที่ยกเลิก)</span><span class="grow"></span>
        ${App.officer ? `<button class="btn btn-tonal" data-spt>${ic('coins', 'sm')}${bi('ตารางราคา', 'PRICE LIST')}</button>` : ''}<button class="btn btn-plain" data-spx>${ic('xls', 'sm')}${bi('Excel', 'EXPORT')}</button>`,
      onMount: (p, close) => {
        const box = p.querySelector('#spp');
        const draw = () => { box.innerHTML = this.body(d); };
        const load = async m => {
          if (busy) return; busy = true; box.classList.add('loading');
          try { d = await this.get(m); cur = d.month; draw(); } catch (e) { toastErr(e); } finally { busy = false; box.classList.remove('loading'); }
        };
        if (d) draw();
        load(cur);
        const shift = k => { const [y, m] = cur.split('-').map(Number), t = y * 12 + m - 1 + k; load(`${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`); };
        p.querySelector('[data-spx]').onclick = () => d && this.xlsx(d);
        p.querySelector('[data-spt]')?.addEventListener('click', () => { close(); PriceTable.open(); });
        box.addEventListener('click', async e => {
          const nv = e.target.closest('[data-spm]'); if (nv) return shift(+nv.dataset.spm);
          if (e.target.closest('[data-spt2]')) { close(); return PriceTable.open(); }
          const b = e.target.closest('[data-spbar]'); if (b) return load(b.dataset.spbar);
          const sv = e.target.closest('[data-spset]'); if (sv) {
            const row = sv.closest('.sp-mrow'), inp = row.querySelector('input'), u = d[row.dataset.k].unpriced[+row.dataset.i];
            const ref = Object.assign({}, u.ref, { name: u.name, unit: u.unit, month: cur });
            try { sv.disabled = true; await api('spend_set_price', ref, inp.value); toast('ใส่ราคาแล้ว', `${esc(u.name)} · ${fmtB(parseNum(inp.value))} / ${esc(u.unit)}`); App.bumpRev(); await load(cur); }
            catch (er) { sv.disabled = false; toastErr(er); inp.focus(); }
          }
        });
        box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.sp-mrow input')) e.target.closest('.sp-mrow').querySelector('[data-spset]').click(); });
      },
    });
    return close;
  },
  body(d) {
    const m = d.material, s = d.supply, months = d.months || [];
    const raw = Math.max(1, ...months.map(x => x.total)), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const max = ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(k => k * mag >= raw) || 10) * mag;   // a round top for the axis
    const isNow = d.month === this.cache._now;
    // 12-month stacked bars (Material below, อุปกรณ์ on top) — click a month to open it
    const W = 760, H = 190, padL = 46, padB = 26, bw = (W - padL) / months.length;
    const ticks = [0, .5, 1].map(f => f * max);
    const y = v => (H - padB) - v / max * (H - padB - 14);
    const bars = months.map((x, i) => {
      const cx = padL + i * bw, w = Math.min(34, bw * .56), x0 = cx + (bw - w) / 2, on = x.month === d.month;
      const hm = (H - padB) - y(x.material), hs = (H - padB) - y(x.supply);
      return `<g class="sp-bar ${on ? 'on' : ''}" data-spbar="${x.month}" tabindex="0" role="button" aria-label="${monthTh(x.month)} ${fmtB(x.total)}">
        <rect class="hit" x="${cx}" y="0" width="${bw}" height="${H}"/>
        ${x.material ? `<rect class="m" x="${x0}" y="${y(x.material)}" width="${w}" height="${Math.max(1.5, hm)}" rx="3"/>` : ''}
        ${x.supply ? `<rect class="s" x="${x0}" y="${y(x.material) - Math.max(1.5, hs)}" width="${w}" height="${Math.max(1.5, hs)}" rx="3"/>` : ''}
        ${!x.total ? `<rect class="z" x="${x0}" y="${H - padB - 2}" width="${w}" height="2" rx="1"/>` : ''}
        <text class="lb" x="${cx + bw / 2}" y="${H - 8}">${TH_M[+x.month.slice(5, 7) - 1]}</text>
        ${on && x.total ? `<text class="vv" x="${cx + bw / 2}" y="${y(x.total) - 6}">${fmtBk(x.total)}</text>` : ''}
        <title>${monthTh(x.month)} · Material ${fmtB(x.material)} · อุปกรณ์ ${fmtB(x.supply)}</title></g>`;
    }).join('');
    const grid = raw <= 1 && !months.some(x => x.total) ? `<text class="emp" x="${(W + padL) / 2}" y="${(H - padB) / 2}">ยังไม่มียอดค่าใช้จ่ายใน 12 เดือนนี้</text>` : ticks.map(v => `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}">${fmtBk(v)}</text>`).join('');
    const tot = d.total || 0;
    const rows = d.items.map((it, i) => `<div class="sp-irow ${it.kind}"><span class="rk num">${i + 1}</span>
        <span class="nm"><b>${esc(it.name)}</b></span><span class="kd"><i></i>${SP_KIND[it.kind][0]}</span>
        <span class="q num">${fmtN(it.qty)} <small>${esc(it.unit)}</small></span><span class="a num">${fmtB(it.amount)}</span>
        <span class="sh"><i style="width:${tot ? it.amount / tot * 100 : 0}%"></i><small class="num">${tot ? Math.round(it.amount / tot * 1000) / 10 : 0}%</small></span></div>`).join('');
    const miss = [['material', m], ['supply', s]].flatMap(([k, b]) => b.unpriced.map((u, i) => ({ k, i, u })));
    const mrow = ({ k, i, u }) => `<div class="sp-mrow" data-k="${k}" data-i="${i}"><span class="kd ${k}"><i></i>${SP_KIND[k][0]}</span>
        <span class="nm"><b>${esc(u.name)}</b><small>${fmtN(u.qty)} ${esc(u.unit)} · ${u.ref.kind === 'material' ? 'ราคาเก็บที่ Material Master' : u.ref.kind === 'item' ? 'ราคาเก็บในรายการสินค้า' : 'รายการพิมพ์เอง · ใส่ราคาให้ทุกคำขอเดือนนี้'}</small></span>
        ${App.officer ? `<label class="sp-pin"><span>฿</span><input class="input num" inputmode="decimal" placeholder="ราคา/${esc(u.unit)}"></label><button class="btn btn-primary sm" data-spset>${ic('check', 'sm')}ใส่ราคา</button>` : '<span class="hint">ให้ Officer ใส่ราคา</span>'}</div>`;
    return `
      <div class="sp-nav"><button class="icon-btn" data-spm="-1" aria-label="เดือนก่อน">${ic('chevL')}</button>
        <div class="sp-mo">${bi(monthTh(d.month), isNow ? 'THIS MONTH · REALTIME' : monthEn(d.month))}</div>
        <button class="icon-btn" data-spm="1" aria-label="เดือนถัดไป" style="transform:scaleX(-1)">${ic('chevL')}</button>
        <span class="grow"></span>
        <div class="sp-kpi"><span>รวม</span><b class="num">${fmtB(d.total)}</b>${this.delta(d)}</div>
        <div class="sp-kpi m"><span><i></i>Material</span><b class="num">${fmtB(m.amount)}</b><small>${m.lines} ใบสั่ง</small></div>
        <div class="sp-kpi s"><span><i></i>อุปกรณ์</span><b class="num">${fmtB(s.amount)}</b><small>${s.lines} รายการ</small></div>
      </div>
      <div class="sp-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sp-svg"><g class="gr">${grid}</g>${bars}</svg>
        <div class="sp-leg"><span class="m"><i></i>Material</span><span class="s"><i></i>อุปกรณ์</span><span class="hint">คลิกแท่งเพื่อดูเดือนนั้น</span></div></div>
      ${miss.length ? `<section class="sp-miss-box"><header>${ic('alert', 'sm')}<b>ยังไม่ใส่ราคา ${miss.length} รายการ</b><span>ยอดรวมยังไม่นับรายการเหล่านี้${App.officer ? ' — ใส่ราคาต่อหน่วยแล้วกด Enter' : ''}</span>${App.officer ? `<span class="grow"></span><button class="link" data-spt2>เปิดตารางราคาทั้งหมด ${ic('arrowR', 'sm')}</button>` : ''}</header>${miss.map(mrow).join('')}</section>` : ''}
      <section class="sp-list">
        <div class="sp-ihead"><span>#</span><span>รายการ</span><span>ประเภท</span><span class="r">จำนวน</span><span class="r">ยอดเงิน</span><span>สัดส่วน</span></div>
        ${rows || `<div class="sp-none">${d.material.lines + d.supply.lines ? 'ยังไม่มีรายการที่ใส่ราคาในเดือนนี้' : 'เดือนนี้ไม่มีการสั่งซื้อ'}</div>`}
      </section>`;
  },
  async xlsx(d) {
    let XLSX; try { XLSX = await HistImport.lib(); } catch (e) { return toast('ส่งออก Excel ไม่ได้', esc(e.message || e), 'err'); }
    const s1 = [[`สรุปค่าใช้จ่าย ${monthTh(d.month)}`], [], ['ประเภท', 'ยอดเงิน (บาท)', 'จำนวนรายการ'],
      ['Material', d.material.amount, d.material.lines], ['อุปกรณ์', d.supply.amount, d.supply.lines], ['รวม', d.total, d.material.lines + d.supply.lines], [],
      ['อันดับ', 'รายการ', 'ประเภท', 'จำนวน', 'หน่วย', 'ยอดเงิน (บาท)'],
      ...d.items.map((it, i) => [i + 1, it.name, SP_KIND[it.kind][0], it.qty, it.unit, it.amount])];
    const miss = [...d.material.unpriced.map(u => ['Material', u.name, u.qty, u.unit]), ...d.supply.unpriced.map(u => ['อุปกรณ์', u.name, u.qty, u.unit])];
    if (miss.length) s1.push([], ['ยังไม่ใส่ราคา (ไม่รวมในยอด)'], ['ประเภท', 'รายการ', 'จำนวน', 'หน่วย'], ...miss);
    const s2 = [['เดือน', 'Material (บาท)', 'อุปกรณ์ (บาท)', 'รวม (บาท)'], ...d.months.map(x => [monthTh(x.month), x.material, x.supply, x.total])];
    const wb = XLSX.utils.book_new(), w1 = XLSX.utils.aoa_to_sheet(s1), w2 = XLSX.utils.aoa_to_sheet(s2);
    w1['!cols'] = [{ wch: 10 }, { wch: 34 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 16 }]; w2['!cols'] = [{ wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, w1, 'สรุปเดือน'); XLSX.utils.book_append_sheet(wb, w2, '12 เดือน');
    XLSX.writeFile(wb, `HRM_Spend_${d.month}.xlsx`);
  },
};

/* =====================================================================
   PRICE TABLE — ใส่ราคาทุกรายการในตารางเดียว (Officer)
   Material Master + HRM Shopping catalogue · type a price, Enter → next row · one save for everything
   ===================================================================== */
const PRICE_SRC = { master: 'Material Master', catalog: 'รายการสินค้า', table: 'ตารางราคา', summary: 'สรุปค่าใช้จ่าย' };
const PriceTable = {
  /** one change: วันที่ · ราคาเดิม → ราคาใหม่ (▲/▼ %) · ใคร · แก้จากหน้าไหน */
  logRow(l, withName = false) {
    const o = l.old_price, n = l.new_price;
    const pct = o != null && n != null && o ? Math.round((n - o) / o * 1000) / 10 : null;
    const chip = o == null ? '<span class="ph-chip new">ตั้งราคาแรก</span>' : n == null ? '<span class="ph-chip del">ลบราคา</span>'
      : `<span class="ph-chip ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
    return `<div class="ph-row ${l.kind}"><span class="ph-dot"></span>
      <span class="ph-when">${fmtD(l.at)}<small>${fmtTime(l.at)}</small></span>
      ${withName ? `<span class="ph-nm"><b>${esc(l.name || '-')}</b><small>${l.kind === 'material' ? 'Material' : 'อุปกรณ์'}</small></span>` : ''}
      <span class="ph-val num"><s>${o == null ? '—' : fmtB(o)}</s>${ic('arrowR', 'sm')}<b>${n == null ? '—' : fmtB(n)}</b><small>/ ${esc(l.unit || '')}</small></span>
      ${chip}<span class="ph-who">${typeof People !== 'undefined' ? People.avatar(l.who || '?', 22) : ''}${esc(l.who || '-')}<small>${esc(PRICE_SRC[l.source] || l.source || '')}</small></span></div>`;
  },
  async open(focus = 'all') {
    if (!App.officer) return toast('เฉพาะ Officer', 'เปลี่ยนเป็นโหมด Officer ที่หน้า ตั้งค่า', 'warn');
    let mats, cat;
    try { [mats, cat] = await Promise.all([api('materials_list'), api('shop_catalog')]); } catch (e) { return toastErr(e); }
    // one list, grouped: Material first, then each catalogue category
    const rows = [];
    mats.filter(m => m.status === 'active').forEach(m => rows.push({ kind: 'material', id: m.id, code: m.code, name: m.name, sub: m.name_en || '', unit: m.unit, group: 'Material', price: m.unit_price ?? null }));
    (cat.cats || []).forEach(c => (c.items || []).forEach(i => rows.push({ kind: 'item', id: i.id, code: i.code || '', name: i.name, sub: '', unit: i.unit, group: c.name, price: i.price ?? null })));
    const key = r => r.kind + ':' + r.id, draft = new Map();   // key → typed text (only rows the Officer touched)
    let kind = focus, q = '', onlyMissing = false;
    const val = r => draft.has(key(r)) ? draft.get(key(r)) : (r.price ?? '');
    const changed = r => { if (!draft.has(key(r))) return false; const t = String(draft.get(key(r))).trim(), n = t === '' ? null : parseNum(t); return n !== r.price && !(n === null && r.price === null); };
    const visible = () => rows.filter(r => (kind === 'all' || (kind === 'material') === (r.kind === 'material'))
      && (!onlyMissing || r.price === null || changed(r))
      && (!q || (r.name + ' ' + r.sub + ' ' + r.code).toLowerCase().includes(q)));
    const counts = () => ({ all: rows.length, missing: rows.filter(r => r.price === null).length, dirty: rows.filter(changed).length });
    const list = () => {
      const v = visible(); let g = null;
      if (!v.length) return `<div class="sp-none">${onlyMissing ? 'ใส่ราคาครบทุกรายการแล้ว 🎉' : 'ไม่พบรายการที่ค้นหา'}</div>`;
      return v.map(r => {
        const head = r.group !== g ? `<div class="pt-group ${r.kind}"><i></i>${esc(r.group)}<span>${v.filter(x => x.group === r.group).length}</span></div>` : ''; g = r.group;
        return `${head}<div class="pt-row ${r.kind} ${changed(r) ? 'dirty' : ''} ${r.price === null && !changed(r) ? 'miss' : ''}" data-key="${key(r)}">
          <span class="cd num">${esc(r.code) || '<span class="faint">พิมพ์เอง</span>'}</span>
          <span class="nm"><b>${esc(r.name)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>
          <span class="was num">${r.price === null ? '<span class="miss-t">ยังไม่มีราคา</span>' : fmtB(r.price)}</span>
          <label class="sp-pin"><span>฿</span><input class="input num" inputmode="decimal" value="${esc(String(val(r)))}" placeholder="0.00"></label>
          <span class="un">/ ${esc(r.unit)}</span>
          <button class="icon-btn sm pt-hb" data-hist title="ประวัติราคา" aria-label="ประวัติราคา ${esc(r.name)}">${ic('clock', 'sm')}</button></div>`;
      }).join('');
    };
    const bar = () => { const c = counts(); return `<span class="pt-stat"><b class="num">${c.all - c.missing}</b>/${c.all} มีราคาแล้ว</span>${c.missing ? `<span class="pt-stat miss">ยังไม่มีราคา <b class="num">${c.missing}</b></span>` : ''}<span class="pt-stat dirty ${c.dirty ? '' : 'z'}">แก้ไขแล้ว <b class="num">${c.dirty}</b></span>`; };
    openPanel({
      title: 'ตารางราคาสินค้า', en: 'Price list · Material + อุปกรณ์', icon: 'coins', color: 'var(--sp-mat)', wide: true,
      body: `<div class="pt-tools">
          <div class="seg" id="pt-k">${[['all', 'ทั้งหมด'], ['material', 'Material'], ['item', 'อุปกรณ์']].map(([k, t]) => `<button data-k="${k}" class="${kind === k ? 'on' : ''}">${t}</button>`).join('')}</div>
          <label class="search">${ic('search', 'sm')}<input class="input" id="pt-q" placeholder="ค้นหาชื่อ / รหัส…"></label>
          <label class="pt-only"><span class="switch"><input type="checkbox" id="pt-m"><span></span></span>เฉพาะที่ยังไม่มีราคา</label>
          <button class="btn btn-plain sm" data-logall>${ic('clock', 'sm')}ประวัติการเปลี่ยนราคา</button>
        </div>
        <div class="pt-head"><span>รหัส</span><span>รายการ</span><span class="r">ราคาปัจจุบัน</span><span class="r">ราคาใหม่ (บาท)</span><span>หน่วย</span><span></span></div>
        <div class="pt-list" id="pt-l">${list()}</div>`,
      foot: `<div class="pt-bar" id="pt-b">${bar()}</div><span class="grow"></span><span class="hint">Enter = ไปช่องถัดไป · เว้นว่าง = ลบราคา</span>
        <button class="btn btn-primary lg" id="pt-save">${ic('check')}${bi('บันทึกราคา', 'SAVE ALL')}</button>`,
      onMount: (p, close) => {
        const L = p.querySelector('#pt-l'), B = p.querySelector('#pt-b');
        const redraw = () => { L.innerHTML = list(); B.innerHTML = bar(); };
        p.querySelector('#pt-k').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; kind = b.dataset.k === 'item' ? 'item' : b.dataset.k; if (kind === 'item') kind = 'supply'; $$('#pt-k button', p).forEach(x => x.classList.toggle('on', x === b)); redraw(); };
        p.querySelector('#pt-q').oninput = e => { q = e.target.value.trim().toLowerCase(); redraw(); };
        p.querySelector('#pt-m').onchange = e => { onlyMissing = e.target.checked; redraw(); };
        // price history: one row (expands under it) or every change (replaces the list until “กลับ”)
        L.addEventListener('click', async e => {
          const hb = e.target.closest('[data-hist]'); if (!hb) return;
          const row = hb.closest('.pt-row'), nx = row.nextElementSibling;
          if (nx?.classList.contains('pt-hist')) { nx.remove(); hb.classList.remove('on'); return; }
          const r = rows.find(x => key(x) === row.dataset.key); hb.classList.add('on');
          const box = document.createElement('div'); box.className = 'pt-hist'; box.innerHTML = '<div class="sp-skel"><i></i></div>'; row.after(box);
          try {
            const log = await api('price_history', r.kind, r.id, 30);
            box.innerHTML = log.length ? log.map(l => this.logRow(l)).join('') : '<div class="ph-empty">ยังไม่มีประวัติการเปลี่ยนราคา — บันทึกเริ่มตั้งแต่เวอร์ชันนี้</div>';
          } catch (er) { box.innerHTML = `<div class="ph-empty">${esc(er.message || er)}</div>`; }
        });
        p.querySelector('[data-logall]').onclick = async ev => {
          const btn = ev.currentTarget;
          if (btn.classList.contains('on')) { btn.classList.remove('on'); btn.innerHTML = `${ic('clock', 'sm')}ประวัติการเปลี่ยนราคา`; p.classList.remove('pt-log'); return redraw(); }
          btn.classList.add('on'); btn.innerHTML = `${ic('chevL', 'sm')}กลับไปตารางราคา`; p.classList.add('pt-log');
          L.innerHTML = '<div class="sp-skel big"><i></i><i></i></div>';
          try { const log = await api('price_history', null, null, 200); L.innerHTML = log.length ? `<div class="pt-hist all">${log.map(l => this.logRow(l, true)).join('')}</div>` : '<div class="sp-none">ยังไม่มีการเปลี่ยนราคา</div>'; }
          catch (er) { L.innerHTML = `<div class="sp-none">${esc(er.message || er)}</div>`; }
        };
        L.addEventListener('input', e => {
          const row = e.target.closest('.pt-row'); if (!row) return;
          const r = rows.find(x => key(x) === row.dataset.key); draft.set(key(r), e.target.value);
          row.classList.toggle('dirty', changed(r)); row.classList.toggle('miss', r.price === null && !changed(r)); B.innerHTML = bar();
        });
        L.addEventListener('keydown', e => {
          if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          const ins = $$('.pt-row input', L), i = ins.indexOf(e.target); if (i < 0) return;
          e.preventDefault(); const n = ins[i + (e.key === 'ArrowUp' ? -1 : 1)]; if (n) { n.focus(); n.select(); }
        });
        L.addEventListener('focusin', e => { if (e.target.matches('.pt-row input')) e.target.select(); });
        p.querySelector('#pt-save').onclick = async ev => {
          const ch = rows.filter(changed);
          if (!ch.length) return toast('ยังไม่มีราคาที่เปลี่ยน', 'พิมพ์ราคาในช่อง “ราคาใหม่” ก่อน', 'info');
          const bad = ch.find(r => { const t = String(draft.get(key(r))).trim(); return t !== '' && !(parseNum(t) >= 0); });
          if (bad) { toast('ราคาไม่ถูกต้อง', esc(bad.name), 'err'); const inp = L.querySelector(`[data-key="${key(bad)}"] input`); inp?.focus(); return; }
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            const res = await api('price_bulk', ch.map(r => ({ kind: r.kind, id: r.id, name: r.name, price: String(draft.get(key(r))).trim() })));
            toast('บันทึกราคาแล้ว', `${res.updated} รายการ · สรุปค่าใช้จ่ายอัปเดตแล้ว`);
            close(); await App.bumpRev(); App.refresh();
          } catch (er) { toastErr(er); btn.disabled = false; }
        };
        setTimeout(() => (p.querySelector('.pt-row.miss input') || p.querySelector('.pt-row input'))?.focus(), 80);   // first row still missing a price
      },
    });
  },
};

/* ===== trend.js ===== */
/* =====================================================================
   STOCK TREND — แนวโน้มสต็อกต่อ Material (HRM Hydraulic chart style)
   Closing balance line (monotone cubic + soft area) · zones: below reorder (critical) / near reorder (warning)
   · dashed reorder limit · days without a record hatched · 3D event tiles: รับเข้า / สั่งซื้อ · hover tooltip
   ===================================================================== */
'use strict';

const StockTrend = {
  days: 60,

  async open(mid) {
    let d = null, busy = false;
    const close = openPanel({
      title: 'แนวโน้มสต็อก', en: 'Stock trend', icon: 'stock', color: 'var(--refill)', wide: true,
      body: `<div id="trd"><div class="sp-skel big"><i></i><i></i><i></i></div></div>`,
      foot: `<span class="hint">เส้น = ยอดคงเหลือปลายวัน · เส้นประแดง = จุดสั่งซื้อ · ช่องลาย = วันที่ยังไม่มีบันทึก</span><span class="grow"></span>
        ${App.officer ? '<button class="btn btn-tonal" data-tro>' + ic('plus', 'sm') + bi('สร้างใบสั่งซื้อ', 'NEW ORDER') + '</button>' : ''}`,
      onMount: (p, closeP) => {
        const box = p.querySelector('#trd');
        const load = async n => {
          if (busy) return; busy = true; box.classList.add('loading');
          try { this.days = n || this.days; d = await api('stock_trend', mid, this.days); box.innerHTML = this.body(d); this.bind(box, d); }
          catch (e) { box.innerHTML = `<div class="sp-none">${esc(e.message || e)}</div>`; }
          finally { busy = false; box.classList.remove('loading'); }
        };
        load();
        box.addEventListener('click', e => { const b = e.target.closest('[data-trn]'); if (b) load(+b.dataset.trn); });
        p.querySelector('[data-tro]')?.addEventListener('click', () => { closeP(); OrderUI.form({ material_id: mid }); });
      },
    });
    return close;
  },

  /** monotone cubic (Fritsch–Carlson) path through points */
  curve(P) {
    if (P.length < 2) return P.length ? `M${P[0][0]},${P[0][1]}` : '';
    const n = P.length, dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0]; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
    let s = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      s += `C${(P[i][0] + h).toFixed(1)},${(P[i][1] + h * t[i]).toFixed(1)} ${(P[i + 1][0] - h).toFixed(1)},${(P[i + 1][1] - h * t[i + 1]).toFixed(1)} ${P[i + 1][0].toFixed(1)},${P[i + 1][1].toFixed(1)}`;
    }
    return s;
  },

  body(d) {
    const m = d.material, D = d.days, rp = m.reorder_point || 0, unit = m.unit;
    const W = 1100, H = 330, pl = 64, pr = 18, pt = 34, pb = 34, iw = W - pl - pr, ih = H - pt - pb;
    const raw = Math.max(rp * 1.6, ...D.map(x => x.balance), 1), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const max = ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(k => k * mag >= raw) || 10) * mag;
    const bw = iw / D.length, X = i => pl + bw * (i + .5), Y = v => pt + ih - Math.max(0, v) / max * ih;
    const P = D.map((x, i) => [X(i), Y(x.balance)]), line = this.curve(P);
    const area = `${line}L${P[P.length - 1][0].toFixed(1)},${pt + ih}L${P[0][0].toFixed(1)},${pt + ih}Z`;
    const ticks = [0, .25, .5, .75, 1].map(f => f * max);
    // labelled major lines at 0 · ½ · max (always round numbers), unlabelled minor lines at ¼ · ¾
    const grid = ticks.map((v, k) => k % 2 ? `<line class="minor" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/>`
      : `<line class="${v === 0 ? 'base' : ''}" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${pl - 10}" y="${Y(v) + 4}">${fmtBk(v)}</text>`).join('');
    const zones = rp ? `<rect class="z-crit" x="${pl}" y="${Y(rp)}" width="${iw}" height="${pt + ih - Y(rp)}"/><rect class="z-warn" x="${pl}" y="${Y(rp * 1.5)}" width="${iw}" height="${Y(rp) - Y(rp * 1.5)}"/>
      <line class="lim" x1="${pl}" x2="${W - pr}" y1="${Y(rp)}" y2="${Y(rp)}"/><text class="lim-t" x="${W - pr - 4}" y="${Y(rp) - 6}">จุดสั่งซื้อ ${fmtN(rp)} ${esc(unit)}</text>` : '';
    // days without any record (no receipt, no usage) — hatched, today column highlighted
    const cols = D.map((x, i) => {
      const today = x.date === App.today, none = x.received === null && x.used === null && !today;
      return (none ? `<rect class="miss" x="${pl + bw * i}" y="${pt}" width="${bw}" height="${ih}"/>` : '') + (today ? `<rect class="today" x="${pl + bw * i + 1}" y="${pt - 6}" width="${bw - 2}" height="${ih + 6}" rx="6"/>` : '');
    }).join('');
    const lbl = D.map((x, i) => (i % 7 === (D.length - 1) % 7) ? `<text class="xl ${x.date === App.today ? 'on' : ''}" x="${X(i)}" y="${H - 10}">${fmtDShort(x.date)}</text>` : '').join('');
    // events: receipts and order dates → 3D tiles above the point
    const idx = {}; D.forEach((x, i) => idx[x.date] = i);
    const ev = [];
    D.forEach((x, i) => { if (x.received > 0) ev.push({ i, k: 'truck', t: `รับเข้า +${fmtN(x.received)} ${unit}` }); });
    d.orders.forEach(o => { if (idx[o.order_date] !== undefined) ev.push({ i: idx[o.order_date], k: 'order', t: `สั่งซื้อ ${fmtN(o.ordered_qty)} ${unit} · ${o.id}` }); });
    const stack = {};
    const marks = ev.map(e => { const n = stack[e.i] = (stack[e.i] || 0) + 1, x = X(e.i), y = Math.max(pt + 2, P[e.i][1] - 14 - 28 * n);
      return `<g class="ev" transform="translate(${(x - 13).toFixed(1)} ${y.toFixed(1)})"><title>${esc(fmtD(D[e.i].date))} · ${esc(e.t)}</title>${tile3d(e.k, 26)}</g><line class="ev-l" x1="${x}" x2="${x}" y1="${y + 26}" y2="${P[e.i][1] - 5}"/>`; }).join('');
    const pts = D.map((x, i) => `<circle class="pt ${x.received === null && x.used === null ? 'hol' : ''}" cx="${P[i][0].toFixed(1)}" cy="${P[i][1].toFixed(1)}" r="3.4"/>`).join('');
    const last = D[D.length - 1], first = D[0];
    const used = D.reduce((s, x) => s + (x.used || 0), 0), rcv = D.reduce((s, x) => s + (x.received || 0), 0), recd = D.filter(x => x.received !== null || x.used !== null).length;
    const cls = m.state === 'need_order' ? 'need' : m.state === 'on_order' ? (m.order_status === 'overdue' ? 'need' : m.order_status === 'waiting_date' ? 'ordered' : 'sched') : 'ok';   // same rule as the stock list
    const ost = { waiting_date: ['รอกำหนดส่ง', 'ordered'], scheduled: ['กำหนดส่ง', 'sched'], today: ['ส่งวันนี้', 'sched'], overdue: ['เกินกำหนด', 'need'], partial: ['รับบางส่วน', 'ordered'], received: ['รับครบแล้ว', 'ok'], requested: ['รอ Officer', 'ordered'] };
    return `
      <div class="tr-head">
        <div class="tr-mat">${mpic(m, 56)}<div>${bi(m.name, m.code + (m.name_en ? ' · ' + m.name_en : ''))}</div>${matBadge(m)}</div>
        <span class="grow"></span>
        <div class="seg sm">${[30, 60, 90].map(n => `<button data-trn="${n}" class="${this.days === n ? 'on' : ''}">${n} วัน</button>`).join('')}</div>
      </div>
      <div class="tr-kpis">
        <div class="tr-k hero" style="--c:${C[cls]}"><span>คงเหลือวันนี้</span><b class="num">${fmtN(last.balance)}<small>${esc(unit)}</small></b><em>${last.balance - first.balance >= 0 ? '▲' : '▼'} ${fmtN(Math.abs(last.balance - first.balance))} จาก ${D.length} วันก่อน</em></div>
        <div class="tr-k"><span>จุดสั่งซื้อ</span><b class="num">${fmtN(rp)}<small>${esc(unit)}</small></b></div>
        <div class="tr-k"><span>ใช้ไป ${D.length} วัน</span><b class="num">${fmtN(Math.round(used * 100) / 100)}<small>${esc(unit)}</small></b><em>เฉลี่ย ${m.usage_per_day ? fmtN(Math.round(m.usage_per_day * 100) / 100) : '—'} / วัน</em></div>
        <div class="tr-k"><span>รับเข้า ${D.length} วัน</span><b class="num" style="color:var(--refill)">+${fmtN(rcv)}<small>${esc(unit)}</small></b></div>
        <div class="tr-k"><span>พอใช้อีก</span><b class="num">${m.days_cover === null ? '—' : m.days_cover > 365 ? '> 1 ปี' : Math.floor(m.days_cover) + '<small>วัน</small>'}</b><em>มีบันทึก ${recd}/${D.length} วัน</em></div>
      </div>
      <div class="tr-chart">
        <svg viewBox="0 0 ${W} ${H}" class="tr-svg" style="--c:var(--s-2)">
          <defs><linearGradient id="trA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--s-2)" stop-opacity=".22"/><stop offset="1" stop-color="var(--s-2)" stop-opacity="0"/></linearGradient>
            <pattern id="trH" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="8" class="hatch"/></pattern></defs>
          ${cols}${zones}<g class="gr">${grid}</g>
          <path class="ar" d="${area}" fill="url(#trA)"/><path class="ln" d="${line}" pathLength="1"/>
          ${pts}${marks}${lbl}
          <g class="hov" style="display:none"><rect class="hb" y="${pt}" height="${ih}" width="${bw}"/><circle class="hp" r="6"/></g>
          <rect class="hit" x="${pl}" y="${pt}" width="${iw}" height="${ih}" fill="transparent"/>
        </svg>
        <div class="tr-tip" hidden></div>
        <div class="tr-leg"><span class="l"><i></i>คงเหลือปลายวัน</span><span class="w"><i></i>ใกล้จุดสั่งซื้อ (≤ 1.5 เท่า)</span><span class="c"><i></i>ต่ำกว่าจุดสั่งซื้อ</span><span class="h"><i></i>ไม่มีบันทึก</span>
          <span class="e">${tile3d('truck', 18)}รับเข้า</span><span class="e">${tile3d('order', 18)}สั่งซื้อ</span></div>
      </div>
      ${d.orders.length ? `<section class="tr-orders"><header>${bi('ใบสั่งซื้อของ Material นี้', 'ORDERS IN THIS PERIOD · OPEN')}</header>
        ${d.orders.map(o => { const s = ost[o.status] || [o.status, 'sched']; return `<div class="tr-o" style="--c:${C[s[1]]}"><span class="dot"></span><b class="num">${esc(o.id)}</b>
          <span>สั่ง ${fmtD(o.order_date)}</span><span class="num">${fmtN(o.ordered_qty)} ${esc(unit)}${o.received_qty ? ` · รับแล้ว ${fmtN(o.received_qty)}` : ''}</span>
          <span>${o.expected_date ? 'กำหนดส่ง ' + fmtD(o.expected_date) : 'ยังไม่มีกำหนดส่ง'}</span><span class="st">${s[0]}</span></div>`; }).join('')}</section>` : ''}`;
  },

  /** hover: column highlight + enlarged point + glass tooltip */
  bind(box, d) {
    const svg = box.querySelector('.tr-svg'), tip = box.querySelector('.tr-tip'), hov = svg.querySelector('.hov'), hit = svg.querySelector('.hit');
    const D = d.days, vb = svg.viewBox.baseVal, pl = 64, iw = vb.width - pl - 18, bw = iw / D.length;
    const pts = [...svg.querySelectorAll('.pt')];
    const show = ev => {
      const r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) / r.width * vb.width, i = Math.max(0, Math.min(D.length - 1, Math.floor((sx - pl) / bw)));
      const x = D[i], c = pts[i];
      hov.style.display = ''; hov.querySelector('.hb').setAttribute('x', pl + bw * i);
      hov.querySelector('.hp').setAttribute('cx', c.getAttribute('cx')); hov.querySelector('.hp').setAttribute('cy', c.getAttribute('cy'));
      tip.hidden = false;
      tip.innerHTML = `<div class="tt-d">${fmtD(x.date)}${x.date === App.today ? ' · วันนี้' : ''}</div>
        <div class="tt-r"><span>คงเหลือ</span><b class="num">${fmtN(x.balance)} ${esc(d.material.unit)}</b></div>
        <div class="tt-r"><span>รับเข้า</span><b class="num" style="color:var(--refill)">${x.received ? '+' + fmtN(x.received) : '—'}</b></div>
        <div class="tt-r"><span>ใช้ไป</span><b class="num">${x.used !== null ? fmtN(x.used) : '—'}</b></div>
        ${x.received === null && x.used === null && x.date !== App.today ? '<div class="tt-n">ยังไม่มีบันทึกวันนี้ — ยอดยกมาจากวันก่อน</div>' : ''}`;
      const cx = +c.getAttribute('cx') / vb.width * r.width, cy = +c.getAttribute('cy') / vb.height * r.height;
      tip.style.left = Math.min(r.width - 230, Math.max(0, cx + 16)) + 'px'; tip.style.top = Math.max(0, cy - 40) + 'px';
    };
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', () => { hov.style.display = 'none'; tip.hidden = true; });
    requestAnimationFrame(() => svg.classList.add('in'));
  },
};

/* ===== widget.js ===== */
/* =====================================================================
   DESKTOP WIDGET — หน้าต่างเล็กลอยบนเดสก์ท็อป
   • งาน STOCK ที่ต้องสั่ง (ถึงจุดสั่งซื้อ · เกินกำหนดส่ง · คำขอที่รอ Officer)
   • ประกาศจาก Officer
   Desktop app: its own small always-on-top window (HRMStock.exe --widget, or the header button)
   Web / Google: a small pop-up window (?view=widget) · Dev: index.html#widget
   Refreshes itself when anything changes (rev poll) and pings a desktop notification for new items.
   ===================================================================== */
'use strict';

const Widget = {
  d: null, timer: null, seen: null,

  want() { return location.hash === '#widget' || document.body?.dataset.view === 'widget'; },

  /** open the widget from the main app */
  async launch() {
    try {
      if (window.pywebview?.api?.open_widget) { await window.pywebview.api.open_widget(); return toast('เปิด Widget แล้ว', 'หน้าต่างเล็กลอยอยู่มุมขวาของจอ — ลากย้ายได้', 'info'); }
    } catch (e) { /* fall through to a pop-up */ }
    const W = 380, H = 620, x = Math.max(0, screen.availWidth - W - 24), y = 60;
    const url = IS_WEB ? location.origin + '/?view=widget' : IS_GAS ? (App.info?.url ? App.info.url + '?view=widget' : null) : location.pathname + '#widget';
    if (!url) return toast('เปิด Widget ไม่ได้', 'ยังไม่ได้ Deploy เว็บแอป', 'err');
    const w = window.open(url, 'hrmwidget', `popup=yes,width=${W},height=${H},left=${x},top=${y}`);
    if (!w) return toast('เบราว์เซอร์บล็อกหน้าต่าง', 'อนุญาต Pop-up ให้เว็บนี้ แล้วกดอีกครั้ง', 'warn');
    toast('เปิด Widget แล้ว', 'วางไว้ข้างจอเพื่อดูงานที่ต้องสั่งและประกาศ', 'info');
  },

  async start() {
    document.title = 'HRM STOCK · Widget';
    document.body.classList.add('wg-body');
    App.rev = App.info.rev;
    try { this.seen = JSON.parse(localStorageGet('wgSeen') || 'null'); } catch (e) { this.seen = null; }
    await this.load();
    $('#root').addEventListener('click', e => this.click(e));
    this.timer = setInterval(() => this.poll(), 20000);
    setInterval(() => {
      const c = $('#wg-clock'); if (c) c.textContent = new Date().toTimeString().slice(0, 5);
      if (this.d && Shift.late() !== this._late) { this.render(); this.notify(); }   // crossing the reminder time
    }, 15000);
  },
  async poll() {
    try { const r = await api('get_rev'); if (r !== App.rev) { App.rev = r; App._dash = null; await this.load(); } } catch (e) { this.offline(true); }
  },
  offline(on) { $('#wg-root')?.classList.toggle('off', on); },
  async load() {
    try { this.d = await api('dashboard'); this.offline(false); } catch (e) { this.offline(true); if (!this.d) return this.fail(e); }
    this.render(); this.notify();
  },
  fail(e) {
    $('#root').innerHTML = `<div class="wg" id="wg-root"><div class="wg-empty">${tile3d('wifiOff', 48)}<b>เชื่อมต่อไม่ได้</b><span>${esc(e.message || e)}</span><button class="btn btn-tonal" data-wg="reload">${ic('refresh', 'sm')}ลองใหม่</button></div></div>`;
  },

  items(d) {
    const need = (d.need_order || []).map(m => ({ k: 'need', id: 'm' + m.id, mid: m.id, name: m.name, unit: m.unit, bal: m.balance, rp: m.reorder_point }));
    const late = (d.open_orders || []).filter(o => o.status === 'overdue').map(o => ({ k: 'late', id: 'o' + o.id, mid: o.material.id, name: o.material.name, unit: o.material.unit, oid: o.id, exp: o.expected_date, qty: o.remaining_qty ?? o.ordered_qty }));
    const req = (d.requests || []).filter(o => o.status === 'requested').map(o => ({ k: 'req', id: 'r' + o.id, mid: o.material.id, name: o.material.name, unit: o.material.unit, oid: o.id, qty: o.ordered_qty, who: o.requested_by }));
    return { need, late, req };
  },
  notes(d) { return NoteUI.visible(d.notes || []); },

  render() {
    const d = this.d, { need, late, req } = this.items(d), notes = this.notes(d), ack = NoteUI.ackId();
    const total = need.length + late.length + req.length;
    // who still has to record STOCK (team on shift today + earlier days per team)
    const T = this.d.today, tT = Shift.teamOn(T), isLate = this._late = !d.today_recorded && Shift.late(), need0 = !d.today_recorded && Shift.works(T), missD = Shift.workDays(d.missing_days);
    const groups = Shift.active() ? Shift.missingByTeam(missD) : (missD.length ? [{ team: '', days: missD }] : []);
    const alert = (need0 || groups.length) ? `<button class="wg-alert ${isLate || groups.length ? 'need' : 'warn'}" data-wg="entry">
        ${tile3d(isLate || groups.length ? 'alert' : 'entry', 30)}<span class="wg-at">
        ${need0 ? `<b>${tT ? `ทีม ${Shift.label(tT)} ยังไม่ลง STOCK วันนี้` : 'ยังไม่ลง STOCK วันนี้'}${isLate ? ` · เลย ${Shift.remindAt()}` : ''}</b>${tT ? `<small>${Shift.members(tT).map(esc).join(' · ')}</small>` : ''}` : d.today_recorded ? '<b>วันนี้ลง STOCK แล้ว</b>' : '<b>วันนี้ไม่มีกะเช้า</b>'}
        ${groups.length ? `<small class="wg-miss">ค้าง: ${groups.map(g => `${g.team ? 'ทีม ' + Shift.label(g.team) : 'ไม่ระบุทีม'} ${g.days.length} วัน`).join(' · ')}</small>` : ''}</span>${ic('arrowR', 'sm')}</button>` : '';
    const row = it => {
      const pct = it.rp ? Math.max(4, Math.min(100, it.bal / (it.rp * 1.5) * 100)) : 0;
      const tail = it.k === 'need' ? `<span class="wg-v num">${fmtN(it.bal)}<small>/ ${fmtN(it.rp)} ${esc(it.unit)}</small></span>`
        : it.k === 'late' ? `<span class="wg-v late">เกินกำหนด<small>${fmtDShort(it.exp)} · ${fmtN(it.qty)} ${esc(it.unit)}</small></span>`
          : `<span class="wg-v req">${fmtN(it.qty)} ${esc(it.unit)}<small>ขอโดย ${esc(it.who || '-')}</small></span>`;
      return `<button class="wg-row ${it.k}" data-wg="item" data-mid="${it.mid}" title="เปิดในโปรแกรม">
        <span class="wg-dot"></span><span class="wg-n"><b>${esc(it.name)}</b>${it.k === 'need' ? `<span class="wg-bar"><i style="width:${pct}%"></i></span>` : ''}</span>${tail}</button>`;
    };
    const lv = { urgent: ['ด่วน', 'leak'], warn: ['สำคัญ', 'abn'], info: ['แจ้งให้ทราบ', 'primary'] };
    const note = n => { const l = lv[n.level] || lv.info, nw = n.id > ack;
      return `<article class="wg-note" style="--c:var(--${l[1]})"><header><span class="wg-lv">${l[0]}</span>${nw ? '<span class="wg-new">ใหม่</span>' : ''}<span class="grow"></span><time>${fmtDShort(n.created_at)}</time></header>
        ${n.title ? `<b>${esc(n.title)}</b>` : ''}<p>${esc(n.body)}</p>${n.expires_on ? `<small>ถึง ${fmtD(n.expires_on)}</small>` : ''}</article>`; };
    const unseenN = notes.filter(n => n.id > ack).length;
    $('#root').innerHTML = `<div class="wg ${App.online === false ? 'off' : ''}" id="wg-root">
      <header class="wg-h">${tile3d('logo', 34)}<div class="wg-t"><b>HRM STOCK</b><span><i class="wg-on"></i><span id="wg-clock">${new Date().toTimeString().slice(0, 5)}</span> · อัปเดตอัตโนมัติ</span></div>
        <span class="grow"></span><button class="icon-btn sm" data-wg="refresh" title="รีเฟรช">${ic('refresh', 'sm')}</button><button class="icon-btn sm" data-wg="open" title="เปิดโปรแกรมเต็ม">${ic('side', 'sm')}</button></header>
      ${alert}
      <section class="wg-sec">
        <div class="wg-sh">${tile3d(total ? 'order' : 'check', 28)}<div>${bi('งาน STOCK ที่ต้องสั่ง', 'TO ORDER')}</div><span class="grow"></span><span class="wg-count ${total ? 'need' : 'ok'} num">${total}</span></div>
        ${total ? `<div class="wg-list">
          ${late.length ? `<div class="wg-g">เกินกำหนดส่ง · ติดตาม Supplier</div>${late.map(row).join('')}` : ''}
          ${need.length ? `<div class="wg-g">ถึงจุดสั่งซื้อ · ยังไม่ได้สั่ง</div>${need.map(row).join('')}` : ''}
          ${req.length ? `<div class="wg-g">คำขอสั่งซื้อ · รอ Officer</div>${req.map(row).join('')}` : ''}
        </div>` : `<div class="wg-ok">${tile3d('check', 40)}<div><b>ไม่มีรายการที่ต้องสั่ง</b><span>สต็อกทุกตัวอยู่เหนือจุดสั่งซื้อ</span></div></div>`}
      </section>
      <section class="wg-sec notes">
        <div class="wg-sh">${tile3d('megaphone', 28)}<div>${bi('ประกาศจาก Officer', 'ANNOUNCEMENTS')}</div><span class="grow"></span>${unseenN ? `<button class="btn btn-tonal sm" data-wg="ack">${ic('check', 'sm')}รับทราบ ${unseenN}</button>` : `<span class="wg-count num">${notes.length}</span>`}</div>
        ${notes.length ? `<div class="wg-notes">${notes.map(note).join('')}</div>` : `<div class="wg-ok muted">${tile3d('info', 36)}<div><b>ยังไม่มีประกาศ</b><span>ประกาศจาก Officer จะแสดงที่นี่ทันที</span></div></div>`}
      </section>
      <footer class="wg-f"><span class="wg-offmsg">${ic('alert', 'sm')}ออฟไลน์ — แสดงข้อมูลล่าสุด</span>${App.officer ? '' : `<span class="faint">โหมด Operator</span>`}${!('Notification' in window) || Notification.permission === 'granted' ? '' : `<button class="link" data-wg="notif">${ic('bell', 'sm')}เปิดแจ้งเตือนบนเดสก์ท็อป</button>`}</footer>
    </div>`;
  },

  /** desktop notification for items / announcements that were not there last time */
  notify() {
    const { need, late, req } = this.items(this.d), notes = this.notes(this.d);
    const now = { i: [...need, ...late, ...req].map(x => x.id), n: notes.map(n => n.id) };
    const prev = this.seen;
    this.seen = now; localStorageSet('wgSeen', JSON.stringify(now));
    // once a day: past the reminder time and today's team still hasn't recorded STOCK
    const rk = 'wgRemind' + this.d.today;
    if (!this.d.today_recorded && Shift.late() && localStorageGet(rk) !== '1') {
      localStorageSet(rk, '1');
      const tT = Shift.teamOn(this.d.today);
      $('#wg-root')?.classList.add('ping'); setTimeout(() => $('#wg-root')?.classList.remove('ping'), 2600);
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('HRM STOCK · ยังไม่ลง STOCK', { body: (tT ? `ทีม ${Shift.label(tT)} (${Shift.members(tT).join(', ')})` : 'กะเช้าวันนี้') + ` ยังไม่ได้ลงข้อมูล STOCK วันนี้ — เลย ${Shift.remindAt()} แล้ว`, tag: 'hrm-remind' }); } catch (e) { }
    }
    if (!prev) return;
    const newI = [...need, ...late, ...req].filter(x => !prev.i.includes(x.id)), newN = notes.filter(n => !prev.n.includes(n.id));
    if (!newI.length && !newN.length) return;
    $('#wg-root')?.classList.add('ping'); setTimeout(() => $('#wg-root')?.classList.remove('ping'), 2600);
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      if (newI.length) new Notification('HRM STOCK · ต้องสั่ง', { body: newI.slice(0, 3).map(x => x.name).join(', ') + (newI.length > 3 ? ` +${newI.length - 3}` : ''), tag: 'hrm-need' });
      if (newN.length) new Notification('HRM STOCK · ประกาศใหม่', { body: newN[0].title || newN[0].body.slice(0, 80), tag: 'hrm-note' });
    } catch (e) { /* some shells block notifications */ }
  },

  async click(e) {
    const b = e.target.closest('[data-wg]'); if (!b) return;
    const a = b.dataset.wg;
    if (a === 'refresh' || a === 'reload') { App._dash = null; return this.load(); }
    if (a === 'ack') { const top = Math.max(0, ...this.notes(this.d).map(n => n.id)); localStorageSet('noteAck', String(top)); return this.render(); }
    if (a === 'notif') { try { await Notification.requestPermission(); } catch (er) { } return this.render(); }
    if (a === 'open' || a === 'item' || a === 'entry') {
      const page = a === 'item' ? 'stock' : a === 'entry' ? 'entry' : 'home';
      if (window.pywebview?.api?.focus_main) { try { await window.pywebview.api.focus_main(page); return; } catch (er) { } }
      try { if (window.opener && !window.opener.closed) { window.opener.location.hash = page; window.opener.focus(); return; } } catch (er) { }
      const url = IS_WEB ? location.origin + '/#' + page : IS_GAS ? (App.info?.url || '') : location.pathname + '#' + page;
      if (url) window.open(url, '_blank');
    }
  },
};

/* ===== ordering.js ===== */
/* =====================================================================
   MATERIAL ORDER REQUESTS
   • Home → "ถึงจุดสั่งซื้อ · ยังไม่ได้สั่ง": tap items → they drop into the basket below with the normal order qty
     (editable; more than normal needs a reason) → สั่งซื้อ
       Operator → request goes to the Officer (state requested, Officer is notified and places it with dates)
       Officer  → order is placed right away
   • Double-click a NORMAL status badge → "สถานะยังปกติ ต้องการสั่งซื้อไหม?" → reason required
   • Officer: requested order → สั่งซื้อ · ใส่วันที่ (order date / delivery date / qty)
   ===================================================================== */
'use strict';

const OrderBasket = {
  sel: new Map(),        // material id → { qty, reason }
  need: {},              // material id → need_order row (name, unit, order_qty, balance …)
  setNeed(list) { this.need = {}; (list || []).forEach(m => { this.need[m.id] = m; }); [...this.sel.keys()].forEach(k => { if (!this.need[k]) this.sel.delete(k); }); },
  toggle(mid) {
    const m = this.need[mid]; if (!m) return;
    if (this.sel.has(mid)) this.sel.delete(mid); else this.sel.set(mid, { qty: m.order_qty || '', reason: '' });
  },
  html() {
    if (!this.sel.size) return '';
    const rows = [...this.sel.entries()].map(([mid, v]) => {
      const m = this.need[mid]; if (!m) return '';
      const over = +parseNum(v.qty) > (+m.order_qty || 0) + 1e-9;
      return `<div class="ob-row ${over ? 'over' : ''}" data-mid="${mid}">
        <div class="ob-n"><b>${esc(m.name)}</b><span>คงเหลือ ${fmtN(m.balance)} / จุดสั่ง ${fmtN(m.reorder_point)} ${esc(m.unit)} · ปกติสั่งครั้งละ ${fmtN(m.order_qty)}</span></div>
        <label class="ob-q"><input class="input num" data-obq="${mid}" inputmode="decimal" value="${esc(String(v.qty))}"><span>${esc(m.unit)}</span></label>
        <button class="icon-btn sm" data-obrm="${mid}" title="เอาออก">${ic('x', 'sm')}</button>
        ${over ? `<label class="ob-r"><span>${ic('alert', 'sm')}สั่งมากกว่าปกติ (${fmtN(m.order_qty)} ${esc(m.unit)}) — ระบุเหตุผล <b class="req">*</b></span><input class="input" data-obr="${mid}" maxlength="120" value="${esc(v.reason)}" placeholder="เช่น ใช้มากขึ้นช่วงซ่อมบำรุง, Supplier หยุดยาว"></label>` : ''}
      </div>`;
    }).join('');
    return `<div class="ob">
      <div class="ob-h">${ic('order', 'sm')}<b>รายการสั่งซื้อ ${this.sel.size} รายการ</b><span>${App.officer ? 'สั่งซื้อทันที แล้วใส่วันส่งภายหลังได้' : 'ส่งให้ Officer สั่งซื้อและใส่วันที่'}</span></div>
      <div class="ob-list">${rows}</div>
      <div class="ob-f">${App.officer ? '' : `<label class="ob-who">${ic('user', 'sm')}<input class="input" id="ob-who" maxlength="30" placeholder="ลงชื่อผู้สั่ง" value="${esc(localStorageGet('opsName') || '')}"></label>`}
        <span class="grow"></span><button class="btn btn-ghost sm" data-obclear>ล้าง</button>
        <button class="btn btn-primary" data-obgo>${ic('check', 'sm')}${App.officer ? `สั่งซื้อ ${this.sel.size} รายการ` : `ส่งคำขอสั่งซื้อ ${this.sel.size} รายการ`}</button></div>
      <div class="err-text" id="ob-err"></div></div>`;
  },
  redraw(lane) {
    const box = lane.querySelector('.nl-basket'); if (!box) return;
    box.innerHTML = this.html();
    lane.querySelectorAll('[data-pick]').forEach(c => c.classList.toggle('on', this.sel.has(+c.dataset.pick)));
  },
  /** click / input handling inside a Material lane — returns true when handled */
  async handle(e, lane, done) {
    const t = e.target;
    const pk = t.closest('[data-pick]');
    if (pk) { this.toggle(+pk.dataset.pick); this.redraw(lane); const q = lane.querySelector(`[data-obq="${pk.dataset.pick}"]`); q && (q.focus(), q.select()); return true; }
    const rm = t.closest('[data-obrm]'); if (rm) { this.sel.delete(+rm.dataset.obrm); this.redraw(lane); return true; }
    if (t.closest('[data-obclear]')) { this.sel.clear(); this.redraw(lane); return true; }
    const go = t.closest('[data-obgo]');
    if (go) {
      const err = lane.querySelector('#ob-err'); err.textContent = '';
      const who = lane.querySelector('#ob-who')?.value.trim() || '';
      const items = [...this.sel.entries()].map(([mid, v]) => ({ material_id: mid, qty: v.qty, reason: v.reason }));
      for (const it of items) {
        const m = this.need[it.material_id], q = +parseNum(it.qty);
        if (!(q > 0)) { err.textContent = `${m.name}: ใส่จำนวนที่จะสั่ง`; lane.querySelector(`[data-obq="${it.material_id}"]`)?.focus(); return true; }
        if (q > (+m.order_qty || 0) + 1e-9 && !it.reason.trim()) { err.textContent = `${m.name}: สั่งมากกว่าปกติ — กรุณาระบุเหตุผล`; lane.querySelector(`[data-obr="${it.material_id}"]`)?.focus(); return true; }
        it.qty = q;
      }
      if (!App.officer && !who) { err.textContent = 'กรุณาลงชื่อผู้สั่ง'; lane.querySelector('#ob-who')?.focus(); return true; }
      go.disabled = true;
      try {
        const r = await api('order_request', items, who);
        if (who) localStorageSet('opsName', who);
        if (localStorageGet('opPlaced') === null) localStorageSet('opPlaced', '[]');
        this.sel.clear();
        toast(App.officer ? 'สั่งซื้อแล้ว' : 'ส่งคำขอสั่งซื้อให้ Officer แล้ว', `${r.ids.join(', ')}${App.officer ? ' · ใส่วันส่งได้ที่รายการ' : ' · Officer จะสั่งซื้อและใส่วันที่'}`);
        await App.bumpRev(); done && done();
      } catch (er) { err.textContent = er.message; go.disabled = false; }
      return true;
    }
    return false;
  },
  input(e, lane) {
    const q = e.target.closest('[data-obq]');
    if (q) {
      const mid = +q.dataset.obq, v = this.sel.get(mid); if (!v) return;
      q.value = q.value.replace(/[^\d.,]/g, ''); v.qty = q.value;
      const m = this.need[mid], over = +parseNum(v.qty) > (+m.order_qty || 0) + 1e-9, row = q.closest('.ob-row');
      if (over !== row.classList.contains('over')) { const pos = q.selectionStart; this.redraw(lane); const nq = lane.querySelector(`[data-obq="${mid}"]`); nq.focus(); nq.setSelectionRange(pos, pos); }
      return;
    }
    const r = e.target.closest('[data-obr]'); if (r) { const v = this.sel.get(+r.dataset.obr); if (v) v.reason = r.value; }
  },
};

/** Double-click a NORMAL status → order anyway (reason required) */
const NormalOrder = {
  async open(mid) {
    let m = null;
    try { m = (await api('stock_list')).find(x => x.id === mid); } catch (e) { return toastErr(e); }
    if (!m) return;
    if (m.state !== 'normal') return toast('รายการนี้ไม่ได้อยู่ในสถานะปกติแล้ว', esc(m.name), 'info');
    const ok = await modal({
      title: 'ต้องการสั่งซื้อไหม?', en: 'STOCK IS STILL NORMAL', icon: 'order', color: 'var(--st-ordered)', ok: App.officer ? 'ยืนยันสั่งซื้อ' : 'ยืนยัน ส่งคำขอสั่งซื้อ', okEn: 'Order',
      body: `<div class="no-box"><b>${esc(m.name)}</b><span>ตอนนี้สถานะยัง <b class="ok">ปกติ</b> — คงเหลือ ${fmtN(m.balance)} ${esc(m.unit)} (จุดสั่งซื้อ ${fmtN(m.reorder_point)})</span></div>
        <div class="frow" style="margin-top:12px"><div class="field"><label>จำนวนที่สั่ง <span class="en">ปกติครั้งละ ${fmtN(m.order_qty)} ${esc(m.unit)}</span></label><input class="input num" id="no-q" inputmode="decimal" value="${esc(String(m.order_qty || ''))}"></div>
        ${App.officer ? '' : `<div class="field"><label>ลงชื่อผู้สั่ง <span class="req">*</span></label><input class="input" id="no-w" maxlength="30" value="${esc(localStorageGet('opsName') || '')}"></div>`}</div>
        <div class="field" style="margin-top:10px"><label>เหตุผลที่ต้องสั่งซื้อ <span class="req">*</span> <span class="en">REQUIRED</span></label><input class="input" id="no-r" maxlength="120" placeholder="เช่น เตรียมสำรองก่อนหยุดยาว, แผนผลิตเพิ่ม"></div>
        <div class="err-text" style="margin-top:8px"></div>`,
      onOk: async box => {
        const q = +parseNum(box.querySelector('#no-q').value), r = box.querySelector('#no-r').value.trim(), w = box.querySelector('#no-w')?.value.trim() || '';
        if (!(q > 0)) throw new Error('ใส่จำนวนที่จะสั่ง');
        if (!r) { box.querySelector('#no-r').focus(); throw new Error('กรุณาระบุเหตุผลที่ต้องสั่งซื้อ'); }
        if (!App.officer && !w) throw new Error('กรุณาลงชื่อผู้สั่ง');
        const res = await api('order_request', [{ material_id: mid, qty: q, reason: r }], w);
        if (w) localStorageSet('opsName', w);
        if (localStorageGet('opPlaced') === null) localStorageSet('opPlaced', '[]');
        return res;
      },
    });
    if (!ok) return;
    toast(App.officer ? 'สั่งซื้อแล้ว' : 'ส่งคำขอสั่งซื้อให้ Officer แล้ว', `${esc(m.name)} · ${ok.ids.join(', ')}`);
    await App.bumpRev(); App.refresh();
  },
};
document.addEventListener('dblclick', e => {
  const b = e.target.closest('[data-normord]'); if (!b) return;
  e.preventDefault(); window.getSelection?.().removeAllRanges();
  NormalOrder.open(+b.dataset.normord);
});

document.addEventListener('click', e => {
  const q = e.target.closest('[data-rjq]'); if (!q) return;
  const i = q.closest('.modal')?.querySelector('#rj-r'); if (i) { i.value = q.dataset.rjq; i.focus(); }
});

/** Officer: place a requested order — order date, delivery date, quantity */
const OrderConfirm = {
  async open(o) {
    const ok = await modal({
      title: `สั่งซื้อ ${o.material.name}`, en: `PLACE ORDER · ${o.id}`, icon: 'order', color: 'var(--primary)', ok: 'บันทึกการสั่งซื้อ', okEn: 'Place order',
      body: `<div class="no-box"><b>ขอสั่งโดย ${esc(o.requested_by || '-')}</b><span>${fmtD(o.created_at)} ${fmtTime(o.created_at)}${o.remark ? ` · เหตุผล: ${esc(o.remark)}` : ''}</span></div>
        <div class="frow" style="margin-top:12px">
          <div class="field"><label>จำนวนที่สั่ง <span class="en">${esc(o.material.unit)}</span></label><input class="input num" id="oc-q" inputmode="decimal" value="${esc(String(o.ordered_qty))}"></div>
          <div class="field"><label>วันที่สั่ง</label><input class="input" type="date" id="oc-d" value="${App.today}"></div>
          <div class="field"><label>วันที่ของมาส่ง <span class="en">ไม่ทราบเว้นว่าง</span></label><input class="input" type="date" id="oc-e" min="${App.today}"></div></div>
        <div class="err-text" style="margin-top:8px"></div>`,
      onOk: async box => {
        await api('order_confirm', o.id, { ordered_qty: box.querySelector('#oc-q').value, order_date: box.querySelector('#oc-d').value, expected_date: box.querySelector('#oc-e').value || null });
        return true;
      },
    });
    if (!ok) return false;
    toast('บันทึกการสั่งซื้อแล้ว', `${o.id} · ${esc(o.material.name)}`);
    await App.bumpRev();
    return true;
  },

  /** decline a request from the floor — reason required, shown to the Operator who asked */
  async reject(o) {
    const ok = await modal({
      title: `ไม่อนุมัติคำขอ ${o.material.name}?`, en: `REJECT REQUEST · ${o.id}`, icon: 'x', color: 'var(--st-need)', danger: true, ok: 'ไม่อนุมัติ', okEn: 'Reject',
      body: `<div class="no-box"><b>ขอโดย ${esc(o.requested_by || '-')} · ${fmtN(o.ordered_qty)} ${esc(o.material.unit)}</b><span>${fmtD(o.created_at)} ${fmtTime(o.created_at)}${o.remark ? ` · เหตุผลที่ขอ: ${esc(o.remark)}` : ''}</span></div>
        <div class="field" style="margin-top:12px"><label>เหตุผลที่ไม่อนุมัติ <span class="req">*</span> <span class="en">Operator จะเห็นข้อความนี้</span></label>
          <input class="input" id="rj-r" maxlength="120" placeholder="เช่น สต็อกยังพอถึงสิ้นเดือน, รอรวมสั่งพร้อม Supplier เดียวกัน"></div>
        <div class="rj-quick">${['สต็อกยังพอใช้', 'รอรวมสั่งรอบหน้า', 'เกินงบเดือนนี้', 'สั่งไปแล้วในใบอื่น'].map(t => `<button type="button" class="chip-btn" data-rjq="${t}">${t}</button>`).join('')}</div>
        <div class="err-text" style="margin-top:8px"></div>`,
      onOk: async box => {
        const r = box.querySelector('#rj-r').value.trim();
        if (!r) { box.querySelector('#rj-r').focus(); throw new Error('กรุณาระบุเหตุผลที่ไม่อนุมัติ'); }
        await api('order_reject', o.id, r); return true;
      },
    });
    if (!ok) return false;
    toast('ไม่อนุมัติคำขอแล้ว', `${o.id} · แจ้ง ${esc(o.requested_by || 'Operator')} แล้ว`, 'info');
    await App.bumpRev();
    return true;
  },
  /** several requests at once — one order date / delivery date for all, quantity per line */
  async bulk(list) {
    if (!list.length) return false;
    const rows = list.map(o => `<label class="cb-row" data-cb="${esc(o.id)}"><input type="checkbox" checked>
        <div class="cb-n"><b>${esc(o.material.name)}</b><span>${esc(o.id)} · ขอโดย ${esc(o.requested_by || '-')}${o.remark ? ' · ' + esc(o.remark) : ''}</span></div>
        <span class="ob-q"><input class="input num" inputmode="decimal" value="${esc(String(o.ordered_qty))}"><span>${esc(o.material.unit)}</span></span></label>`).join('');
    const ok = await modal({
      title: `สั่งซื้อ ${list.length} รายการ`, en: 'PLACE REQUESTED ORDERS', icon: 'order', color: 'var(--primary)', ok: 'บันทึกการสั่งซื้อ', okEn: 'Place orders',
      body: `<div class="cb-list">${rows}</div>
        <div class="frow" style="margin-top:12px">
          <div class="field"><label>วันที่สั่ง <span class="en">ใช้กับทุกรายการ</span></label><input class="input" type="date" id="cb-d" value="${App.today}"></div>
          <div class="field"><label>วันที่ของมาส่ง <span class="en">ไม่ทราบเว้นว่าง</span></label><input class="input" type="date" id="cb-e" min="${App.today}"></div></div>
        <div class="err-text" style="margin-top:8px"></div>`,
      onOk: async box => {
        const od = box.querySelector('#cb-d').value, ed = box.querySelector('#cb-e').value || null;
        const pick = [...box.querySelectorAll('[data-cb]')].filter(r => r.querySelector('input[type=checkbox]').checked);
        if (!pick.length) throw new Error('เลือกอย่างน้อย 1 รายการ');
        let n = 0;
        for (const r of pick) {
          const o = list.find(x => x.id === r.dataset.cb);
          try { await api('order_confirm', o.id, { ordered_qty: r.querySelector('.num').value, order_date: od, expected_date: ed }); n++; r.classList.add('done'); r.querySelector('input[type=checkbox]').checked = false; }
          catch (e) { if (n) await App.bumpRev(); throw new Error(`${o.material.name}: ${e.message}${n ? ` (บันทึกไปแล้ว ${n} รายการ)` : ''}`); }
        }
        return n;
      },
    });
    if (!ok) return false;
    toast(`บันทึกการสั่งซื้อแล้ว ${ok} รายการ`, 'แจ้ง Operator ที่ขอสั่งแล้ว');
    await App.bumpRev();
    return true;
  },
};

/** Operator home: what was requested from the floor and where it is now — ขอแล้ว › Officer สั่งแล้ว › ของเข้าแล้ว */
const MyReq = {
  scope: 'me',
  list(d) {
    const T = d.today, me = (localStorageGet('opsName') || '').trim().toUpperCase();
    const all = d.requests || [];
    const mine = me ? all.filter(o => o.requested_by.toUpperCase() === me) : [];
    return { all, mine, me, rows: this.scope === 'me' && me ? mine : all };
  },
  step(o) {
    if (o.status === 'requested') return { i: 0, th: 'รอ Officer สั่งซื้อ', en: 'WAITING FOR OFFICER', tone: 'wait' };
    if (o.status === 'rejected') { const m = String(o.remark || '').match(/ไม่อนุมัติ:\s*(.*)$/); return { i: -1, th: 'ไม่อนุมัติ', en: 'REJECTED', tone: 'rej', why: m ? m[1] : '' }; }
    if (o.status === 'received') return { i: 2, th: `ของเข้าแล้ว ${fmtDShort(o.done_date)}`, en: 'RECEIVED', tone: 'ok' };
    if (o.partial) return { i: 1, th: `รับแล้ว ${fmtN(o.received_qty)} / ${fmtN(o.ordered_qty)}`, en: 'PARTIAL DELIVERY', tone: 'ship' };
    if (o.status === 'overdue') return { i: 1, th: `เกินกำหนดส่ง ${fmtDShort(o.expected_date)}`, en: 'OVERDUE', tone: 'over' };
    if (o.status === 'today') return { i: 1, th: 'ของเข้าวันนี้', en: 'DELIVERY TODAY', tone: 'ship' };
    if (o.status === 'scheduled') return { i: 1, th: `กำหนดส่ง ${fmtD(o.expected_date)}`, en: 'DELIVERY SCHEDULED', tone: 'ship' };
    return { i: 1, th: 'Officer สั่งแล้ว — รอกำหนดส่ง', en: 'ORDERED · NO DATE YET', tone: 'wait' };
  },
  html(d) {
    if (App.officer) return '';
    const L = this.list(d);
    if (!L.all.length) return '';
    const fin = o => o.status === 'received' || o.status === 'rejected';
    const rows = L.rows.slice().sort((a, b) => fin(a) - fin(b) || String(b.created_at).localeCompare(String(a.created_at)));
    const dots = i => ['ขอแล้ว', 'Officer สั่งแล้ว', 'ของเข้าแล้ว'].map((t, k) => `<span class="mr-s ${k < i ? 'done' : k === i ? 'cur' : ''}"><i></i><em>${t}</em></span>`).join('');
    return `<section class="cc-card mr-card"><div class="mr-h">${ic('order', 'sm')}<div>${bi(L.me && this.scope === 'me' ? `คำขอสั่งซื้อของฉัน · ${esc(L.me)}` : 'คำขอสั่งซื้อจากหน้างาน', 'MY MATERIAL REQUESTS')}</div><span class="grow"></span>
        ${L.me ? `<div class="seg sm" id="mr-scope"><button data-mrs="me" class="${this.scope === 'me' ? 'on' : ''}">ของฉัน ${L.mine.length}</button><button data-mrs="all" class="${this.scope === 'all' ? 'on' : ''}">ทุกคน ${L.all.length}</button></div>` : ''}</div>
      ${rows.length ? `<div class="mr-list">${rows.map(o => { const s = this.step(o); return `<div class="mr-row t-${s.tone}" data-oid="${esc(o.id)}">
          <div class="mr-m">${mpic(o.material, 34)}<div class="mr-n"><b>${esc(o.material.name)}</b><span>${fmtN(o.ordered_qty)} ${esc(o.material.unit)} · ${esc(o.id)}${this.scope === 'all' || !L.me ? ` · ขอโดย ${esc(o.requested_by)}` : ''}</span></div></div>
          ${s.i < 0 ? `<div class="mr-why">${ic('x', 'sm')}<span><b>เหตุผล:</b> ${esc(s.why || '-')}${o.officer ? ` <em>— ${esc(o.officer)}</em>` : ''}</span></div>` : `<div class="mr-trk">${dots(s.i === 2 ? 3 : s.i)}</div>`}
          <div class="mr-st"><b>${s.th}</b><span>${s.en}</span></div></div>`; }).join('')}</div>`
        : `<div class="nl-empty">${ic('check')}<span>ยังไม่มีคำขอของ ${esc(L.me)} — ดูของทุกคนได้ที่ “ทุกคน”</span></div>`}
    </section>`;
  },
  bind(el, redraw) {
    el.querySelector('#mr-scope')?.addEventListener('click', e => { const b = e.target.closest('[data-mrs]'); if (!b) return; e.stopPropagation(); this.scope = b.dataset.mrs; redraw(); });
  },
};

/* ===== adjust.js ===== */
/* =====================================================================
   STOCK CORRECTIONS — a number that was already saved is changed (e.g. SRR-104 usage vs the tank gauge)
   • Operator / Officer: a warning pop-up lists every change (old → new, effect on the balance) and asks for a reason
   • the server logs each change (stock_adjust) → the Officer sees a prominent banner on Home and acknowledges it
   ===================================================================== */
'use strict';

const StockFix = {
  QUICK: ['ปรับให้ตรงมาตรวัดในถัง', 'กรอกผิด', 'ตรวจนับสต็อกจริง', 'บันทึกซ้ำ / ลืมบันทึก'],
  FIELD: { received: 'รับสินค้า', used: 'ใช้ไป' },
  sign: n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtN(Math.abs(n)),

  /** changes: [{name, unit, date, field, old, new}] → reason (string) or null when cancelled */
  async ask(changes) {
    const rows = changes.map(c => {
      const d = (c.new ?? 0) - (c.old ?? 0), eff = c.field === 'received' ? d : -d;
      return `<div class="sf-row"><b>${esc(c.name)}</b><span class="muted">${fmtD(c.date)} · ${this.FIELD[c.field]}</span>
        <span class="num sf-ch"><s>${fmtN(c.old)}</s>${ic('arrowR', 'sm')}<b>${c.new == null ? 'ว่าง' : fmtN(c.new)}</b></span>
        <span class="sf-eff ${eff < 0 ? 'neg' : 'pos'}" title="ผลต่อยอดคงเหลือ">คงเหลือ ${this.sign(eff)} ${esc(c.unit || '')}</span></div>`;
    }).join('');
    const r = await modal({
      title: `แก้ยอดที่บันทึกไว้แล้ว ${changes.length} รายการ`, en: 'STOCK CORRECTION', icon: 'alert', color: 'var(--st-ordered)',
      ok: 'ยืนยันแก้ยอด', okEn: 'Confirm correction',
      body: `<div class="sf-list">${rows}</div>
        <div class="sf-note">${ic('bell', 'sm')}${App.officer ? 'การแก้ไขนี้จะถูกเก็บในประวัติการแก้ยอด' : '<span>การแก้ไขนี้จะ <b>แจ้งไปยัง Officer</b> ให้รับทราบ</span>'}</div>
        <div class="field" style="margin-top:12px"><label>เหตุผลที่แก้ <span class="req">*</span> <span class="en">REASON</span></label>
          <input class="input" id="sf-r" maxlength="120" placeholder="เช่น วัดระดับในถังได้ 18,500 L"></div>
        <div class="rj-quick">${this.QUICK.map(t => `<button type="button" data-sfq="${t}">${t}</button>`).join('')}</div>
        <div class="err-text" style="margin-top:8px"></div>`,
      onOk: box => {
        const v = box.querySelector('#sf-r').value.trim();
        if (!v) { box.querySelector('#sf-r').focus(); throw new Error('กรุณาระบุเหตุผลที่แก้ยอด'); }
        return { reason: v };
      },
    });
    return r ? r.reason : null;
  },

  /* ---------- Officer home: corrections waiting to be acknowledged ---------- */
  open: false,
  banner(d) {
    const L = d.adjusts || [];
    if (!App.officer || !L.length) return '';
    const shown = this.open ? L : L.slice(0, 4);
    const total = {}; L.forEach(a => { const k = a.material.name; total[k] = (total[k] || 0) + 1; });
    return `<section class="sfb">
      <header class="sfb-h"><span class="sfb-ic">${ic('alert')}</span>
        <div><b>มีการแก้ยอด Stock ให้ตรงของจริง ${L.length} รายการ</b><span>${Object.entries(total).slice(0, 3).map(([n, c]) => `${esc(n)}${c > 1 ? ` ×${c}` : ''}`).join(' · ')}${Object.keys(total).length > 3 ? ` · +${Object.keys(total).length - 3}` : ''} — ตรวจสอบแล้วกดรับทราบ</span></div>
        <span class="grow"></span><button class="btn btn-primary sm" data-sfack="all">${ic('check', 'sm')}รับทราบทั้งหมด</button></header>
      <div class="sfb-list">${shown.map(a => `<div class="sfb-row">
          <div class="sfb-m"><b>${esc(a.material.name)}</b><span>${fmtD(a.date)} · ${this.FIELD[a.field]}</span></div>
          <div class="sfb-ch num"><s>${fmtN(a.old)}</s>${ic('arrowR', 'sm')}<b>${a.new == null ? 'ว่าง' : fmtN(a.new)}</b><em class="${a.balance_effect < 0 ? 'neg' : 'pos'}">คงเหลือ ${this.sign(a.balance_effect)} ${esc(a.material.unit)}</em></div>
          <div class="sfb-why">${a.reason ? `“${esc(a.reason)}”` : '<span class="faint">ไม่ได้ระบุเหตุผล</span>'}</div>
          <div class="sfb-who"><b>${esc(a.who)}</b><span>${Notif.ago(a.at)}${a.source === 'mobile' ? ' · มือถือ' : ''}</span></div>
          <button class="btn btn-plain sm" data-sfack="${a.id}">รับทราบ</button></div>`).join('')}</div>
      <div class="sfb-f">${L.length > 4 ? `<button class="link" data-sfmore>${this.open ? 'ย่อรายการ' : `แสดงทั้งหมด ${L.length} รายการ`}</button>` : ''}<span class="grow"></span><button class="link" data-xgo="adjust">${ic('history', 'sm')}ประวัติการแก้ยอดทั้งหมด ${ic('arrowR', 'sm')}</button></div>
    </section>`;
  },
  bind(el, d, redraw) {
    el.querySelector('.sfb')?.addEventListener('click', async e => {
      if (e.target.closest('[data-sfmore]')) { this.open = !this.open; return redraw(); }
      if (e.target.closest('[data-xgo="adjust"]')) return App.go('adjust');
      const b = e.target.closest('[data-sfack]'); if (!b) return;
      b.disabled = true;
      try {
        const r = await api('adjust_ack', b.dataset.sfack === 'all' ? [] : [+b.dataset.sfack]);
        toast('รับทราบการแก้ยอดแล้ว', `${r.acked} รายการ`);
        await App.bumpRev(); App.refresh();
      } catch (er) { b.disabled = false; toastErr(er); }
    });
  },
  /** Officer pop-up once per computer for each new correction */
  toasts(d) {
    if (!App.officer) return;
    const L = d.adjusts || [];
    let seen = null; try { seen = JSON.parse(localStorageGet('adjSeen') || 'null'); } catch (e) { }
    if (Array.isArray(seen)) L.filter(a => !seen.includes(a.id)).slice(0, 2).forEach((a, i) => setTimeout(() => Notif.toast({
      tone: 'over', icon: 'alert', title: `แก้ยอด ${a.material.name} · ${this.FIELD[a.field]} ${fmtN(a.old)} → ${a.new == null ? 'ว่าง' : fmtN(a.new)}`,
      sub: `${fmtD(a.date)} · ${a.who}${a.reason ? ' · ' + a.reason : ''}`,
    }, 'mat'), 900 + i * 450));
    localStorageSet('adjSeen', JSON.stringify([...new Set((seen || []).concat(L.map(a => a.id)))].slice(-300)));
  },
};
document.addEventListener('click', e => {
  const q = e.target.closest('[data-sfq]'); if (!q) return;
  const i = q.closest('.modal')?.querySelector('#sf-r'); if (i) { i.value = q.dataset.sfq; i.focus(); }
});

/* =============================== STOCK CORRECTION HISTORY =============================== */
PAGES.adjust = {
  title: ['ประวัติการแก้ยอด Stock', 'Stock corrections'],
  month: null, all: false, mat: 0, st: 'all', q: '',
  async render(el) {
    this.month = this.month || App.today.slice(0, 7);
    const list = await api('adjust_list', this.all ? null : this.month);
    const mv = n => { const d = pd(this.month + '-01'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
    // per-material summary — where the book keeps drifting from the real stock
    const sum = new Map();
    list.forEach(a => {
      const k = a.material.id, g = sum.get(k) || { m: a.material, n: 0, net: 0, big: 0, open: 0 };
      g.n++; g.net += a.balance_effect; g.big = Math.max(g.big, Math.abs(a.balance_effect)); if (!a.ack_at) g.open++;
      sum.set(k, g);
    });
    const cards = [...sum.values()].sort((a, b) => b.n - a.n);
    const open = list.filter(a => !a.ack_at).length;
    el.innerHTML = `<div class="page adj">
      <div class="toolbar">
        <div class="datebox"><button class="icon-btn" data-mv="-1" ${this.all ? 'disabled' : ''}>${ic('chevL')}</button><div class="dlabel"><div class="d">${this.all ? 'ทุกเดือน' : fmtMonth(this.month)}</div><div class="s">${this.all ? 'ALL MONTHS' : fmtMonthEn(this.month)} · ตามวันที่ถูกแก้</div></div><button class="icon-btn" data-mv="1" ${this.all ? 'disabled' : ''}>${ic('chevR')}</button></div>
        <label class="adj-all"><span class="switch"><input type="checkbox" id="adj-all" ${this.all ? 'checked' : ''}><span></span></span>ดูทุกเดือน</label>
        <div class="seg" id="adj-st">${[['all', 'ทั้งหมด', list.length], ['open', 'รอรับทราบ', open], ['ack', 'รับทราบแล้ว', list.length - open]].map(([k, t, n]) => `<button data-st="${k}" class="${this.st === k ? 'on' : ''}">${t}<span class="n">${n}</span></button>`).join('')}</div>
        <span class="grow"></span>
        <label class="search">${ic('search', 'sm')}<input class="input" id="adj-q" placeholder="ค้นหา Material / ผู้แก้ / เหตุผล…" value="${esc(this.q)}"></label>
        ${App.officer && open ? `<button class="btn btn-primary" data-sfack="all">${ic('check', 'sm')}รับทราบทั้งหมด ${open}</button>` : ''}
      </div>
      ${cards.length ? `<div class="adj-sum">${cards.map(g => `<button class="adj-card ${this.mat === g.m.id ? 'on' : ''}" data-mat="${g.m.id}">
          <b>${esc(g.m.name)}</b><span class="adj-n"><em class="num">${g.n}</em> ครั้ง${g.open ? ` · <i>รอรับทราบ ${g.open}</i>` : ''}</span>
          <span class="adj-net ${g.net < 0 ? 'neg' : g.net > 0 ? 'pos' : ''}">สุทธิ ${StockFix.sign(g.net)} ${esc(g.m.unit)}</span><small>มากสุดครั้งละ ${fmtN(g.big)} ${esc(g.m.unit)}</small></button>`).join('')}</div>` : ''}
      <div class="rhead g-adj"><span>วันที่ถูกแก้</span><span>Material</span><span class="r">เดิม → ใหม่</span><span class="r">ผลต่อคงเหลือ</span><span>เหตุผล</span><span>ผู้แก้</span><span>สถานะ</span></div>
      <div class="rows" id="adj-rows"></div></div>`;
    const draw = () => {
      const q = this.q.trim().toLowerCase();
      const rows = list.filter(a => (!this.mat || a.material.id === this.mat) && (this.st === 'all' || (this.st === 'open') === !a.ack_at)
        && (!q || `${a.material.name} ${a.who} ${a.reason}`.toLowerCase().includes(q)));
      el.querySelector('#adj-rows').innerHTML = rows.length ? rows.map(a => `<div class="rrow g-adj ${a.ack_at ? '' : 'open'}">
          <span>${bi(fmtD(a.date), StockFix.FIELD[a.field])}</span>
          <span class="adj-m"><b>${esc(a.material.name)}</b></span>
          <span class="r num adj-ch"><s>${fmtN(a.old)}</s>${ic('arrowR', 'sm')}<b>${a.new == null ? 'ว่าง' : fmtN(a.new)}</b></span>
          <span class="r"><em class="adj-eff ${a.balance_effect < 0 ? 'neg' : 'pos'}">${StockFix.sign(a.balance_effect)} ${esc(a.material.unit)}</em></span>
          <span class="adj-why">${a.reason ? esc(a.reason) : '<span class="faint">—</span>'}</span>
          <span class="adj-who">${typeof People !== 'undefined' ? People.avatar(a.who, 28) : ''}<span>${bi(esc(a.who), `${fmtD(a.at)} ${fmtTime(a.at)}${a.source === 'mobile' ? ' · มือถือ' : a.source === 'month' ? ' · รายเดือน' : ''}`)}</span></span>
          <span>${a.ack_at ? `<span class="badge ok"><span class="dot"></span>รับทราบ · ${esc(a.ack_by || '')}</span>` : App.officer ? `<button class="btn btn-plain sm" data-sfack="${a.id}">${ic('check', 'sm')}รับทราบ</button>` : '<span class="badge ordered"><span class="dot"></span>รอ Officer</span>'}</span>
        </div>`).join('')
        : `<div class="card">${emptyState('check', list.length ? 'ไม่พบรายการตามตัวกรอง' : 'ยังไม่มีการแก้ยอดในช่วงนี้', 'No corrections', list.length ? '' : 'เมื่อมีการแก้ตัวเลขที่บันทึกไว้แล้ว จะแสดงที่นี่พร้อมเหตุผล')}</div>`;
    };
    draw();
    el.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { this.month = mv(+b.dataset.mv); this.mat = 0; this.render(el); });
    el.querySelector('#adj-all').onchange = e => { this.all = e.target.checked; this.mat = 0; this.render(el); };
    el.querySelector('#adj-st').onclick = e => { const b = e.target.closest('[data-st]'); if (!b) return; this.st = b.dataset.st; $$('#adj-st button', el).forEach(x => x.classList.toggle('on', x === b)); draw(); };
    el.querySelector('#adj-q').oninput = e => { this.q = e.target.value; draw(); };
    el.onclick = async e => {
      const c = e.target.closest('[data-mat]'); if (c) { this.mat = this.mat === +c.dataset.mat ? 0 : +c.dataset.mat; $$('.adj-card', el).forEach(x => x.classList.toggle('on', +x.dataset.mat === this.mat)); return draw(); }
      const b = e.target.closest('[data-sfack]'); if (!b) return;
      b.disabled = true;
      try { const r = await api('adjust_ack', b.dataset.sfack === 'all' ? [] : [+b.dataset.sfack]); toast('รับทราบการแก้ยอดแล้ว', `${r.acked} รายการ`); await App.bumpRev(); this.render(el); }
      catch (er) { b.disabled = false; toastErr(er); }
    };
  },
};

/* ===== importx.js ===== */
/* =====================================================================
   IMPORT HISTORY FROM EXCEL (Officer · Settings)
   Reads a "Stock RM" workbook in the browser (SheetJS), shows what is inside per month,
   then back-fills the chosen months: เติมเฉพาะช่องที่ยังว่าง (default) or เขียนทับเดือนที่เลือก.
   Sheet layout = the original A3 monthly sheet: A2 "SEP 2026", blocks every 37 rows from row 2,
   6 materials per block at columns B H N T Z AF (รับสินค้า · ทั้งหมด · ใช้ไป · คงเหลือ · OPS).
   Only typed values are taken — formulas (ทั้งหมด / คงเหลือ / OPS links) are recalculated by the system.
   ===================================================================== */
'use strict';

const HistImport = {
  LIB: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  MON: { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 },
  COLS: [2, 8, 14, 20, 26, 32],
  UNIT: { liter: 'L', litre: 'L', l: 'L', pails: 'Pail', pail: 'Pail', drums: 'Drum', drum: 'Drum', rolls: 'Roll', roll: 'Roll', box: 'Box', boxes: 'Box' },
  parsed: null, pick: new Set(), mode: 'fill', create: true,

  lib() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return this._lib || (this._lib = new Promise((ok, bad) => {
      const s = document.createElement('script'); s.src = this.LIB;
      s.onload = () => window.XLSX ? ok(window.XLSX) : bad(new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ'));
      s.onerror = () => { this._lib = null; bad(new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ต')); };
      document.head.appendChild(s);
    }));
  },
  canon(n) { const s = String(n || '').replace(/\s+/g, ' ').trim(); return /^SRR-104/i.test(s) ? 'SRR-104' : s; },
  key(n) { return this.canon(n).toLowerCase().replace(/[^0-9a-zก-๙]/g, ''); },
  qty(text) {
    const m = String(text || '').match(/:\s*([\d,.]+)\s*([A-Za-z]+)?/); if (!m) return [null, '', false];
    const u = (m[2] || '').toLowerCase();
    return [parseFloat(m[1].replace(/,/g, '')), this.UNIT[u] || m[2] || '', /MOQ/i.test(String(text))];
  },
  /** workbook → [{month, sheet, materials:[…], ops:{day:name}}] */
  parse(XLSX, wb) {
    const out = [];
    wb.SheetNames.forEach(sn => {
      const ws = wb.Sheets[sn];
      const cell = (r, c) => ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
      const num = x => (x && x.t === 'n' && !x.f && isFinite(x.v)) ? +x.v : null;
      const str = x => (x && !x.f && x.v !== undefined && x.v !== null && typeof x.v === 'string' && x.v.trim() && !x.v.startsWith('=')) ? x.v.trim() : null;
      const a2 = String(cell(2, 1)?.v ?? '').trim().toUpperCase().match(/^([A-Z]{3})\s+(\d{4})/);
      if (!a2 || !this.MON[a2[1]]) return;
      const month = `${a2[2]}-${String(this.MON[a2[1]]).padStart(2, '0')}`, nd = new Date(+a2[2], this.MON[a2[1]], 0).getDate();
      const mats = [], ops = {};
      for (let b = 0; b < 12; b++) {
        const h = 2 + b * 37; let any = false;
        this.COLS.forEach(c => {
          const name = cell(h, c)?.v; if (name === undefined || name === null || !String(name).trim()) return;
          any = true;
          const [rp, u1] = this.qty(cell(h + 1, c)?.v), [oq, u2, moq] = this.qty(cell(h + 2, c)?.v);
          const days = {};
          for (let d = 1; d <= nd; d++) {
            const r = h + 3 + d, rcv = num(cell(r, c)), used = num(cell(r, c + 2));
            if (rcv !== null || used !== null) days[d] = [rcv, used];
            const o = str(cell(r, c + 4)); if (o && !ops[d]) ops[d] = o;
          }
          mats.push({ name: this.canon(name), raw: String(name).trim(), reorder_point: rp || 0, order_qty: oq || 0, unit: u1 || u2 || '', moq: moq ? oq : null, opening: num(cell(h + 4, c + 1)), days });
        });
        if (!any && b > 0) break;
      }
      if (mats.length) out.push({ month, sheet: sn, materials: mats, ops });
    });
    return out.sort((a, b) => a.month.localeCompare(b.month));
  },

  /** Excel vs what the system already has, per month: new cells / different / same */
  async compare(months) {
    const sys = await Promise.all(months.map(m => api('month_get', m.month).catch(() => null)));
    const D = {};
    months.forEach((m, i) => {
      const g = sys[i], idx = {};
      (g?.materials || []).forEach(x => { idx[this.key(x.name)] = x; });
      const out = { add: 0, diff: 0, same: 0, rows: [] };
      const eq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
      // same material twice in the sheet (SRR-104 tank 1 + 2) → summed, exactly like the import does
      const add = (a, b) => a == null ? b : b == null ? a : a + b, agg = new Map();
      m.materials.forEach(x => {
        const k = this.key(x.name), g = agg.get(k);
        if (!g) return agg.set(k, { name: x.name, opening: x.opening, days: Object.fromEntries(Object.entries(x.days).map(([d, v]) => [d, v.slice()])) });
        g.opening = add(g.opening, x.opening);
        Object.entries(x.days).forEach(([d, [r, u]]) => { const c = g.days[d] || (g.days[d] = [null, null]); c[0] = add(c[0], r); c[1] = add(c[1], u); });
      });
      agg.forEach(x => {
        const sm = idx[this.key(x.name)];
        if (x.opening != null && sm && sm.opening_explicit && !eq(x.opening, sm.opening)) { out.diff++; out.rows.push({ name: x.name, day: 0, sys: [null, sm.opening], xl: [null, x.opening], kind: 'diff' }); }
        Object.entries(x.days).forEach(([d, [r, u]]) => {
          const sd = sm?.days?.[d - 1] || {}, sr = sd.rcv ?? null, su = sd.used ?? null;
          if (sr == null && su == null) { out.add++; out.rows.push({ name: x.name, day: +d, sys: [null, null], xl: [r, u], kind: 'add' }); }
          else if (eq(sr, r) && eq(su, u)) out.same++;
          else { out.diff++; out.rows.push({ name: x.name, day: +d, sys: [sr, su], xl: [r, u], kind: 'diff' }); }
        });
      });
      D[m.month] = out;
    });
    return D;
  },
  detail(month) {
    const c = this.parsed.diff?.[month]; if (!c) return '';
    const v = n => n == null ? '<span class="faint">—</span>' : fmtN(n);
    const rows = c.rows.slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'diff' ? -1 : 1) || a.day - b.day);
    const fate = r => r.kind === 'add' ? '<span class="hx-k add">เพิ่มใหม่</span>' : this.mode === 'overwrite' ? '<span class="hx-k ovr">ใช้ค่า Excel</span>' : '<span class="hx-k keep">คงค่าระบบ</span>';
    return `<div class="hx-det"><div class="hx-det-h"><b>${fmtMonth(month)} · รายละเอียดความต่าง</b><span class="grow"></span><button class="link" data-hdet="">ปิด</button></div>
      ${rows.length ? `<div class="hx-tbl"><div class="hx-tr hx-th"><span>วันที่</span><span>Material</span><span class="r">ระบบ รับ / ใช้</span><span class="r">Excel รับ / ใช้</span><span>ผลเมื่อนำเข้า</span></div>
        ${rows.slice(0, 400).map(r => `<div class="hx-tr ${r.kind}"><span class="num">${r.day ? r.day : 'ยกมา'}</span><span>${esc(r.name)}</span>
          <span class="r num">${r.day ? `${v(r.sys[0])} / ${v(r.sys[1])}` : v(r.sys[1])}</span><span class="r num"><b>${r.day ? `${v(r.xl[0])} / ${v(r.xl[1])}` : v(r.xl[1])}</b></span><span>${fate(r)}</span></div>`).join('')}
        ${rows.length > 400 ? `<div class="hint" style="padding:8px">… และอีก ${rows.length - 400} รายการ</div>` : ''}</div>`
        : `<div class="hint" style="padding:12px 4px">${ic('check', 'sm')} ข้อมูลใน Excel ตรงกับในระบบทั้งหมด (${c.same} ช่อง)</div>`}</div>`;
  },

  /** comparison → .xlsx (สรุปรายเดือน + รายละเอียดทุกช่องที่ต่าง/เพิ่มใหม่) */
  exportDiff() {
    const XLSX = window.XLSX, P = this.parsed; if (!XLSX || !P?.diff) return;
    const months = P.months.filter(m => this.pick.has(m.month)).length ? P.months.filter(m => this.pick.has(m.month)) : P.months;
    const modeTh = this.mode === 'overwrite' ? 'เขียนทับเดือนที่เลือก' : 'เติมเฉพาะช่องที่ยังว่าง';
    const sum = [['เดือน', 'ชีต', 'เพิ่มใหม่ (ช่อง)', 'ต่างจากระบบ (ช่อง)', 'ตรงกัน (ช่อง)', 'มีข้อมูลในระบบแล้ว']];
    const det = [['เดือน', 'วันที่', 'Material', 'ระบบ · รับ', 'ระบบ · ใช้ไป', 'Excel · รับ', 'Excel · ใช้ไป', 'ประเภท', `ผลเมื่อนำเข้า (${modeTh})`]];
    months.forEach(m => {
      const c = P.diff[m.month] || { add: 0, diff: 0, same: 0, rows: [] };
      sum.push([fmtMonth(m.month), m.sheet, c.add, c.diff, c.same, P.have.has(m.month) ? 'ใช่' : 'ไม่']);
      c.rows.slice().sort((a, b) => a.day - b.day || a.name.localeCompare(b.name)).forEach(r => det.push([
        fmtMonth(m.month), r.day ? r.day : 'ยอดยกมา', r.name,
        r.day ? r.sys[0] : null, r.sys[1], r.day ? r.xl[0] : null, r.xl[1],
        r.kind === 'add' ? 'เพิ่มใหม่' : 'ต่างจากระบบ',
        r.kind === 'add' ? 'เพิ่มค่าจาก Excel' : this.mode === 'overwrite' ? 'ใช้ค่า Excel แทน' : 'คงค่าในระบบ']));
    });
    const wb = XLSX.utils.book_new(), w1 = XLSX.utils.aoa_to_sheet(sum), w2 = XLSX.utils.aoa_to_sheet(det);
    w1['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 18 }];
    w2['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 30 }];
    w2['!autofilter'] = { ref: `A1:I${det.length}` };
    XLSX.utils.book_append_sheet(wb, w1, 'สรุป'); XLSX.utils.book_append_sheet(wb, w2, 'รายละเอียด');
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const name = `เทียบข้อมูล_Excel_กับระบบ_${App.today}.xlsx`;
    downloadB64(b64, name, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast('ดาวน์โหลดผลเทียบแล้ว', `${name} · ${det.length - 1} รายการ`);
  },

  card() {
    if (!App.officer) return '';
    return `<section class="card hx-card" style="grid-column:1/-1"><div class="card-h">${tile('upload', 'var(--primary)', 'sm')}<div class="title">${bi('นำเข้าข้อมูลย้อนหลังจาก Excel', 'IMPORT HISTORY · STOCK RM .xlsx')}</div></div>
      <p class="hint" style="margin:0 0 12px">เลือกไฟล์ Excel แบบเดิม (ชีตละเดือน เช่น Jan, Feb …) ระบบจะอ่านเฉพาะตัวเลขที่พิมพ์ไว้ (รับสินค้า · ใช้ไป · ยอดยกมา · OPS) — ทั้งหมด/คงเหลือ คำนวณใหม่เอง · SRR-104 ทั้ง 2 ถังรวมเป็นรายการเดียว</p>
      <div class="hx-pick"><label class="btn btn-tonal">${ic('folder', 'sm')}เลือกไฟล์ Excel…<input type="file" id="hx-file" accept=".xlsx,.xlsm,.xls" hidden></label><span class="hint" id="hx-fn">ยังไม่ได้เลือกไฟล์</span></div>
      <div id="hx-body"></div></section>`;
  },
  cmpChips(month, has) {
    const c = this.parsed.diff?.[month];
    if (!c) return has ? '<span class="badge sched"><span class="dot"></span>มีข้อมูลในระบบแล้ว</span>' : '<span class="badge ok"><span class="dot"></span>ยังไม่มีในระบบ</span>';
    const chip = (n, cls, t) => n ? `<span class="hx-c ${cls}">${t} <b class="num">${n}</b></span>` : '';
    return `${chip(c.add, 'add', 'เพิ่มใหม่')}${chip(c.diff, 'diff', 'ต่างจากระบบ')}${chip(c.same, 'same', 'ตรงกัน')}
      ${c.add || c.diff ? `<button class="link" data-hdet="${month}">ดูรายละเอียด</button>` : ''}`;
  },
  body() {
    const P = this.parsed; if (!P) return '';
    if (!P.months.length) return `<div class="warn-banner" style="margin-top:12px">${ic('alert')}ไม่พบชีตรายเดือนในไฟล์นี้ (ช่อง A2 ต้องเป็นเดือน เช่น “SEP 2026”)</div>`;
    const known = new Set((P.mats || []).map(m => this.key(m.name)));
    const unknown = [...new Set(P.months.flatMap(m => m.materials.map(x => x.name)))].filter(n => !known.has(this.key(n)));
    const rows = P.months.map(m => {
      const days = new Set(); m.materials.forEach(x => Object.keys(x.days).forEach(d => days.add(d)));
      const n = m.materials.reduce((s, x) => s + Object.keys(x.days).length, 0), has = P.have.has(m.month);
      return `<label class="hx-row ${this.pick.has(m.month) ? 'on' : ''}"><input type="checkbox" data-hm="${m.month}" ${this.pick.has(m.month) ? 'checked' : ''}>
        <b>${fmtMonth(m.month)}</b><span class="muted">ชีต “${esc(m.sheet)}”</span><span>${m.materials.length} Material</span><span>${days.size} วันที่มีข้อมูล · ${n} บันทึก</span>
        <span class="hx-cmp">${this.cmpChips(m.month, has)}</span></label>`;
    }).join('');
    return `<div class="hx-sum"><div class="flabel">พบ ${P.months.length} เดือน <span class="en">เลือกเดือนที่จะนำเข้า</span><span class="grow"></span><button class="link" data-hall>เลือกทั้งหมด</button><button class="link" data-hnone>ไม่เลือก</button></div>
        <div class="hx-list">${rows}</div>${this.det ? this.detail(this.det) : ''}</div>
      <div class="hx-opt"><div class="flabel">วิธีนำเข้า</div>
        <div class="seg" id="hx-mode"><button data-hmode="fill" class="${this.mode === 'fill' ? 'on' : ''}">เติมเฉพาะช่องที่ยังว่าง (แนะนำ)</button><button data-hmode="overwrite" class="${this.mode === 'overwrite' ? 'on' : ''}">เขียนทับเดือนที่เลือก</button></div>
        <p class="hint">${this.mode === 'fill' ? 'วันที่บันทึกไว้แล้วในระบบจะไม่ถูกแก้ — เติมเฉพาะวันที่/ยอดยกมาที่ยังว่าง' : '<b style="color:var(--leak)">ข้อมูลรับ/ใช้ไปของเดือนที่เลือกในระบบจะถูกแทนด้วยค่าจาก Excel</b> — ระบบสำรองข้อมูลให้อัตโนมัติทุกวัน'}</p>
        ${unknown.length ? `<label class="hx-new"><input type="checkbox" id="hx-create" ${this.create ? 'checked' : ''}> สร้าง Material ใหม่ ${unknown.length} รายการที่ยังไม่มีในระบบ: <b>${unknown.map(esc).join(', ')}</b></label>` : ''}</div>
      <div class="hx-go">${P.diff ? `<button class="btn btn-ghost" data-hxp>${ic('download', 'sm')}Export ผลเทียบ (.xlsx)</button><span class="grow"></span>` : ''}<span class="hint">${this.pick.size} เดือนที่เลือก</span><button class="btn btn-primary" data-hgo ${this.pick.size ? '' : 'disabled'}>${ic('upload', 'sm')}นำเข้า ${this.pick.size} เดือน</button></div>
      <div id="hx-res"></div>`;
  },
  bind(el) {
    const box = el.querySelector('.hx-card'); if (!box) return;
    const draw = () => { box.querySelector('#hx-body').innerHTML = this.body(); };
    box.querySelector('#hx-file').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      box.querySelector('#hx-fn').textContent = f.name;
      box.querySelector('#hx-body').innerHTML = `<div class="loading" style="padding:18px"><span class="spin"></span>กำลังอ่านไฟล์…</div>`;
      try {
        const [XLSX, buf, mats, rng] = await Promise.all([this.lib(), f.arrayBuffer(), api('materials_list'), api('export_range')]);
        const wb = XLSX.read(buf, { type: 'array', cellFormula: true });
        const months = this.parse(XLSX, wb);
        this.parsed = { months, mats, have: new Set(rng.data_months || []), file: f.name };
        this.det = null; if (months.length) this.parsed.diff = await this.compare(months);
        this.pick = new Set(months.filter(m => !this.parsed.have.has(m.month)).map(m => m.month));
        if (!this.pick.size) this.pick = new Set(months.map(m => m.month));
        draw();
      } catch (er) { box.querySelector('#hx-body').innerHTML = `<div class="warn-banner" style="margin-top:12px">${ic('alert')}${esc(er.message)}</div>`; }
    };
    box.addEventListener('change', e => {
      const c = e.target.closest('[data-hm]'); if (c) { c.checked ? this.pick.add(c.dataset.hm) : this.pick.delete(c.dataset.hm); draw(); }
      if (e.target.id === 'hx-create') this.create = e.target.checked;
    });
    box.addEventListener('click', async e => {
      const t = e.target;
      if (t.closest('[data-hall]')) { this.pick = new Set(this.parsed.months.map(m => m.month)); return draw(); }
      if (t.closest('[data-hnone]')) { this.pick.clear(); return draw(); }
      const dt = t.closest('[data-hdet]'); if (dt) { e.preventDefault(); this.det = dt.dataset.hdet || null; draw(); if (this.det) box.querySelector('.hx-det')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
      if (t.closest('[data-hxp]')) { try { this.exportDiff(); } catch (er) { toastErr(er); } return; }
      const md = t.closest('[data-hmode]'); if (md) { this.mode = md.dataset.hmode; return draw(); }
      const go = t.closest('[data-hgo]'); if (!go) return;
      const months = this.parsed.months.filter(m => this.pick.has(m.month));
      if (this.mode === 'overwrite') {
        const ok = await modal({ title: `เขียนทับ ${months.length} เดือน?`, en: 'OVERWRITE', danger: true, body: `<p class="muted">${months.map(m => fmtMonth(m.month)).join(', ')} — ข้อมูลรับ/ใช้ไปในระบบของเดือนเหล่านี้จะถูกแทนด้วยค่าจาก Excel</p>`, ok: 'เขียนทับ', okEn: 'Overwrite' });
        if (!ok) return;
      }
      go.disabled = true; go.innerHTML = `<span class="spin"></span>กำลังนำเข้า…`;
      try {
        const r = await api('import_history', months.map(({ month, materials, ops }) => ({ month, materials, ops })), this.mode, this.create);
        box.querySelector('#hx-res').innerHTML = `<div class="locked-banner" style="margin-top:12px">${ic('check')}<div>นำเข้าแล้ว ${r.months} เดือน · ${r.rows} บันทึก · ยอดยกมา ${r.openings} · OPS ${r.ops} วัน
          ${r.skipped_rows ? `<br><span class="hint">ข้าม ${r.skipped_rows} ช่องที่มีข้อมูลในระบบอยู่แล้ว</span>` : ''}${r.created.length ? `<br><span class="hint">สร้าง Material ใหม่: ${r.created.map(esc).join(', ')}</span>` : ''}${r.unknown.length ? `<br><span class="hint">ไม่ได้นำเข้า (ไม่มีใน Master): ${r.unknown.map(esc).join(', ')}</span>` : ''}</div></div>`;
        toast('นำเข้าข้อมูลย้อนหลังแล้ว', `${r.months} เดือน · ${r.rows} บันทึก`);
        go.innerHTML = `${ic('check', 'sm')}นำเข้าแล้ว`;
        await App.bumpRev();
        this.parsed.diff = await this.compare(this.parsed.months); this.parsed.have = new Set([...this.parsed.have, ...months.map(m => m.month)]);
        const res = box.querySelector('#hx-res').innerHTML; draw(); box.querySelector('#hx-res').innerHTML = res;
      } catch (er) { toastErr(er); go.disabled = false; go.innerHTML = `${ic('upload', 'sm')}ลองอีกครั้ง`; }
    });
  },
};

/* =====================================================================
   RESET FOR GO-LIVE (Officer · Settings) — empty every record, keep the set-up
   ===================================================================== */
const ResetUI = {
  card() {
    if (!App.officer) return '';
    return `<section class="card rs-card" style="grid-column:1/-1"><div class="card-h">${tile('alert', 'var(--leak)', 'sm')}<div class="title">${bi('เริ่มใช้งานจริง · ล้างข้อมูลทั้งหมด', 'RESET FOR GO-LIVE')}</div></div>
      <div class="rs-grid">
        <div class="rs-col del"><b>${ic('x', 'sm')}ถูกล้าง</b><span>บันทึก STOCK รายวัน · ยอดยกมา · ใบสั่งซื้อ / คำขอ · เอกสาร A3 · ประกาศ · คำขออุปกรณ์ · ประวัติแก้ยอด · ประวัติการใช้งาน</span></div>
        <div class="rs-col keep"><b>${ic('check', 'sm')}เก็บไว้</b><span>Material Master · รายการสินค้า HRM Shopping · รายชื่อทีม & Emoji · รหัส Officer · การตั้งค่า</span></div>
      </div>
      <div class="rs-opts"><label class="rs-chk"><input type="checkbox" id="rs-mat"> ลบ Material Master ด้วย <span class="hint">(เริ่มจากศูนย์ แล้วนำเข้าจาก Excel ใหม่)</span></label>
        <label class="rs-date">เริ่มนับวันบันทึกตั้งแต่ <input class="input" type="date" id="rs-start" value="${App.today}"></label>
        <span class="grow"></span><button class="btn btn-plain" data-opening>${ic('stock', 'sm')}ใส่ยอดยกมาทุก Material</button><button class="btn btn-danger" data-reset>${ic('alert', 'sm')}ล้างข้อมูลทั้งหมด…</button></div>
      <p class="hint" style="margin:8px 0 0">${IS_GAS ? 'ระบบจะคัดลอกไฟล์ Google Sheets ทั้งไฟล์เก็บไว้ใน Google Drive ก่อนล้าง' : 'ระบบจะสำรองฐานข้อมูลไว้ในโฟลเดอร์ backup ก่อนล้าง'} — กู้คืนได้ถ้ากดผิด</p>
      <div id="rs-res"></div></section>`;
  },
  bind(el) {
    const box = el.querySelector('.rs-card'); if (!box) return;
    box.addEventListener('click', e => { const o = e.target.closest('[data-opening]'); if (o) OpeningUI.open(o.dataset.opening || undefined); });
    box.querySelector('[data-reset]').onclick = async () => {
      const keep = !box.querySelector('#rs-mat').checked, start = box.querySelector('#rs-start').value || App.today;
      const r = await modal({
        title: 'ล้างข้อมูลทั้งหมด?', en: 'RESET ALL RECORDS', danger: true, ok: 'ล้างข้อมูล', okEn: 'Reset',
        body: `<p class="muted" style="margin-top:0">ข้อมูลการบันทึกทั้งหมดจะถูกล้าง${keep ? '' : ' <b style="color:var(--leak)">รวมถึง Material Master</b>'} · เริ่มนับใหม่ตั้งแต่ <b>${fmtD(start)}</b><br>ระบบสำรองข้อมูลเดิมไว้ให้อัตโนมัติ</p>
          <div class="frow"><div class="field"><label>พิมพ์ <b>RESET</b> เพื่อยืนยัน</label><input class="input" id="rs-c" autocomplete="off" placeholder="RESET"></div>
          <div class="field"><label>รหัส Officer</label><input class="input" type="password" id="rs-p" inputmode="numeric"></div></div>
          <div class="err-text" style="margin-top:8px"></div>`,
        onOk: async m => api('data_reset', m.querySelector('#rs-p').value, m.querySelector('#rs-c').value, keep, start),
      });
      if (!r) return;
      const n = Object.values(r.cleared).reduce((a, b) => a + b, 0);
      box.querySelector('#rs-res').innerHTML = `<div class="locked-banner" style="margin-top:12px">${ic('check')}<div>ล้างข้อมูลแล้ว ${fmtN(n)} แถว · พร้อมใช้งานจริงตั้งแต่ ${fmtD(r.tracking_start)}<br>
        <span class="hint">สำรองไว้ที่ ${esc(r.backup)}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">เปิดใน Google Drive</a>` : ''}</span>
        <div style="margin-top:8px"><button class="btn btn-primary sm" data-opening="${r.tracking_start.slice(0, 7)}">${ic('stock', 'sm')}ขั้นต่อไป: ใส่ยอดยกมา ${fmtMonth(r.tracking_start.slice(0, 7))}</button></div></div></div>`;
      App.info.tracking_start = r.tracking_start;
      toast('ล้างข้อมูลแล้ว — พร้อมใช้งานจริง', `สำรองไว้ที่ ${esc(r.backup)}`);
      await App.bumpRev();
    };
  },
};

/* =====================================================================
   OPENING BALANCES — every Material on one screen (after a reset / at go-live)
   ===================================================================== */
const OpeningUI = {
  async open(month) {
    if (!App.officer) return toast('เฉพาะ Officer', 'เปลี่ยนโหมดได้ที่หน้า ตั้งค่า', 'warn');
    month = month || String(App.info?.tracking_start || App.today).slice(0, 7);
    const mg = await api('month_get', month);
    const mats = mg.materials;
    const T = App.today, lastDay = T.slice(0, 7) === month ? +T.slice(8, 10) : (T.slice(0, 7) > month ? mg.days : 0);
    // movements this month up to today → shows what the balance becomes with the typed opening
    const mov = m => m.days.slice(0, lastDay).reduce((t, d) => t + (d.rcv || 0) - (d.used || 0), 0);
    const orig = {}; mats.forEach(m => { orig[m.id] = m.opening_explicit ? m.opening : null; });
    const row = (m, i) => `<div class="op-row" data-id="${m.id}"><span class="faint num">${i + 1}</span>
        <div class="op-n"><b>${esc(m.name)}</b><span>${esc(m.code || '')}${m.opening_explicit ? '' : ` · ตอนนี้คำนวณจากเดือนก่อน ${fmtN(m.opening)}`}</span></div>
        <label class="op-in"><input class="input num" inputmode="decimal" data-op="${m.id}" value="${orig[m.id] ?? ''}" placeholder="${m.opening_explicit ? '' : fmtN(m.opening)}"><span>${esc(m.unit)}</span></label>
        <div class="op-now"><span>คงเหลือวันนี้</span><b class="num" data-now="${m.id}">${fmtN((orig[m.id] ?? m.opening) + mov(m))}</b></div></div>`;
    const mv = n => { const d = pd(month + '-01'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
    openPanel({
      title: 'ใส่ยอดยกมา ทุก Material', en: `OPENING BALANCES · ${fmtMonthEn(month)}`, icon: 'stock', wide: true,
      body: `<div class="op-top"><div class="datebox"><button class="icon-btn" data-opm="${mv(-1)}">${ic('chevL')}</button><div class="dlabel"><div class="d">${fmtMonth(month)}</div><div class="s">ยอด ณ วันที่ 1 ของเดือน</div></div><button class="icon-btn" data-opm="${mv(1)}">${ic('chevR')}</button></div>
          <p class="hint">ใส่ยอดที่นับได้จริงตอนต้นเดือน — ช่องว่าง = ใช้ยอดที่คำนวณต่อจากเดือนก่อน · <kbd>Enter</kbd> ไปช่องถัดไป</p></div>
        <div class="op-list">${mats.map(row).join('')}</div>`,
      foot: `<span class="hint" id="op-cnt" style="margin-right:auto"></span><button class="btn btn-plain" data-opclose>ยกเลิก</button><button class="btn btn-primary lg" data-opsave>${ic('check')}${bi('บันทึกยอดยกมา', 'Save')}</button>`,
      onMount: (p, close) => {
        const cnt = () => { const ch = $$('[data-op]', p).filter(i => (parseNum(i.value) ?? null) !== orig[+i.dataset.op]).length; p.querySelector('#op-cnt').textContent = ch ? `แก้ไข ${ch} รายการ` : 'ยังไม่มีการแก้ไข'; return ch; };
        cnt();
        p.querySelector('.op-list').addEventListener('input', e => {
          const i = e.target.closest('[data-op]'); if (!i) return;
          i.value = i.value.replace(/[^\d.,]/g, '');
          const m = mats.find(x => x.id === +i.dataset.op), v = parseNum(i.value);
          p.querySelector(`[data-now="${m.id}"]`).textContent = fmtN((v ?? (m.opening_explicit ? null : m.opening) ?? 0) + mov(m));
          i.closest('.op-row').classList.toggle('dirty', (v ?? null) !== orig[m.id]); cnt();
        });
        p.querySelector('.op-list').addEventListener('keydown', e => {
          if (e.key !== 'Enter' || !e.target.matches('[data-op]')) return;
          e.preventDefault(); const all = $$('[data-op]', p), k = all.indexOf(e.target); (all[k + 1] || p.querySelector('[data-opsave]')).focus();
        });
        p.querySelector('.op-list').addEventListener('focusin', e => e.target.select?.());
        p.querySelector('[data-opclose]').onclick = close;
        p.querySelectorAll('[data-opm]').forEach(b => b.onclick = () => { if (cnt() && !confirm('ยังไม่ได้บันทึก — เปลี่ยนเดือนเลยไหม?')) return; close(); this.open(b.dataset.opm); });
        p.querySelector('[data-opsave]').onclick = async ev => {
          const items = $$('[data-op]', p).filter(i => (parseNum(i.value) ?? null) !== orig[+i.dataset.op]).map(i => ({ id: +i.dataset.op, qty: i.value }));
          if (!items.length) return toast('ไม่มีการเปลี่ยนแปลง', '', 'info');
          const b = ev.currentTarget; b.disabled = true;
          try { const r = await api('opening_bulk', month, items); close(); toast('บันทึกยอดยกมาแล้ว', `${fmtMonth(month)} · ${r.saved} รายการ`); await App.bumpRev(); App.refresh(); }
          catch (er) { b.disabled = false; toastErr(er); }
        };
        setTimeout(() => p.querySelector('[data-op]')?.focus(), 80);
      },
    });
  },
};

/* =====================================================================
   BACKUP & RESTORE (Officer · Settings)
   ===================================================================== */
const BackupUI = {
  KIND: { daily: ['สำรองรายวัน', 'sched'], reset: ['ก่อนล้างข้อมูล', 'ordered'], restore: ['ก่อนกู้คืน', 'neutral'] },
  card() {
    if (!App.officer) return '';
    return `<section class="card bk-card" style="grid-column:1/-1"><div class="card-h">${tile('db', 'var(--primary)', 'sm')}<div class="title">${bi('สำรอง & กู้คืนข้อมูล', 'BACKUP · RESTORE')}</div><span class="grow"></span>
        <button class="btn btn-plain sm" data-bknow>${ic('db', 'sm')}สำรองตอนนี้</button></div>
      <div class="bk-auto" id="bk-auto"></div>
      <div class="bk-grid"><div><div class="flabel">ไฟล์สำรองข้อมูลทั้งระบบ <span class="en">ล่าสุด 60 ไฟล์ · สำรองอัตโนมัติวันละครั้ง</span></div><div id="bk-list"><div class="loading" style="padding:14px"><span class="spin"></span>กำลังโหลด…</div></div></div>
        <div class="bk-shop"><div class="flabel">กู้คืนคำขอสั่งซื้ออุปกรณ์ <span class="en">จากไฟล์ Backup Excel (หน้า ประวัติคำขอ)</span></div>
          <label class="btn btn-tonal">${ic('folder', 'sm')}เลือกไฟล์ Backup Excel…<input type="file" id="bk-file" accept=".xlsx" hidden></label>
          <div id="bk-shop"></div></div></div></section>`;
  },
  async list(box) {
    const el = box.querySelector('#bk-list');
    try {
      const L = await api('backup_list');
      el.innerHTML = L.length ? `<div class="bk-list">${L.map(f => { const k = this.KIND[f.kind] || this.KIND.daily; return `<div class="bk-row">
          <div class="bk-n"><b>${fmtD(f.at)} · ${fmtTime(f.at)}</b><span>${esc(f.name)}${f.size ? ` · ${fmtN(Math.round(f.size / 1024))} KB` : ''}</span></div>
          <span class="badge ${k[1]}"><span class="dot"></span>${k[0]}</span>
          ${f.restorable ? `<button class="btn btn-plain sm" data-bkr="${esc(f.id)}" data-bkn="${esc(f.name)}" data-bka="${esc(f.at)}">${ic('refresh', 'sm')}กู้คืน</button>` : `<span class="hint" title="ไฟล์ .xlsx กู้คืนในแอปไม่ได้">.xlsx</span>`}
          ${f.url ? `<a class="link" href="${esc(f.url)}" target="_blank" rel="noopener">Drive</a>` : ''}</div>`; }).join('')}</div>`
        : `<div class="hint" style="padding:10px 0">ยังไม่มีไฟล์สำรอง — กด “สำรองตอนนี้”</div>`;
    } catch (er) { el.innerHTML = `<div class="err-text">${esc(er.message)}</div>`; }
  },
  /** nightly backup — Google edition: a time-driven trigger, runs even when nobody opens the app */
  async auto(box) {
    const el = box.querySelector('#bk-auto');
    let s; try { s = await api('backup_schedule_get'); } catch (er) { el.innerHTML = ''; return; }
    if (s.desktop) { el.innerHTML = `<div class="bk-a">${ic('clock', 'sm')}<span><b>สำรองอัตโนมัติ</b> — เวอร์ชันเดสก์ท็อปสำรองให้เองเมื่อเปิดโปรแกรมครั้งแรกของแต่ละวัน</span></div>`; return; }
    const hrs = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00 น.</option>`).join('');
    el.innerHTML = `<div class="bk-a ${s.on ? 'on' : ''}"><label class="bk-sw"><span class="switch"><input type="checkbox" id="bk-on" ${s.on ? 'checked' : ''}><span></span></span><b>สำรองอัตโนมัติทุกคืน</b></label>
      <select class="input" id="bk-h">${hrs}</select>
      <span class="hint">${s.on ? `เปิดอยู่ — สำรองทุกวันเวลา ${String(s.hour).padStart(2, '0')}:00 น. แม้ไม่มีใครเปิดแอป${s.last ? ` · ครั้งล่าสุด ${fmtD(s.last)} ${fmtTime(s.last)}` : ' · ยังไม่ถึงรอบแรก'}` : 'ปิดอยู่ — สำรองเฉพาะตอนมีคนเปิดแอปครั้งแรกของวัน'}</span></div>`;
    const save = async () => {
      const on = el.querySelector('#bk-on').checked, h = +el.querySelector('#bk-h').value;
      try { await api('backup_schedule', on, h); toast(on ? 'ตั้งสำรองอัตโนมัติแล้ว' : 'ปิดสำรองอัตโนมัติแล้ว', on ? `ทุกคืน ${String(h).padStart(2, '0')}:00 น.` : ''); } catch (er) { toastErr(er); }
      this.auto(box);
    };
    el.querySelector('#bk-on').onchange = save;
    el.querySelector('#bk-h').onchange = () => { if (el.querySelector('#bk-on').checked) save(); };
  },
  bind(el) {
    const box = el.querySelector('.bk-card'); if (!box) return;
    this.list(box); this.auto(box);
    box.querySelector('[data-bknow]').onclick = async ev => {
      const b = ev.currentTarget; b.disabled = true;
      try { const r = await api('backup_now'); toast('สำรองข้อมูลแล้ว', esc(String(r.path).split(/[\\/]/).pop())); this.list(box); } catch (er) { toastErr(er); }
      b.disabled = false;
    };
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-bkr]');
      if (b) {
        const r = await modal({
          title: 'กู้คืนข้อมูลจากไฟล์สำรอง?', en: 'RESTORE BACKUP', danger: true, ok: 'กู้คืน', okEn: 'Restore',
          body: `<p class="muted" style="margin-top:0">ข้อมูลทั้งระบบจะกลับไปเป็นเหมือนวันที่ <b>${fmtD(b.dataset.bka)} ${fmtTime(b.dataset.bka)}</b><br>ระบบจะสำรองข้อมูลปัจจุบันไว้ก่อน (กู้กลับได้) · รหัส Officer คงเดิม</p>
            <div class="field"><label>รหัส Officer</label><input class="input" type="password" id="bk-p" inputmode="numeric"></div><div class="err-text" style="margin-top:8px"></div>`,
          onOk: async m => api('backup_restore', b.dataset.bkr, m.querySelector('#bk-p').value),
        });
        if (!r) return;
        toast('กู้คืนข้อมูลแล้ว', `จาก ${esc(r.restored)} · สำรองข้อมูลก่อนกู้คืนไว้ที่ ${esc(r.safety)}`);
        await App.bumpRev(); App.refresh(); return;
      }
      const go = e.target.closest('[data-bkgo]');
      if (go && this.reqs) {
        go.disabled = true;
        try { const r = await api('shop_restore', this.reqs); box.querySelector('#bk-shop').innerHTML = `<div class="locked-banner" style="margin-top:10px">${ic('check')}<div>กู้คืนคำขอแล้ว ${r.added} คำขอ${r.skipped ? ` · ข้าม ${r.skipped} (มีอยู่แล้ว / ข้อมูลไม่ครบ)` : ''}</div></div>`; this.reqs = null; await App.bumpRev(); }
        catch (er) { go.disabled = false; toastErr(er); }
      }
    });
    box.querySelector('#bk-file').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const out = box.querySelector('#bk-shop'); out.innerHTML = `<div class="loading" style="padding:12px"><span class="spin"></span>กำลังอ่านไฟล์…</div>`;
      try {
        const [XLSX, buf, have] = await Promise.all([HistImport.lib(), f.arrayBuffer(), api('shop_requests')]);
        const wb = XLSX.read(buf, { type: 'array' });
        const s1 = wb.Sheets['คำขอ'], s2 = wb.Sheets['รายการ'];
        if (!s1 || !s2) throw new Error('ไม่ใช่ไฟล์ Backup คำขออุปกรณ์ (ต้องมีชีต “คำขอ” และ “รายการ”)');
        const A = XLSX.utils.sheet_to_json(s1, { defval: '', raw: false }), B = XLSX.utils.sheet_to_json(s2, { defval: '', raw: false });
        const items = {}; B.forEach(r => { (items[r['เลขที่คำขอ']] = items[r['เลขที่คำขอ']] || []).push({ name: r['รายการ'], spec: r['สเปค / ขนาด / สี'], qty: r['จำนวน'], unit: r['หน่วย'] }); });
        this.reqs = A.filter(r => r['เลขที่คำขอ']).map(r => ({ id: String(r['เลขที่คำขอ']).trim(), created_at: `${r['วันที่']} ${r['เวลา'] || '00:00'}`.trim(), requester: r['ผู้ขอสั่งซื้อ'], status: r['สถานะ'],
          expected_date: r['กำหนดส่ง'], status_by: r['อัปเดตโดย'], status_at: r['อัปเดตเมื่อ'], note: r['หมายเหตุ'], items: items[r['เลขที่คำขอ']] || [] }));
        const ids = new Set(have.map(x => x.id)), fresh = this.reqs.filter(q => !ids.has(q.id)).length;
        out.innerHTML = `<div class="bk-pv"><b>${esc(f.name)}</b><span>${this.reqs.length} คำขอในไฟล์ · <b>${fresh}</b> คำขอยังไม่มีในระบบ · ${this.reqs.length - fresh} มีอยู่แล้ว (จะข้าม)</span>
          <button class="btn btn-primary sm" data-bkgo ${fresh ? '' : 'disabled'}>${ic('upload', 'sm')}กู้คืน ${fresh} คำขอ</button></div>`;
      } catch (er) { this.reqs = null; out.innerHTML = `<div class="err-text" style="margin-top:8px">${esc(er.message)}</div>`; }
    };
  },
};

/* ===== notify.js ===== */
/* =====================================================================
   OFFICER NOTIFICATIONS — two separate lanes
     • Material (stock orders): ถึงจุดสั่งซื้อ · เกินกำหนดส่ง · ส่งวันนี้ · ยังไม่มีกำหนดส่ง · รอยืนยันรับของ · Material รออนุมัติ
     • อุปกรณ์ (HRM Shopping): คำขอใหม่ → รับคำสั่ง → สั่งซื้อแล้ว (รอจัดส่ง) → จัดส่งสำเร็จ — one tap moves it on
   Shown as lanes on the Officer home, in the bell panel, and as notification toasts when something new arrives.
   ===================================================================== */
'use strict';

const Notif = {
  ago(s) {
    if (!s) return '';
    const t = new Date(String(s).replace(' ', 'T')), m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : `${Math.round(m / 1440)} วัน`;
  },

  build(d, ro = !App.officer) {
    const mat = [], shop = [];
    const open = (d.open_orders || []).slice().sort((a, b) => a.priority - b.priority || String(a.expected_date || '9').localeCompare(String(b.expected_date || '9')));
    const chip = (t, k) => `<span class="st-chip ${k}">${t}</span>`;
    // items at the reorder point have no order yet → a compact strip on top of the lane (key kept for the pop-up toasts)
    const need = (d.need_order || []).map(m => ({
      key: 'need:' + m.id, tone: 'need', icon: 'alert', id: m.id, name: m.name, title: `${m.name} ถึงจุดสั่งซื้อ`,
      sub: `คงเหลือ ${fmtN(m.balance)} / จุดสั่ง ${fmtN(m.reorder_point)} ${m.unit} · สั่งครั้งละ ${fmtN(m.order_qty)}`, bal: m.balance, unit: m.unit, rp: m.reorder_point, oq: m.order_qty,
    }));
    open.forEach(o => {
      if (o.status === 'requested') {   // asked for by an Operator — the Officer still has to place it
        mat.push({
          key: 'req:' + o.id, tone: 'new', icon: 'order', who: o.requested_by || null, at: o.created_at,
          title: `${o.material.name} · ขอสั่ง ${fmtN(o.ordered_qty)} ${o.material.unit}`,
          sub: `${o.id} · ขอโดย ${o.requested_by || '-'}${o.remark ? ' · ' + o.remark : ''}`,
          track: orderTrack(o, 'mini'), due: `<div class="due-c none"><b>—</b><span>รอ Officer สั่งซื้อ</span></div>`,
          cancel: '',
          acts: ro ? [['ดู', `data-oid="${esc(o.id)}"`, 'plain']] : [['สั่งซื้อ · ใส่วันที่', `data-oconfirm="${esc(o.id)}"`, 'primary'], ['ไม่อนุมัติ', `data-oreject="${esc(o.id)}"`, 'plain'], ['ดู', `data-oid="${esc(o.id)}"`, 'plain']],
        });
        return;
      }
      const k = o.status === 'overdue' ? 'ovd' : o.status === 'today' ? 'today' : o.status === 'waiting_date' ? 'wd' : 'sch';
      const tone = { ovd: 'over', today: 'today', wd: 'wait', sch: 'ship' }[k];
      mat.push({
        key: k + ':' + o.id, tone, icon: { ovd: 'clock', today: 'truck', wd: 'cal', sch: 'truck' }[k],
        title: `${o.material.name}${o.partial ? ' · รับแล้วบางส่วน' : ''}`,
        sub: `${o.id} · สั่ง ${fmtN(o.ordered_qty)} ${o.material.unit}${o.partial ? ` · ค้างรับ ${fmtN(o.remaining_qty)}` : ''} · ${fmtD(o.order_date)}${o.requested_by ? ` · ขอโดย ${o.requested_by}` : ''}`,
        track: orderTrack(o, 'mini'), due: dueCell(o.expected_date),
        cancel: ro ? '' : `data-ocancel="${esc(o.id)}"`, who: null,
        acts: ro ? [['ดู', `data-oid="${esc(o.id)}"`, 'plain']] : [[o.status === 'waiting_date' ? 'ใส่วันส่ง' : 'ดูใบสั่งซื้อ', `data-oid="${esc(o.id)}"`, o.status === 'waiting_date' ? 'primary' : 'plain']],
      });
    });
    // finished orders (received / delivered) leave the lanes — they stay in the Orders page and request history
    const p = d.pending || {};
    if (!ro && p.receipts) mat.push({ key: 'rcv:' + p.receipts, tone: 'today', icon: 'inbox', title: `รอยืนยันรับของ ${p.receipts} รายการ`, sub: 'Operator บันทึกรับสินค้าแล้ว — ตรวจและยืนยัน', track: chip('รอ Officer ยืนยัน', 'wait'), due: '', acts: [['ไปยืนยัน', 'data-go="delivery"', 'plain']] });
    if (!ro && p.materials) mat.push({ key: 'mat:' + p.materials, tone: 'wait', icon: 'master', title: `Material ใหม่รออนุมัติ ${p.materials} รายการ`, sub: 'คำขอเพิ่ม Material จากหน้างาน', track: chip('รออนุมัติ', 'wait'), due: '', acts: [['ไปอนุมัติ', 'data-go="master"', 'plain']] });

    const NEXT = { saved: ['acknowledged', 'รับคำสั่ง'], acknowledged: ['ordered', 'สั่งซื้อแล้ว · รอจัดส่ง'], ordered: ['delivered', 'จัดส่งสำเร็จ'] };
    const reqs = (d.shop_open || []).filter(r => r.status !== 'delivered' && r.status !== 'cancelled');
    reqs.forEach(r => {
      const items = r.items || [], nx = NEXT[r.status];
      const acts = [];
      if (nx && !ro) acts.push([nx[1], `data-sst="${esc(r.id)}|${nx[0]}"`, 'primary']);
      if (!ro && (r.status === 'acknowledged' || r.status === 'ordered')) acts.push([r.expected_date ? 'แก้วันส่ง' : 'ใส่วันส่ง', `data-sdate="${esc(r.id)}"`, 'plain']);
      acts.push(['ดู', `data-sreq="${esc(r.id)}"`, 'plain']);
      shop.push({
        key: 'sr:' + r.id + ':' + r.status, tone: r.status === 'saved' ? 'new' : r.status === 'delivered' ? 'done' : r.status === 'acknowledged' ? 'ack' : 'ship',
        who: r.requester, at: r.created_at,
        // the items are what matters — they lead; the requester is a coloured pill underneath
        title: items.slice(0, 2).map(x => `${itemText(x)} ×${fmtQty(x.qty)}`).join(' · ') + (items.length > 2 ? ` · +${items.length - 2}` : ''),
        titleHtml: items.slice(0, 2).map(x => `${esc(x.name)}${x.spec ? ` <small>(${esc(x.spec)})</small>` : ''} <span class="q">×${fmtQty(x.qty)}</span>`).join('<i class="sep">·</i>') + (items.length > 2 ? `<span class="more">+${items.length - 2}</span>` : ''),
        sub: `${r.requester} · ${items.length} รายการ`,
        subHtml: `${whoPill(r.requester)}<span class="muted">${items.length} รายการ · ${esc(r.id)}</span>`,
        pics: items.slice(0, 3).map(x => x.art), track: shopTrack(r, 'mini'),
        due: dueCell(r.expected_date), acts, cancel: ro ? '' : `data-scancel="${esc(r.id)}"`,
      });
    });
    return { mat, shop, need };
  },

  count(d) { const n = this.build(d); return n.need.length + n.mat.filter(x => !/^(done|sch):/.test(x.key)).length + n.shop.filter(x => x.tone === 'new').length + (d.adjusts || []).length; },

  card(n, i) {
    const lead = n.who ? People.avatar(n.who, 40) : `<span class="nc-ic">${ic(n.icon, 'sm')}</span>`;
    return `<article class="nrow t-${n.tone}" style="--i:${i}">
      <div class="nr-main">${lead}
        <div class="nc-b">
          <div class="nc-t ${n.titleHtml ? 'items' : ''}"><b title="${esc(n.title)}">${n.titleHtml || esc(n.title)}</b>${n.at ? `<span class="nc-ago">${this.ago(n.at)}</span>` : ''}</div>
          <div class="nc-s">${n.pics ? `<span class="nc-pics">${n.pics.map(a => shopPic(a, 24)).join('')}</span>` : ''}${n.subHtml ? `<span class="nc-who">${n.subHtml}</span>` : `<span title="${esc(n.sub)}">${esc(n.sub)}</span>`}</div>
          <div class="nc-a">${n.acts.map(([t, attr, k]) => `<button class="btn ${k === 'primary' ? 'btn-primary' : 'btn-plain'} sm" ${attr}>${esc(t)}</button>`).join('')}</div>
        </div></div>
      <div class="nr-st">${n.track || ''}${n.cancel ? `<button class="nr-cancel" ${n.cancel} title="ยกเลิกการสั่งซื้อ">${ic('x', 'sm')}ยกเลิกสั่งซื้อ</button>` : ''}</div>
      <div class="nr-due">${n.due || ''}</div>
    </article>`;
  },

  needStrip(need) {
    if (!need || !need.length) return '';
    OrderBasket.setNeed(need.map(m => ({ id: m.id, name: m.name, unit: m.unit, balance: m.bal, reorder_point: m.rp, order_qty: m.oq })));
    return `<div class="nl-need"><div class="nn-h">${ic('alert', 'sm')}<b>ถึงจุดสั่งซื้อ · ยังไม่ได้สั่ง ${need.length} รายการ</b><span>แตะเพื่อเลือกรายการที่จะสั่ง</span></div>
      <div class="nn-chips">${need.map((m, i) => `<button class="nn-chip ${OrderBasket.sel.has(m.id) ? 'on' : ''}" data-pick="${m.id}" style="--i:${i}" title="${esc(m.sub)}"><span class="ck">${ic('check', 'sm')}</span>${ic('plus', 'sm')}<span>${esc(m.name)}</span><small>${fmtN(m.bal)} ${esc(m.unit)}</small></button>`).join('')}</div>
      <div class="nl-basket">${OrderBasket.html()}</div></div>`;
  },
  lane(kind, list, compact, need) {
    const isMat = kind === 'mat';
    const head = isMat ? ['สั่งซื้อ Material', 'STOCK MATERIAL ORDERS'] : ['คำขอสั่งซื้ออุปกรณ์', 'HRM SHOPPING REQUESTS'];
    const fresh = isMat ? (need || []).length + list.filter(x => /^(ovd|today|wd|req):/.test(x.key)).length : list.filter(x => x.tone === 'new').length;
    return `<section class="nlane lane-${kind}">
      <header class="nl-h">${sticker(isMat ? 'order' : 'shopbag', 30)}<div>${bi(head[0], head[1])}</div><span class="grow"></span>
        ${fresh ? `<span class="nl-n">${fresh}${isMat ? ' ต้องจัดการ' : ' ใหม่'}</span>` : ''}
        <button class="btn btn-ghost sm" data-go="${isMat ? 'orders' : 'shophist'}">ทั้งหมด ${ic('arrowR', 'sm')}</button></header>
      ${isMat ? this.needStrip(need) : ''}
      ${isMat ? this.bulkBar(list) : ''}
      ${list.length ? `<div class="nl-cols"><span>${isMat ? 'Material / ใบสั่งซื้อ' : 'ผู้ขอ / รายการ'}</span><span>สถานะ · สั่งแล้ว › รับคำสั่ง › รอจัดส่ง › จัดส่งสำเร็จ</span><span>กำหนดส่ง</span></div>
        <div class="nl-list ${compact ? 'compact' : ''}">${list.map((n, i) => this.card(n, i)).join('')}</div>`
        : `<div class="nl-empty">${ic('check')}<span>${isMat ? 'ไม่มีใบสั่งซื้อ Material ที่รอของเข้า' : 'ไม่มีคำขออุปกรณ์ค้าง'}</span></div>`}
    </section>`;
  },

  bulkBar(list) {
    const n = list.filter(x => x.key.startsWith('req:')).length;
    if (!App.officer || n < 2) return '';
    return `<div class="nl-bulk">${ic('order', 'sm')}<div><b>คำขอสั่งซื้อจาก Operator ${n} รายการ</b><span>ใส่วันที่สั่งและวันส่งพร้อมกันได้ในครั้งเดียว</span></div><span class="grow"></span>
      <button class="btn btn-primary sm" data-obulk>${ic('check', 'sm')}สั่งซื้อทั้งหมด · ใส่วันที่</button></div>`;
  },

  lanes(d) { const n = this.build(d, !App.officer); return `<div class="nlanes">${this.lane('mat', n.mat, false, n.need)}${this.lane('shop', n.shop)}</div>`; },

  /** วันที่ของจะมาส่ง for a supply request (optional) */
  askDate(cur) {
    return modal({
      title: 'วันที่ของจะมาส่ง', en: 'EXPECTED DELIVERY DATE', icon: 'truck', color: 'var(--st-sched)',
      body: `<div class="field"><label>กำหนดส่ง <span class="en">ไม่ทราบให้เว้นว่าง</span></label><input class="input" type="date" id="sdd" value="${esc(cur || '')}" min="${App.today}"></div>`,
      ok: 'บันทึก', okEn: 'Save', onOk: m => ({ date: m.querySelector('#sdd').value || '' }),
    });
  },

  /** click handling for lanes (home + bell panel) */
  bind(root, d, done) {
    root.addEventListener('click', async e => {
      const s = e.target.closest('[data-sst]');
      if (s) {
        e.stopPropagation();
        const [rid, st] = s.dataset.sst.split('|');
        let date;
        if (st === 'ordered') { const r = await this.askDate(''); if (!r) return; date = r.date; }
        s.disabled = true;
        try {
          await api('shop_request_status', rid, st, '', date === undefined ? null : date);
          const card = s.closest('.nrow'); card?.classList.add('out');
          toast({ acknowledged: 'รับคำสั่งแล้ว', ordered: 'บันทึกว่าสั่งซื้อแล้ว — รอจัดส่ง', delivered: 'จัดส่งสำเร็จ' }[st] || 'อัปเดตแล้ว', rid);
          await App.bumpRev(); setTimeout(() => done && done(), 260);
        } catch (er) { s.disabled = false; toastErr(er); }
        return;
      }
      const lane = e.target.closest('.lane-mat');
      if (lane && e.target.closest('[data-pick],[data-obrm],[data-obclear],[data-obgo]')) { e.stopPropagation(); await OrderBasket.handle(e, lane, done); return; }
      if (e.target.closest('[data-obulk]')) {
        e.stopPropagation();
        if (await OrderConfirm.bulk((d.open_orders || []).filter(x => x.status === 'requested'))) done && done();
        return;
      }
      const rj = e.target.closest('[data-oreject]');
      if (rj) {
        e.stopPropagation();
        const o = (d.open_orders || []).find(x => x.id === rj.dataset.oreject);
        if (o && await OrderConfirm.reject(o)) done && done();
        return;
      }
      const cf = e.target.closest('[data-oconfirm]');
      if (cf) {
        e.stopPropagation();
        const o = (d.open_orders || []).find(x => x.id === cf.dataset.oconfirm);
        if (o && await OrderConfirm.open(o)) done && done();
        return;
      }
      const oc = e.target.closest('[data-ocancel],[data-scancel]');
      if (oc) {
        e.stopPropagation();
        const isShop = !!oc.dataset.scancel, id = oc.dataset.scancel || oc.dataset.ocancel;
        const ok = await modal({
          title: `ยกเลิกการสั่งซื้อ ${id}?`, en: 'CANCEL ORDER', icon: 'alert', color: 'var(--leak)', danger: true,
          body: `<p class="muted" style="margin:0 0 10px">${isShop ? 'คำขอนี้จะถูกยกเลิก ผู้ขอจะเห็นสถานะ “ยกเลิก”' : 'ใบสั่งซื้อนี้จะถูกยกเลิก — ยอดที่รับเข้าแล้วยังอยู่ครบ'} · ยืนยันอีกครั้งก่อนยกเลิก</p>
            <div class="field"><label>เหตุผล <span class="en">ไม่บังคับ</span></label><input class="input" id="cxr" maxlength="120" placeholder="เช่น สั่งซ้ำ, Supplier ไม่มีของ"></div>`,
          ok: 'ยืนยันยกเลิก', okEn: 'Cancel order', cancel: 'ไม่ยกเลิก', onOk: m => ({ reason: m.querySelector('#cxr').value.trim() }),
        });
        if (!ok) return;
        try {
          if (isShop) await api('shop_request_status', id, 'cancelled', ok.reason || '', null);
          else await api('order_set_state', id, 'cancelled', ok.reason || 'ยกเลิกโดย Officer');
          oc.closest('.nrow')?.classList.add('out');
          toast('ยกเลิกการสั่งซื้อแล้ว', `${id}${ok.reason ? ' · ' + esc(ok.reason) : ''}`, 'info');
          await App.bumpRev(); setTimeout(() => done && done(), 260);
        } catch (er) { toastErr(er); }
        return;
      }
      const sd = e.target.closest('[data-sdate]');
      if (sd) {
        e.stopPropagation();
        const r0 = (d.shop_open || []).find(x => x.id === sd.dataset.sdate);
        const r = await this.askDate(r0?.expected_date); if (!r) return;
        try { await api('shop_request_date', sd.dataset.sdate, r.date); toast('บันทึกวันส่งแล้ว', `${sd.dataset.sdate} · ${r.date ? fmtD(r.date) : 'ยังไม่มีกำหนด'}`); await App.bumpRev(); done && done(); } catch (er) { toastErr(er); }
        return;
      }
      const v = e.target.closest('.nlanes [data-sreq], .nbell [data-sreq]');
      if (v) { e.stopPropagation(); const r = (d.shop_open || []).concat(d.shop_recent || []).find(x => x.id === v.dataset.sreq); if (r) PAGES.shophist.detail(r); }
    }, true);
    root.addEventListener('input', e => { const lane = e.target.closest('.lane-mat'); if (lane) OrderBasket.input(e, lane); });
  },

  /* ---------- header bell + panel ---------- */
  bellHtml() { return App.officer ? `<button class="icon-btn nbell-btn" id="hbell" title="การแจ้งเตือน">${ic('bell')}<span class="nb-dot hidden" id="hbelln"></span></button>` : ''; },
  setBell(n) { const b = $('#hbelln'); if (!b) return; b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); },
  async panel() {
    const d = await App.dash(); this.d = d;
    const n = this.build(d);
    openPanel({
      title: 'การแจ้งเตือน', en: 'NOTIFICATIONS · OFFICER', icon: 'bell', wide: true,
      body: `<div class="nbell nlanes in-panel">${this.lane('mat', n.mat, true, n.need)}${this.lane('shop', n.shop, true)}</div>`,
      onMount: (p, close) => {
        const box = p.querySelector('.nbell');
        this.bind(box, d, () => { close(); App.refresh(); });
        box.addEventListener('click', e => {
          const g = e.target.closest('[data-go]'); if (g) { close(); if (g.dataset.go === 'shophist') PAGES.shophist.f = 'all'; return App.go(g.dataset.go); }
          const o = e.target.closest('[data-order]'); if (o) { close(); return OrderUI.form({ material_id: +o.dataset.order }); }
          const r = e.target.closest('[data-oid]'); if (r) { close(); return OrderUI.detail(r.dataset.oid); }
        });
      },
    });
  },

  /* ---------- new-item toasts (each computer remembers what it has already shown) ---------- */
  update(d) {
    if (!App.officer) { this.setBell(0); this.placedToasts(d); return; }
    const n = this.build(d), all = n.need.concat(n.mat, n.shop);
    this.setBell(this.count(d));
    let seen = null; try { seen = JSON.parse(localStorageGet('notifSeen') || 'null'); } catch (e) { }
    const keys = all.map(x => x.key);
    if (Array.isArray(seen)) {
      // pop up only what needs the Officer: new supply requests, items reaching the reorder point, overdue / due today
      const fresh = all.filter(x => !seen.includes(x.key) && /^(need|ovd|today|req):|^sr:.*:saved$/.test(x.key));
      fresh.slice(0, 3).forEach((x, i) => setTimeout(() => this.toast(x, n.shop.includes(x) ? 'shop' : 'mat'), i * 450));
      if (fresh.length > 3) setTimeout(() => toast(`และอีก ${fresh.length - 3} การแจ้งเตือน`, 'เปิดกระดิ่งด้านบนเพื่อดูทั้งหมด', 'info'), 1500);
    }
    localStorageSet('notifSeen', JSON.stringify(keys.slice(0, 300)));
    StockFix.toasts(d);
  },
  /** Operator computers: pop up once when the Officer has placed an order that was requested from the floor */
  placedToasts(d) {
    const placed = (d.requests || []).filter(o => o.status !== 'requested');
    let seen = null; try { seen = JSON.parse(localStorageGet('opPlaced') || 'null'); } catch (e) { }
    if (Array.isArray(seen)) {
      placed.filter(o => !seen.includes(o.id)).slice(0, 3).forEach((o, i) => setTimeout(() => this.toast(o.status === 'rejected' ? {
        tone: 'over', icon: 'x', oid: o.id, title: `ไม่อนุมัติคำขอ · ${o.material.name}`,
        sub: `เหตุผล: ${(String(o.remark || '').match(/ไม่อนุมัติ:\s*(.*)$/) || [])[1] || '-'} · ขอโดย ${o.requested_by}`,
      } : {
        tone: 'ship', icon: 'check', oid: o.id, title: `Officer สั่งซื้อแล้ว · ${o.material.name}`,
        sub: `${fmtN(o.ordered_qty)} ${o.material.unit} · ${o.expected_date ? 'กำหนดส่ง ' + fmtD(o.expected_date) : 'รอกำหนดส่ง'} · ขอโดย ${o.requested_by}`,
      }, 'mat'), i * 450));
    }
    localStorageSet('opPlaced', JSON.stringify([...new Set((seen || []).concat(placed.map(o => o.id)))].slice(-300)));
  },
  toast(n, kind) {
    const el = document.createElement('div');
    el.className = `toast ntoast ${kind} t-${n.tone}`;
    el.innerHTML = `<span class="nt-ic">${ic(n.icon, 'sm')}</span><div><span class="nt-chip">${kind === 'shop' ? 'อุปกรณ์ · HRM Shopping' : 'Material · สั่งซื้อสต็อก'}</span><b>${esc(n.title)}</b><span>${esc(n.sub)}</span></div>`;
    el.onclick = () => { el.remove(); n.oid ? OrderUI.detail(n.oid) : this.panel(); };
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 7000);
  },
};

/* ===== mobile.js ===== */
/* =====================================================================
   MOBILE ENTRY — บันทึกเฉพาะรายการที่มีการใช้ / รับของ จากมือถือ
   • รายการอื่นที่ไม่ได้ใช้ → ยกยอดเดิมอัตโนมัติ (คงเหลือคำนวณจากยอดเดิมเสมอ)
   • บันทึกชื่อผู้บันทึก (OPS) ทุกครั้ง
   • ต้องบันทึกวันก่อนหน้าที่ยังขาดให้ครบก่อน แล้วจึงบันทึกวันนี้
   • ไม่มีการใช้งาน → ปุ่ม "ไม่มีการใช้งานวันนี้" พิมพ์ชื่อ แล้วบันทึก
   ===================================================================== */
'use strict';

const num = v => (v === null || v === undefined || v === '' || Number.isNaN(+v)) ? 0 : +v;
const Mobile = {
  want() {
    if (location.hash === '#mobile') return true;
    const v = localStorageGet('view');
    if (v === 'desktop') return false;
    if (v === 'mobile') return true;
    return matchMedia('(max-width: 760px)').matches;
  },
  date: null, day: null, entries: {}, missing: [], carryOpen: false,

  async start() {
    document.body.classList.add('is-mobile');
    if (App.info.need_machine) { try { App.info = await api('set_machine', 'มือถือ'); } catch (e) { } }
    this.date = App.today;
    await this.load();
  },

  async load(date) {
    if (date) this.date = date;
    const root = $('#root');
    root.innerHTML = `<div class="mb"><div class="mb-loading"><span class="spin"></span>กำลังโหลด…</div></div>`;
    try {
      const [day, missing] = await Promise.all([api('day_get', this.date), api('missing_days', this.date)]);
      this.day = day; this.missing = missing;
      this.entries = {};
      day.rows.forEach(r => { if (r.used !== null || r.received !== null) this.entries[r.id] = { used: r.used, received: r.received }; });
      this.draw();
    } catch (e) {
      root.innerHTML = `<div class="mb"><div class="mb-err">${sticker('alert', 64)}<b>โหลดข้อมูลไม่สำเร็จ</b><span>${esc(e.message)}</span><button class="btn btn-primary lg" onclick="Mobile.load()">${ic('refresh', 'sm')}ลองอีกครั้ง</button></div></div>`;
    }
  },

  /* ---------- main screen ---------- */
  draw() {
    const d = this.day, D = this.date, T = App.today, isToday = D === T;
    const rows = d.rows, used = rows.filter(r => this.entries[r.id]), carry = rows.filter(r => !this.entries[r.id] && r.status === 'active');
    const recorded = !!d.ops, locked = !!d.verified_at && !App.officer;   // only an Officer-verified day is locked
    const blocked = !recorded && this.missing.length > 0;
    const name = localStorageGet('opsName') || '';
    const dt = pd(D);
    let alert = '';
    if (blocked) {
      const first = this.missing[0], n = this.missing.length;
      alert = `<div class="mb-alert warn">${sticker('alert', 40)}<div><b>ยังไม่ได้บันทึกวันก่อนหน้า ${n} วัน</b>
        <span>${this.missing.slice(0, 6).map(x => fmtD(x)).join(', ')}${n > 6 ? ' …' : ''} — บันทึกวันก่อนหน้าก่อน แล้วค่อยบันทึกวันนี้</span>
        <button class="btn btn-primary" data-goday="${first}">${ic('arrowR', 'sm')}ไปบันทึก ${fmtD(first)}</button></div></div>`;
    } else if (locked) {
      alert = `<div class="mb-alert lock">${ic('shield')}<div><b>Officer ยืนยันวันนี้แล้ว · ${esc(d.ops)}</b><span>ถ้าต้องแก้ไข ติดต่อ Officer ให้ยกเลิกการยืนยันก่อน</span></div></div>`;
    } else if (recorded) {
      const noUse = /ไม่มีการใช้งาน/.test(d.remark || '') || !used.length;
      alert = `<div class="mb-alert ok">${ic('check')}<div><b>บันทึกแล้ว · ${esc(d.ops)}${noUse ? ' · ไม่มีการใช้งาน' : ''}</b><span>${fmtTime(d.saved_at)} น.${noUse ? ' · ยกยอดจากวันก่อนหน้าทุกรายการ' : ''}${d.verified_at ? ' · Officer ยืนยันแล้ว' : ''}</span>
        <span class="mb-pc">${ic('edit', 'sm')}แก้ไขได้ — แตะรายการเพื่อแก้ตัวเลข แล้วกดบันทึกอีกครั้ง</span></div></div>`;
    }
    const pending = this.missing.length && recorded ? '' : '';
    $('#root').innerHTML = `<div class="mb ${blocked ? 'blocked' : ''}">
      <header class="mb-top">
        <span class="mb-logo">${art('logo', 30)}</span><div class="mb-brand"><b>HRM STOCK</b><span>บันทึกการใช้ · มือถือ</span></div>
        <span class="grow"></span>
        ${typeof PushUI !== 'undefined' && IS_WEB ? `<button class="mb-icon mb-push" data-push title="แจ้งเตือน" aria-label="แจ้งเตือน">${ic('bell', 'sm')}<i></i></button>` : ''}
        <button class="mb-icon" data-desk title="เปิดแบบเต็ม">${ic('side', 'sm')}</button>
      </header>
      <div class="mb-date">
        <button class="mb-icon" data-day="-1" aria-label="วันก่อน">${ic('chevL')}</button>
        <label class="mb-dlabel"><b>${TH_WD[dt.getDay()]} ${fmtD(D)}</b><span>${isToday ? 'วันนี้ · TODAY' : D < T ? 'บันทึกย้อนหลัง · BACKDATE' : ''}</span><input type="date" id="mb-dp" value="${D}" max="${T}"></label>
        <button class="mb-icon" data-day="1" aria-label="วันถัดไป" ${isToday ? 'disabled' : ''}>${ic('chevR')}</button>
      </div>
      ${alert}
      <section class="mb-sec">
        <div class="mb-sec-h">${bi('รายการที่ใช้ / รับของวันนี้', 'USED · RECEIVED')}<span class="count-chip">${used.length}</span></div>
        <div class="mb-list">${used.map(r => this.card(r)).join('') || `<div class="mb-none">${sticker('check', 46)}<div><b>ยังไม่มีรายการ</b><span>ถ้าวันนี้ไม่ได้ใช้อะไร กด “ไม่มีการใช้งานวันนี้” ด้านล่างได้เลย</span></div></div>`}</div>
        ${locked || blocked ? '' : `<button class="mb-add" data-add>${ic('plus')}${bi('เพิ่มรายการที่ใช้ / รับของ', 'Add material')}</button>`}
        ${locked || blocked || used.length ? '' : `<button class="mb-nouse" data-nouse>${ic('refresh')}<span class="bi"><span class="th">ไม่มีการใช้งานวันนี้</span><span class="en">NO USAGE · CARRY FORWARD</span></span></button>`}
      </section>
      <section class="mb-carry ${this.carryOpen ? 'open' : ''}">
        <button class="mb-carry-h" data-carry>${ic('refresh', 'sm')}<span>${bi(`ยกยอดเดิม ${carry.length} รายการ`, 'NO USAGE · BALANCE CARRIED')}</span><span class="grow"></span>${ic('chevD', 'sm')}</button>
        <div class="mb-carry-b">${carry.map(r => `<div class="mb-crow"><span>${esc(r.name)}</span><b class="num">${fmtN(r.before)} <small>${esc(r.unit)}</small></b></div>`).join('')}</div>
      </section>
      <div class="mb-space"></div>
      <footer class="mb-bar">
        <label class="mb-name">${ic('user', 'sm')}<input id="mb-name" placeholder="ลงชื่อผู้บันทึก" value="${esc(recorded ? d.ops : name)}" maxlength="30" autocomplete="off" ${locked || blocked ? 'disabled' : ''}></label>
        ${blocked ? `<button class="btn btn-primary lg mb-save" data-goday="${this.missing[0]}">${ic('arrowR')}${bi('บันทึกวันก่อนหน้าก่อน', `GO TO ${fmtD(this.missing[0])}`)}</button>`
        : locked ? (D < T ? `<button class="btn btn-plain lg mb-save" data-day="1">${bi('วันถัดไป', 'NEXT DAY')}${ic('chevR')}</button>` : '')
        : used.length ? `<button class="btn btn-primary lg mb-save" data-save>${ic('check')}${bi(recorded ? `บันทึกการแก้ไข · ${used.length} รายการ` : `บันทึก ${used.length} รายการ`, recorded ? 'SAVE CHANGES' : 'SAVE')}</button>`
          : `<button class="btn btn-primary lg mb-save none" data-nouse>${ic('refresh')}${bi('ไม่มีการใช้งาน', 'NO USAGE · SAVE')}</button>`}
      </footer>
    </div>`;
    this.bind();
  },

  card(r) {
    const e = this.entries[r.id] || {}, after = r.before + num(e.received) - num(e.used);
    return `<article class="mb-card" data-edit="${r.id}">
      <div class="mb-card-t"><b>${esc(r.name)}</b><span>${esc(r.code)}</span></div>
      <div class="mb-card-v">
        ${e.used !== null && e.used !== undefined ? `<span class="u">ใช้ไป <b class="num">${fmtN(e.used)}</b></span>` : ''}
        ${e.received !== null && e.received !== undefined ? `<span class="r">รับ <b class="num">+${fmtN(e.received)}</b></span>` : ''}
        <span class="bal">คงเหลือ <b class="num">${fmtN(after)}</b> ${esc(r.unit)}</span>
      </div>
    </article>`;
  },

  bind() {
    const root = $('#root');
    if (typeof PushUI !== 'undefined' && IS_WEB) PushUI.dot();
    root.onclick = e => {
      const t = e.target;
      const g = t.closest('[data-goday]'); if (g) return this.load(g.dataset.goday);
      const dd = t.closest('[data-day]'); if (dd && !dd.disabled) { const x = pd(this.date); x.setDate(x.getDate() + +dd.dataset.day); return this.load(iso(x)); }
      if (t.closest('[data-push]')) return PushUI.sheet();
      if (t.closest('[data-desk]')) { localStorageSet('view', 'desktop'); location.hash = 'home'; location.reload(); return; }
      if (t.closest('[data-carry]')) { this.carryOpen = !this.carryOpen; t.closest('.mb-carry').classList.toggle('open', this.carryOpen); return; }
      if (t.closest('[data-add]')) return this.pick();
      const ed = t.closest('[data-edit]'); if (ed && !(this.day.verified_at && !App.officer)) return this.editor(+ed.dataset.edit);
      if (t.closest('[data-save]')) return this.confirm(false);
      if (t.closest('[data-nouse]')) return this.confirm(true);
    };
    const dp = $('#mb-dp'); if (dp) dp.onchange = () => { if (dp.value && dp.value <= App.today) this.load(dp.value); };
    const nm = $('#mb-name'); if (nm) nm.oninput = () => { nm.classList.remove('err'); };
  },

  /* ---------- bottom sheets ---------- */
  sheet(html, onMount) {
    const scrim = document.createElement('div'); scrim.className = 'mb-scrim';
    const sh = document.createElement('div'); sh.className = 'mb-sheet'; sh.innerHTML = `<div class="grab"></div>${html}`;
    document.body.append(scrim, sh);
    requestAnimationFrame(() => { scrim.classList.add('in'); sh.classList.add('in'); });
    const close = () => { scrim.classList.remove('in'); sh.classList.remove('in'); setTimeout(() => { scrim.remove(); sh.remove(); }, 260); };
    scrim.onclick = close;
    onMount && onMount(sh, close);
    return close;
  },
  pick() {
    const rows = this.day.rows.filter(r => r.status === 'active');
    this.sheet(`<div class="mb-sheet-h">${bi('เลือกรายการที่ใช้ / รับ', 'SELECT MATERIAL')}</div>
      <label class="mb-search">${ic('search', 'sm')}<input id="mb-q" placeholder="ค้นหาชื่อ เช่น SRR, TEA…" autocomplete="off"></label>
      <div class="mb-pick" id="mb-pl"></div>`, (sh, close) => {
      const draw = q => {
        q = (q || '').toLowerCase().trim();
        sh.querySelector('#mb-pl').innerHTML = rows.filter(r => !q || (r.name + ' ' + r.code + ' ' + (r.name_en || '')).toLowerCase().includes(q))
          .map(r => `<button class="mb-prow ${this.entries[r.id] ? 'has' : ''}" data-p="${r.id}"><span class="t"><b>${esc(r.name)}</b><small>${esc(r.code)}${this.entries[r.id] ? ' · มีในรายการแล้ว' : ''}</small></span><span class="v num">${fmtN(r.before)} <small>${esc(r.unit)}</small></span>${ic('chevR', 'sm')}</button>`).join('')
          || `<div class="mb-none" style="margin:12px 0"><div><b>ไม่พบรายการ</b></div></div>`;
      };
      draw('');
      sh.querySelector('#mb-q').oninput = e => draw(e.target.value);
      sh.querySelector('#mb-pl').onclick = e => { const b = e.target.closest('[data-p]'); if (b) { close(); setTimeout(() => this.editor(+b.dataset.p), 200); } };
    });
  },
  editor(id) {
    const r = this.day.rows.find(x => x.id === id); if (!r) return;
    const e = this.entries[id] || {};
    this.sheet(`<div class="mb-sheet-h">${bi(r.name, r.code + ' · ' + r.unit)}</div>
      <div class="mb-ed-bal"><span>ยอดยกมา (ทั้งหมด)</span><b class="num">${fmtN(r.before)} <small>${esc(r.unit)}</small></b></div>
      <div class="mb-ed">
        <label class="mb-num u"><span>${bi('ใช้ไป', 'USED')}</span><input id="ed-u" class="num" inputmode="decimal" value="${e.used ?? ''}" placeholder="0" autocomplete="off"><small>${esc(r.unit)}</small></label>
        <label class="mb-num r"><span>${bi('รับสินค้า', 'ของมาส่ง ' + fmtD(this.date))}</span><input id="ed-r" class="num" inputmode="decimal" value="${e.received ?? ''}" placeholder="0" autocomplete="off"><small>${esc(r.unit)}</small></label>
      </div>
      <div class="mb-ed-after" id="ed-a"></div>
      <div class="err-text" id="ed-err"></div>
      <div class="mb-ed-acts">${this.entries[id] ? `<button class="btn btn-ghost lg" data-rm>${ic('x', 'sm')}ลบรายการ</button>` : ''}<span class="grow"></span><button class="btn btn-primary lg" data-ok>${ic('check')}ตกลง</button></div>`, (sh, close) => {
      const u = sh.querySelector('#ed-u'), rc = sh.querySelector('#ed-r');
      const calc = () => {
        [u, rc].forEach(x => x.value = x.value.replace(/[^\d.,]/g, ''));
        const a = r.before + num(parseNum(rc.value)) - num(parseNum(u.value));
        sh.querySelector('#ed-a').innerHTML = `คงเหลือหลังบันทึก <b class="num ${a < 0 ? 'neg' : ''}">${fmtN(a)}</b> ${esc(r.unit)}${a < r.reorder_point && r.reorder_point ? ` <span class="tag-need">ถึงจุดสั่งซื้อ</span>` : ''}`;
      };
      u.oninput = calc; rc.oninput = calc; calc();
      setTimeout(() => (e.received && !e.used ? rc : u).focus(), 280);
      const ok = () => {
        const vu = u.value.trim() === '' ? null : parseNum(u.value), vr = rc.value.trim() === '' ? null : parseNum(rc.value);
        if ((vu !== null && (Number.isNaN(vu) || vu < 0)) || (vr !== null && (Number.isNaN(vr) || vr < 0))) return sh.querySelector('#ed-err').textContent = 'กรุณากรอกตัวเลขให้ถูกต้อง';
        if (vu === null && vr === null || (!vu && !vr)) delete this.entries[id];
        else this.entries[id] = { used: vu || null, received: vr || null };
        close(); this.draw();
      };
      sh.querySelector('[data-ok]').onclick = ok;
      [u, rc].forEach(x => x.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); x === u ? rc.focus() : ok(); } });
      sh.querySelector('[data-rm]')?.addEventListener('click', () => { delete this.entries[id]; close(); this.draw(); });
    });
  },

  /* ---------- save: check once, then it is final on the phone ---------- */
  confirm(none) {
    const nm = $('#mb-name'), name = nm.value.trim();
    if (!name) { nm.classList.add('err'); nm.focus(); toast('กรุณาลงชื่อผู้บันทึก', 'ชื่อจะถูกบันทึกในช่อง OPS', 'warn'); return; }
    const rows = this.day.rows.filter(r => this.entries[r.id]);
    const D = this.date;
    const list = none
      ? `<div class="mb-cf-none">${ic('refresh')}<div><b>ยกยอดจากวันก่อนหน้าทุกรายการ</b><span>${this.day.rows.filter(r => r.status === 'active').length} รายการ · คงเหลือเท่าเดิม ไม่มีการใช้ / รับของ</span></div></div>`
      : rows.map(r => { const e = this.entries[r.id], a = r.before + num(e.received) - num(e.used); return `<div class="mb-cf-row"><b>${esc(r.name)}</b><span>${e.used ? `ใช้ไป <b class="num">${fmtN(e.used)}</b>` : ''}${e.received ? ` <span class="r">รับ <b class="num">+${fmtN(e.received)}</b></span>` : ''}</span><span class="num">→ ${fmtN(a)} ${esc(r.unit)}</span></div>`; }).join('');
    this.sheet(`<div class="mb-sheet-h">${bi(none ? 'ยืนยัน ไม่มีการใช้งาน' : 'ตรวจสอบก่อนบันทึก', `${fmtD(D)} · ${name}`)}</div>
      <div class="mb-cf">${list}</div>
      <div class="mb-cf-warn ok">${ic('edit', 'sm')}<span>บันทึกแล้วยังกลับมาแก้ไขได้ — เลือกวันที่แล้วแตะรายการที่ต้องการแก้</span></div>
      <div class="mb-ed-acts"><button class="btn btn-ghost lg" data-x>กลับไปแก้</button><span class="grow"></span><button class="btn btn-primary lg" data-ok>${ic('check')}${none ? 'ยืนยัน ไม่มีการใช้งาน' : 'ยืนยันบันทึก'}</button></div>`, (sh, close) => {
      sh.querySelector('[data-x]').onclick = close;
      sh.querySelector('[data-ok]').onclick = async ev => { const b = ev.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span>กำลังบันทึก…`; const ok = await this.save(name, none); if (ok) close(); else { b.disabled = false; b.innerHTML = `${ic('check')}ลองอีกครั้ง`; } };
    });
  },
  async save(name, none) {
    try {
      // every row is sent: a line removed while editing becomes empty again
      const rows = this.day.rows.map(r => { const e = none ? null : this.entries[r.id]; return { id: r.id, used: e ? e.used : null, received: e ? e.received : null }; });
      await api('day_save', this.date, name, rows, { mobile: true, no_use: none });
      if (none) toast('บันทึกแล้ว · ไม่มีการใช้งาน', `${fmtD(this.date)} · ยกยอดจากวันก่อนหน้าทุกรายการ`, 'info');
      localStorageSet('opsName', name);
      const next = (await api('missing_days', App.today)).filter(x => x > this.date)[0] || (this.date < App.today ? App.today : null);
      this.done(none, name, next);
      return true;
    } catch (e) { toastErr(e); return false; }
  },
  done(none, name, next) {
    const D = this.date;
    const ov = document.createElement('div'); ov.className = 'mb-done';
    ov.innerHTML = `<div class="mb-done-c"><div class="mb-check"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg></div>
      <b>${none ? 'บันทึกแล้ว · ไม่มีการใช้งาน' : 'บันทึกแล้ว'}</b><span>${fmtD(D)} · ${esc(name)}${none ? ' · ยกยอดเดิมทุกรายการ' : ''}</span>
      ${next ? `<button class="btn btn-primary lg" data-next="${next}">${ic('arrowR')}${next === App.today ? 'บันทึกวันนี้ต่อ' : `บันทึก ${fmtD(next)} ต่อ`}</button>` : `<button class="btn btn-plain lg" data-close>เสร็จสิ้น</button>`}</div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    const go = d => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 250); this.load(d); };
    ov.onclick = e => { const n = e.target.closest('[data-next]'); if (n) return go(n.dataset.next); if (e.target.closest('[data-close]')) go(D); };
  },
};

/* ===== qrcode.js ===== */
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

(function (factory) {
  if (typeof define === 'function' && define.amd) {
      define([], factory);
  } else if (typeof exports === 'object') {
      module.exports = factory();
  }
}(function () {
    return qrcode;
}));

/* ===== qr.js ===== */
/* =====================================================================
   QR — เปิด HRM STOCK บนมือถือ (เฉพาะเว็บบน Vercel)
   QR 1: ลิงก์ปกติ → สแกนแล้วใส่รหัสทีม · QR 2 (Officer สร้าง): ลิงก์เข้าได้เลย มีวันหมดอายุ ยกเลิกได้ด้วยการเปลี่ยน TEAM_CODE
   ===================================================================== */
'use strict';

const QrUI = {
  on() { return IS_WEB && typeof qrcode === 'function'; },
  base() { return location.origin + '/'; },
  /** crisp SVG (one path) — scales to any size, prints sharp */
  svg(text, px = 200) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), m = 4, s = n + m * 2; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    return `<svg class="qr-svg" viewBox="0 0 ${s} ${s}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#111722"/></svg>`;
  },
  card() {
    if (!this.on()) return '';
    const inv = this.inv, off = App.officer;
    return `<section class="card qr-card" style="grid-column:1/-1"><div class="card-h">${tile('user', 'var(--primary)', 'sm')}<div class="title">${bi('QR เปิดใช้งานบนมือถือ', 'SCAN TO OPEN ON PHONE')}</div><span class="grow"></span>
        <button class="btn btn-tonal sm" data-qr="print">${ic('print', 'sm')}พิมพ์ QR</button></div>
      <div class="qr-grid">
        <div class="qr-box"><div class="qr-img">${this.svg(this.base())}</div>
          <div class="qr-t"><span class="qr-tag">${ic('lock', 'sm')}ต้องใส่รหัสทีม</span><b>สแกน แล้วใส่รหัสทีม</b>
          <small>ปลอดภัยที่สุด — ติดไว้หน้างานได้ คนที่ไม่มีรหัสเข้าไม่ได้</small><code>${esc(this.base())}</code></div></div>
        <div class="qr-box ${inv ? '' : 'empty'}">${inv ? `<div class="qr-img">${this.svg(inv.url)}</div>
          <div class="qr-t"><span class="qr-tag go">${ic('check', 'sm')}เข้าได้เลย</span><b>สแกนแล้วเข้าใช้ได้ทันที</b>
          <small>ไม่ต้องพิมพ์รหัส · ใช้ได้ถึง ${fmtD(new Date(inv.exp).toISOString().slice(0, 10))}<br>ส่งให้เฉพาะคนในทีม — อย่าติดในที่คนนอกเห็น</small></div>`
          : `<div class="qr-img ph">${ic('lock')}</div><div class="qr-t"><span class="qr-tag go">${ic('check', 'sm')}เข้าได้เลย</span><b>QR ไม่ต้องใส่รหัส</b>
          ${off ? `<small>สร้าง QR สำหรับคนใหม่ในทีม · หมดอายุเองตามที่ตั้ง</small>
            <div class="qr-mk"><select class="input" id="qr-days"><option value="1">1 วัน</option><option value="7">7 วัน</option><option value="30" selected>30 วัน</option><option value="90">90 วัน</option></select>
            <button class="btn btn-primary sm" data-qr="make">สร้าง QR</button></div>` : '<small>ให้ Officer สร้างจากหน้า ตั้งค่า (โหมด Officer)</small>'}</div>`}</div>
      </div>
      <p class="hint">ยกเลิก QR “เข้าได้เลย” ทุกอันทันที: เปลี่ยน TEAM_CODE ใน Vercel แล้ว Redeploy (ทุกเครื่องต้องใส่รหัสใหม่)</p></section>`;
  },
  bind(el, rerender) {
    const box = el.querySelector('.qr-card'); if (!box) return;
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-qr]'); if (!b) return;
      if (b.dataset.qr === 'print') return this.print();
      b.disabled = true;
      try {
        const r = await api('team_invite', +box.querySelector('#qr-days').value);
        if (!r.gate) toast('ยังไม่ได้ตั้งรหัสทีม', 'เพิ่ม TEAM_CODE ใน Vercel ก่อน — ตอนนี้ลิงก์ปกติเข้าได้โดยไม่ต้องใส่รหัส', 'warn');
        else { this.inv = r; toast('สร้าง QR แล้ว', `ใช้ได้ ${r.days} วัน`); rerender(); }
      } catch (er) { toastErr(er); }
      b.disabled = false;
    });
  },
  /** A4 sheet: QR(s) big enough to scan from a wall */
  print() {
    const one = (svg, tag, title, sub) => `<div class="b"><div class="tag">${tag}</div>${svg}<h2>${title}</h2><p>${sub}</p></div>`;
    const qa = one(this.svg(this.base(), 260), 'ต้องใส่รหัสทีม', 'สแกนเพื่อเปิด HRM STOCK', 'แล้วใส่รหัสทีม · เครื่องจะจำไว้ 30 วัน');
    const qb = this.inv ? one(this.svg(this.inv.url, 260), 'เข้าได้เลย', 'สแกนแล้วเข้าใช้ได้ทันที', 'ใช้ได้ถึง ' + fmtD(new Date(this.inv.exp).toISOString().slice(0, 10)) + ' · เฉพาะคนในทีม') : '';
    printHtml(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>HRM STOCK QR</title><style>
      @page{size:A4 portrait;margin:14mm}body{margin:0;font-family:"Thonburi","Noto Sans Thai","Leelawadee UI",sans-serif;color:#111722;text-align:center}
      h1{font-size:26pt;margin:6mm 0 2mm}.s{color:#535D6D;font-size:12pt;margin:0 0 10mm}
      .w{display:flex;justify-content:center;gap:14mm;flex-wrap:wrap}.b{border:1.5pt solid #DCE2EB;border-radius:6mm;padding:8mm 8mm 6mm;width:76mm}
      .b svg{width:62mm;height:62mm}.tag{display:inline-block;font-weight:700;font-size:11pt;padding:1.5mm 4mm;border-radius:10mm;background:#E8EFFD;color:#2862E6;margin-bottom:4mm}
      h2{font-size:15pt;margin:4mm 0 1mm}p{margin:0;color:#535D6D;font-size:11pt}.u{margin-top:10mm;font-size:10pt;color:#6B7587}
    </style></head><body><h1>HRM STOCK</h1><p class="s">ระบบควบคุมและจัดการสต็อก HRM · เปิดบนมือถือ</p><div class="w">${qa}${qb}</div>
    <p class="u">${esc(this.base())}</p><script>window.onload=()=>setTimeout(()=>print(),200)</script></body></html>`, 'HRM_STOCK_QR');
  },
};

/* ===== push.js ===== */
/* =====================================================================
   PUSH — แจ้งเตือนบนมือถือ (เว็บบน Vercel / แอปที่ติดตั้ง)
   เครื่องนี้เลือกทีม → เลยเวลาเตือนแล้วกะเช้าทีมนั้นยังไม่ลง STOCK → เด้งเตือน 1 ครั้ง/วัน (แม้ไม่ได้เปิดแอป)
   ===================================================================== */
'use strict';

const PushUI = {
  ok() { return IS_WEB && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  ios() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); },
  standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },
  team() { return localStorageGet('pushTeam') || ''; },
  async sub() { try { const r = await navigator.serviceWorker.ready; return await r.pushManager.getSubscription(); } catch (e) { return null; } },
  u8(b64) { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); },
  async enable(team) {
    if (Notification.permission === 'denied') throw new Error('เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ — เปิดสิทธิ์ในตั้งค่าเบราว์เซอร์ก่อน');
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('ยังไม่ได้อนุญาตการแจ้งเตือน');
    const key = await api('push_key'), reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.u8(key) });
    await api('push_subscribe', sub.toJSON(), team, (this.ios() ? 'iPhone' : /android/i.test(navigator.userAgent) ? 'Android' : 'คอม') + (team ? ' · ทีม ' + team : ''));
    localStorageSet('pushTeam', team); localStorageSet('pushOn', '1');
  },
  async disable() {
    const s = await this.sub();
    if (s) { try { await api('push_unsubscribe', s.endpoint); } catch (e) { } await s.unsubscribe(); }
    localStorageSet('pushOn', '');
  },
  /** panel HTML — shared by the Settings card and the mobile sheet */
  async panel() {
    if (!this.ok()) return `<p class="muted">${this.ios() && !this.standalone() ? 'iPhone: กดปุ่มแชร์ ⎙ › “เพิ่มไปยังหน้าจอโฮม” แล้วเปิด HRM STOCK จากไอคอน จึงจะเปิดแจ้งเตือนได้ (iOS 16.4 ขึ้นไป)' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน — ใช้ Chrome (Android) หรือติดตั้งแอปลงหน้าจอโฮม (iPhone)'}</p>`;
    const s = await this.sub(), on = !!s && Notification.permission === 'granted', t = this.team();
    const chip = (v, l) => `<button class="pu-t ${t === v ? 'on' : ''}" data-pt="${v}" ${v ? `data-t="${v}"` : ''}>${l}</button>`;
    return `<div class="pu ${on ? 'is-on' : ''}">
      <div class="pu-st"><span class="pu-dot"></span><span><b>${on ? 'เปิดแจ้งเตือนแล้ว' : 'ยังไม่เปิดแจ้งเตือน'}</b><small>${on ? `เตือนเมื่อ${t ? ' ทีม ' + t : 'ทุกทีม'} ยังไม่ลง STOCK หลัง ${Shift.remindAt()} น.` : 'เตือนบนเครื่องนี้ แม้ไม่ได้เปิดแอป'}</small></span></div>
      <label class="pu-lbl">เตือนของทีม <span class="en">TEAM</span></label>
      <div class="pu-ts">${chip('A', 'ทีม A')}${chip('B', 'ทีม B')}${chip('C', 'ทีม C')}${chip('', 'ทุกทีม')}</div>
      <div class="pu-act">${on ? `<button class="btn btn-ghost" data-pu="off">ปิดแจ้งเตือน</button><button class="btn btn-tonal" data-pu="test">${ic('bell', 'sm')}ทดสอบ</button>`
        : `<button class="btn btn-primary" data-pu="on">${ic('bell', 'sm')}เปิดแจ้งเตือน</button>`}</div></div>`;
  },
  bind(box, redraw) {
    box.addEventListener('click', async e => {
      const tb = e.target.closest('[data-pt]');
      if (tb) { localStorageSet('pushTeam', tb.dataset.pt); if ((await this.sub()) && Notification.permission === 'granted') { try { await this.enable(tb.dataset.pt); toast('เปลี่ยนทีมแล้ว', tb.dataset.pt ? 'ทีม ' + tb.dataset.pt : 'ทุกทีม'); } catch (er) { toastErr(er); } } return redraw(); }
      const b = e.target.closest('[data-pu]'); if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.pu === 'on') { await this.enable(this.team()); toast('เปิดแจ้งเตือนแล้ว', 'กด “ทดสอบ” เพื่อลองเด้งเตือน'); }
        else if (b.dataset.pu === 'off') { await this.disable(); toast('ปิดแจ้งเตือนแล้ว'); }
        else if (b.dataset.pu === 'test') { const s = await this.sub(); await api('push_test', s && s.toJSON()); toast('ส่งแล้ว', 'การแจ้งเตือนจะเด้งในไม่กี่วินาที'); }
      } catch (er) { toastErr(er); }
      b.disabled = false; redraw();
    });
  },
  /* Settings card (desktop view) */
  card() { return IS_WEB ? `<section class="card pu-card"><div class="card-h">${tile('bell', 'var(--primary)', 'sm')}<div class="title">${bi('แจ้งเตือนบนเครื่องนี้', 'PUSH NOTIFICATIONS')}</div></div><div class="pu-body"><div class="ln-load">${ic('refresh', 'sm')} กำลังโหลด…</div></div></section>` : ''; },
  async bindCard(el) {
    const box = el.querySelector('.pu-card .pu-body'); if (!box) return;
    const draw = async () => { box.innerHTML = await this.panel(); };
    await draw(); this.bind(box, draw);
  },
  /* mobile: bottom sheet from the bell in the header */
  async sheet() {
    const ov = document.createElement('div'); ov.className = 'pu-ov';
    ov.innerHTML = `<div class="pu-sheet" role="dialog" aria-label="แจ้งเตือน"><div class="pu-grab"></div><div class="pu-h">${bi('แจ้งเตือนบนมือถือ', 'PUSH NOTIFICATIONS')}<button class="mb-icon" data-x aria-label="ปิด">${ic('x', 'sm')}</button></div><div class="pu-body"></div></div>`;
    document.body.appendChild(ov); requestAnimationFrame(() => ov.classList.add('on'));
    const box = ov.querySelector('.pu-body'), draw = async () => { box.innerHTML = await this.panel(); };
    await draw(); this.bind(box, async () => { await draw(); this.dot(); });
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-x]')) { ov.classList.remove('on'); setTimeout(() => ov.remove(), 300); } });
  },
  async dot() { const b = document.querySelector('[data-push]'); if (b) b.classList.toggle('on', !!(await this.sub()) && Notification.permission === 'granted'); },
};
