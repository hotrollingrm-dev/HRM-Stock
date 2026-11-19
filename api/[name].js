/* HRM STOCK · Vercel API proxy
   Browser → POST /api/<name> {args, ctx} → backend → {ok, data, error, ctx}
   BACKEND=gas      : forwards to the Google Apps Script web app (GAS_URL) with the shared key (GAS_KEY = Script Property WEB_KEY)
   Supabase (v3.76)  : set SUPABASE_DB_URL → Officer moves the data in Settings › ย้ายไป Supabase; until then every call still goes to Google.
                      BACKEND=supabase forces the database (skip the switch flag). /api/_sb = move tools + 5-min tick · /api/_file = scans · /api/_line = LINE webhook
   TEAM_CODE        : team password — every data call needs the signed cookie from POST /api/team_login (30 days) */
const crypto = require('crypto');
let webpush = null; try { webpush = require('web-push'); } catch (e) { }
const NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;
let sb = null; const SB = () => sb || (sb = require('../server/sb'));
const sbOn = () => !!process.env.SUPABASE_DB_URL;
/** where data calls go right now */
async function useSb() {
  if (!sbOn()) return false;
  if (String(process.env.BACKEND || '').toLowerCase() === 'supabase') return true;
  return SB().isLive();
}
const originOf = req => { const h = req.headers['x-forwarded-host'] || req.headers.host || ''; return h ? 'https://' + h : ''; };
const gasCaller = req => async (name, args, ctx) => JSON.parse(await viaGas(name, { args: args || [], ctx: ctx || {} }, req));
/** keep sending LINE / phone notifications after the answer went out */
function later(p) {
  const ctx = globalThis[Symbol.for('@vercel/request-context')], c = ctx && ctx.get && ctx.get();
  if (c && typeof c.waitUntil === 'function') c.waitUntil(p.catch(e => console.error('later', e)));
  else return p;
}
async function viaSb(name, body, req) {
  const out = await SB().call(name, body.args || [], body.ctx || {}, originOf(req), gasCaller(req));
  const w = later(SB().drain()); if (w) await w;
  return out;
}
async function route(name, body, req) { return (await useSb()) ? viaSb(name, body, req) : viaGas(name, body, req); }
const COOKIE = 'hrm_team', DAYS = 30;

/* ---------- team gate ---------- */
const teamCode = () => String(process.env.TEAM_CODE || '').trim();
function sign(exp, kind = 'team') {   // changing TEAM_CODE (or GAS_KEY) signs everyone out and voids every QR
  return crypto.createHmac('sha256', String(process.env.GAS_KEY || '') + '|' + teamCode()).update(kind + ':' + exp).digest('base64url');
}
function validSig(tok, kind) {
  const [exp, sig] = String(tok || '').split('.');
  if (!exp || !sig || !/^\d{10,15}$/.test(exp) || +exp < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp, kind));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readCookie(req) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function signedIn(req) {
  if (!teamCode()) return true;   // gate off until TEAM_CODE is set
  return validSig(readCookie(req), 'team');
}
function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}
async function teamLogin(req, res, body) {
  const code = teamCode(), given = String(body.code || '').trim();
  if (!code) return res.status(200).send(JSON.stringify({ ok: true, data: { gate: false } }));
  if (body.join) {   // QR "เข้าได้เลย": signed invite instead of the code
    if (!validSig(body.join, 'invite')) return res.status(200).send(JSON.stringify({ ok: false, error: 'QR นี้หมดอายุหรือถูกยกเลิกแล้ว — ขอ QR ใหม่จาก Officer หรือใส่รหัสทีม' }));
    const exp = Date.now() + DAYS * 864e5;
    setCookie(res, exp + '.' + sign(exp), DAYS * 86400);
    return res.status(200).send(JSON.stringify({ ok: true, data: { gate: true, days: DAYS } }));
  }
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(code).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) {
    await new Promise(r => setTimeout(r, 1200));   // slow down guessing
    return res.status(200).send(JSON.stringify({ ok: false, error: 'รหัสทีมไม่ถูกต้อง' }));
  }
  const exp = Date.now() + DAYS * 864e5;
  setCookie(res, exp + '.' + sign(exp), DAYS * 86400);
  return res.status(200).send(JSON.stringify({ ok: true, data: { gate: true, days: DAYS } }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const special = String(req.query.name || '');
  if (special === '_sb') return sbTools(req, res);
  if (special === '_file') return sbFile(req, res);
  if (special === '_line') return lineHook(req, res);
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ ok: false, error: 'POST only' }));
  const name = String(req.query.name || '');
  if (!NAME_RE.test(name)) return res.status(400).send(JSON.stringify({ ok: false, error: 'unknown method' }));
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (name === 'team_login') return teamLogin(req, res, body);
  if (name === 'push_send') return pushSend(req, res, body);   // Apps Script → phones (key-protected, no cookie)
  if (name === 'team_logout') { setCookie(res, '', 0); return res.status(200).send(JSON.stringify({ ok: true, data: true })); }
  const internal = sameKey(req.headers['x-hrm-internal']);   // the Excel export function asks for month data this way
  if (!internal && !signedIn(req)) return res.status(200).send(JSON.stringify({ ok: false, need_login: true, error: 'กรุณาใส่รหัสทีม' }));
  if (name === 'team_invite') return teamInvite(req, res, body);
  if (name === 'push_key') return res.status(200).send(JSON.stringify(vapid() ? { ok: true, data: vapid().pub } : { ok: false, error: 'ยังไม่ได้ตั้ง GAS_KEY' }));
  if (name === 'push_test') return pushTest(req, res, body);
  try {
    return res.status(200).send(await route(name, body, req));
  } catch (e) {
    console.error(name, e);
    return res.status(502).send(JSON.stringify({ ok: false, error: 'เชื่อมต่อฐานข้อมูลไม่ได้ — ลองใหม่อีกครั้ง' }));
  }
};

/* ---------- Supabase move tools (Officer) · tick ---------- */
const send = (res, o, code) => res.status(code || 200).send(JSON.stringify(o));
async function readBody(req) {
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b || {};
}
async function sbTools(req, res) {
  const job = String(req.query.job || '');
  if (job === 'tick') {   // pg_cron every 5 min (x-hrm-cron) · Vercel cron daily (Authorization: Bearer CRON_SECRET)
    const cron = req.headers['x-hrm-cron'], auth = String(req.headers.authorization || '');
    if (!sbOn()) return send(res, { ok: true, data: 'not configured' });
    const okVercel = process.env.CRON_SECRET ? auth === 'Bearer ' + process.env.CRON_SECRET : !!req.headers['x-vercel-cron'];
    if (!okVercel && !(await SB().cronKeyOk(cron))) return send(res, { ok: false, error: 'forbidden' }, 403);
    if (!(await useSb())) return send(res, { ok: true, data: 'google is live' });
    const out = { ran: [] };
    try {
      const f = await SB().flags(true);
      if (!f.core_checked || Date.now() - Date.parse(f.core_checked) > 30 * 60e3) {
        await SB().setFlag('core_checked', new Date().toISOString());
        try { out.core = await SB().pullCore(gasCaller(req)); } catch (e) { out.core = { error: e.message }; }
      }
      out.ran = await SB().tick(gasCaller(req));
      await SB().drain();
    } catch (e) { console.error('tick', e); out.error = e.message; }
    return send(res, { ok: true, data: out });
  }
  if (req.method !== 'POST') return send(res, { ok: false, error: 'POST only' }, 405);
  if (!signedIn(req)) return send(res, { ok: false, need_login: true, error: 'กรุณาใส่รหัสทีม' });
  const body = await readBody(req), ctx = body.ctx || {};
  const info = JSON.parse(await route('app_info', { args: [], ctx }, req));
  if (!info.ok || !info.data || info.data.role !== 'officer') return send(res, { ok: false, error: 'เฉพาะ Officer เท่านั้น' });
  if (!sbOn()) return send(res, { ok: true, data: { configured: false } });
  const gas = gasCaller(req), S = SB();
  try {
    if (job === 'status') return send(res, { ok: true, data: Object.assign(await S.status(), { using: (await useSb()) ? 'supabase' : 'google', forced: String(process.env.BACKEND || '').toLowerCase() === 'supabase' }) });
    if (job === 'core') return send(res, { ok: true, data: await S.pullCore(gas) });
    if (job === 'copy') {   // Google → database (can repeat; Google stays the live one)
      if (await useSb()) return send(res, { ok: false, error: 'ใช้ Supabase อยู่แล้ว — คัดลอกทับไม่ได้' });
      const t0 = Date.now(); await S.pullCore(gas);
      const d = await gas('__migration_dump', []); if (!d.ok) throw new Error(d.error);
      const r = await S.importDump(d.data); await S.setFlag('copied_at', new Date().toISOString());
      return send(res, { ok: true, data: Object.assign(r, { ms: Date.now() - t0 }) });
    }
    if (job === 'verify') return send(res, { ok: true, data: await verify(req, ctx) });
    if (job === 'switch') {   // freeze Google → final copy → compare → database becomes the live one
      if (await useSb()) return send(res, { ok: false, error: 'ใช้ Supabase อยู่แล้ว' });
      const t0 = Date.now();
      await S.pullCore(gas);
      const fz = await gas('__migration_freeze', [true]); if (!fz.ok) throw new Error(fz.error);
      try {
        const d = await gas('__migration_dump', []); if (!d.ok) throw new Error(d.error);
        await S.importDump(d.data);
        const v = await verify(req, ctx);
        if (v.diff.length && !body.force) throw Object.assign(new Error('ข้อมูลยังไม่ตรงกัน ' + v.diff.length + ' จุด — ยังใช้ Google ต่อ'), { verify: v });
        await S.setFlag('live', '1'); await S.setFlag('moved_at', new Date().toISOString()); await S.setFlag('frozen', null);
        const cron = await S.setupCron(originOf(req));
        return send(res, { ok: true, data: { live: true, ms: Date.now() - t0, verify: v, cron } });
      } catch (e) {
        await gas('__migration_freeze', [false]).catch(() => { });
        return send(res, { ok: false, error: e.message, data: e.verify || null });
      }
    }
    if (job === 'rollback') {   // database → Google, Google becomes the live one again (nothing saved on Supabase is lost)
      if (!(await useSb())) return send(res, { ok: false, error: 'ยังใช้ Google อยู่' });
      await S.setFlag('frozen', '1');
      try {
        const d = await S.exportDump();
        const r = await gas('__migration_load', [d]); if (!r.ok) throw new Error(r.error);
        await gas('__migration_freeze', [false]);
        await S.setFlag('live', null); await S.setFlag('frozen', null);
        return send(res, { ok: true, data: { live: false, counts: r.data.counts } });
      } catch (e) { await S.setFlag('frozen', null); throw e; }
    }
    if (job === 'cron') return send(res, { ok: true, data: await S.setupCron(originOf(req)) });
    return send(res, { ok: false, error: 'unknown job' });
  } catch (e) {
    console.error('sb tools', job, e);
    return send(res, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
}
/** the same reads on both sides — every answer must match */
async function verify(req, ctx) {
  const m = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 7);
  const L = [['dashboard'], ['stock_list'], ['orders_list'], ['receipts_list', 60], ['materials_list'], ['days_status', m], ['month_get', m],
    ['shop_requests'], ['shop_catalog'], ['documents_list'], ['notes_list'], ['adjust_list', null], ['activity_feed', 14, 40], ['receipt_history', 30], ['spend_summary', null]];
  const norm = t => { const o = JSON.parse(t); return JSON.stringify({ ok: o.ok, data: o.data, error: o.error || null }); };
  const g = await Promise.all(L.map(([n, ...a]) => viaGas(n, { args: a, ctx }, req).then(norm, e => 'ERR ' + e.message)));
  const out = { same: [], diff: [] };
  for (let i = 0; i < L.length; i++) {
    const s = norm(await SB().call(L[i][0], L[i].slice(1), ctx, originOf(req), gasCaller(req)));
    if (s === g[i]) out.same.push(L[i][0]);
    else { const d = firstDiff(safeParse(g[i]), safeParse(s)); out.diff.push(Object.assign({ name: L[i][0] }, d)); }
  }
  return out;
}
const safeParse = t => { try { return JSON.parse(t); } catch (e) { return t; } };
/** where two answers first differ → {path, google, supabase, count} (values cut short) */
function firstDiff(a, b) {
  let first = null, count = 0;
  const show = v => { const t = v === undefined ? 'undefined' : JSON.stringify(v); return t.length > 120 ? t.slice(0, 117) + '…' : t; };
  (function walk(x, y, path) {
    if (count > 200) return;
    if (x === y) return;
    const ox = x && typeof x === 'object', oy = y && typeof y === 'object';
    if (ox && oy && Array.isArray(x) === Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      if (Array.isArray(x) && x.length !== y.length) { count++; if (!first) first = { path: path + '.length', google: show(x.length), supabase: show(y.length) }; }
      for (const k of keys) walk(x[k], y[k], path + (Array.isArray(x) ? '[' + k + ']' : '.' + k));
      return;
    }
    count++; if (!first) first = { path, google: show(x), supabase: show(y) };
  })(a, b, '');
  return Object.assign(first || { path: '?', google: '', supabase: '' }, { count });
}
/** scans saved on Supabase (team cookie) */
async function sbFile(req, res) {
  if (!signedIn(req)) return send(res, { ok: false, need_login: true, error: 'กรุณาใส่รหัสทีม' }, 401);
  const f = sbOn() ? await SB().getFile(String(req.query.id || '')) : null;
  if (!f) return send(res, { ok: false, error: 'ไม่พบไฟล์' }, 404);
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline; filename="' + String(f.name || 'file').replace(/[^\w.-]/g, '_') + '"');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.status(200).send(Buffer.from(f.data));
}
/** LINE webhook (set the LINE console to https://<site>/api/_line after the move) */
async function lineHook(req, res) {
  const body = await readBody(req);
  try {
    if (await useSb()) { await SB().lineHook(body, gasCaller(req)); await SB().drain(); }
    else await fetch(process.env.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  } catch (e) { console.error('line', e); }
  res.setHeader('Content-Type', 'text/plain'); return res.status(200).send('ok');
}

/** Officer: a signed link that signs a phone in without the code (QR) — void when TEAM_CODE changes */
async function teamInvite(req, res, body) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '', base = 'https://' + host + '/';
  if (!teamCode()) return res.status(200).send(JSON.stringify({ ok: true, data: { gate: false, url: base } }));
  const info = JSON.parse(await route('app_info', { args: [], ctx: body.ctx || {} }, req));
  if (!info.ok || !info.data || info.data.role !== 'officer') return res.status(200).send(JSON.stringify({ ok: false, error: 'เฉพาะ Officer เท่านั้นที่สร้าง QR เข้าได้เลย' }));
  const days = Math.max(1, Math.min(365, Math.round(Number((body.args || [])[0]) || 30)));
  const exp = Date.now() + days * 864e5;
  return res.status(200).send(JSON.stringify({ ok: true, data: { gate: true, days, exp, url: base + '?join=' + exp + '.' + sign(exp, 'invite') } }));
}

/* ---------- Web Push ---------- */
let _vapid = null;
/** VAPID key pair derived from GAS_KEY (no extra setup) — changing GAS_KEY means phones turn notifications on again */
function vapid() {
  const seed = String(process.env.GAS_KEY || '');
  if (!seed) return null;
  if (_vapid && _vapid.seed === seed) return _vapid;
  for (let i = 0; i < 16; i++) {
    const d = Buffer.from(crypto.hkdfSync('sha256', seed, 'hrm-stock', 'vapid-' + i, 32));
    try {
      const ec = crypto.createECDH('prime256v1'); ec.setPrivateKey(d);
      _vapid = { seed, priv: d.toString('base64url'), pub: ec.getPublicKey().toString('base64url') };
      return _vapid;
    } catch (e) { /* out of range — next counter */ }
  }
  return null;
}
function sameKey(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest(), b = crypto.createHash('sha256').update(String(process.env.GAS_KEY || '')).digest();
  return !!process.env.GAS_KEY && crypto.timingSafeEqual(a, b);
}
function cleanSub(s) {
  s = s || {}; const k = s.keys || {};
  if (!/^https:\/\/[\w.-]+\//.test(String(s.endpoint || '')) || !k.p256dh || !k.auth) return null;
  return { endpoint: String(s.endpoint), keys: { p256dh: String(k.p256dh), auth: String(k.auth) } };
}
async function sendAll(req, subs, msg) {
  const v = vapid(); if (!webpush || !v) throw new Error('web-push not ready');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'hrm-stock.vercel.app';
  const opts = { TTL: 4 * 3600, urgency: 'high', vapidDetails: { subject: 'https://' + host, publicKey: v.pub, privateKey: v.priv } };
  const payload = JSON.stringify({ title: String(msg.title || 'HRM STOCK').slice(0, 120), body: String(msg.body || '').slice(0, 400), url: String(msg.url || '/').slice(0, 200), tag: String(msg.tag || 'hrm').slice(0, 60) });
  let sent = 0; const gone = [];
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification(s, payload, opts); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); else console.error('push', e.statusCode, String(e.body || e.message).slice(0, 200)); }
  }));
  return { sent, gone };
}
async function pushSend(req, res, body) {
  if (!sameKey(body.key)) return res.status(403).send(JSON.stringify({ ok: false, error: 'forbidden' }));
  const subs = (Array.isArray(body.subs) ? body.subs : []).slice(0, 500).map(cleanSub).filter(Boolean);
  try { return res.status(200).send(JSON.stringify({ ok: true, data: await sendAll(req, subs, body.msg || {}) })); }
  catch (e) { return res.status(200).send(JSON.stringify({ ok: false, error: e.message })); }
}
async function pushTest(req, res, body) {
  const s = cleanSub((body.args || [])[0]);
  if (!s) return res.status(200).send(JSON.stringify({ ok: false, error: 'เครื่องนี้ยังไม่ได้เปิดแจ้งเตือน' }));
  try {
    const r = await sendAll(req, [s], { title: 'HRM STOCK · ทดสอบแจ้งเตือน', body: 'เครื่องนี้จะได้รับการเตือนเมื่อกะเช้ายังไม่ลง STOCK', url: '/', tag: 'hrm-test' });
    return res.status(200).send(JSON.stringify(r.sent ? { ok: true, data: true } : { ok: false, error: 'ส่งไม่สำเร็จ — ลองปิดแล้วเปิดแจ้งเตือนใหม่' }));
  } catch (e) { return res.status(200).send(JSON.stringify({ ok: false, error: e.message })); }
}

async function viaGas(name, body, req) {
  const url = process.env.GAS_URL, key = process.env.GAS_KEY;
  if (!url || !/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return JSON.stringify({ ok: false, error: 'ยังไม่ได้ตั้ง GAS_URL (ลิงก์ …/exec) ใน Vercel → Settings → Environment Variables' });
  if (!key) return JSON.stringify({ ok: false, error: 'ยังไม่ได้ตั้ง GAS_KEY ใน Vercel → Settings → Environment Variables' });
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const payload = { hrm: 'api', key, name, args: Array.isArray(body.args) ? body.args : [], ctx: body.ctx || {}, origin: host ? 'https://' + host : '' };
  // Apps Script answers POST with a 302 to googleusercontent.com — fetch follows it (as GET), which is what Google expects
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
  const text = await r.text();
  if (!r.ok || text.charAt(0) !== '{') {
    console.error('GAS', r.status, text.slice(0, 300));
    return JSON.stringify({ ok: false, error: r.status === 404 ? 'ไม่พบเว็บแอป Google — ตรวจ GAS_URL' : 'Google ตอบกลับผิดปกติ (' + r.status + ') — ตรวจว่า Deploy เป็น "ทุกคน" และเป็นเวอร์ชันล่าสุด' });
  }
  return text;
}
