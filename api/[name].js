/* HRM STOCK · Vercel API proxy
   Browser → POST /api/<name> {args, ctx} → backend → {ok, data, error, ctx}
   BACKEND=gas      : forwards to the Google Apps Script web app (GAS_URL) with the shared key (GAS_KEY = Script Property WEB_KEY)
   BACKEND=supabase : planned (phase 2)
   TEAM_CODE        : team password — every data call needs the signed cookie from POST /api/team_login (30 days) */
const crypto = require('crypto');
const NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;
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
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ ok: false, error: 'POST only' }));
  const name = String(req.query.name || '');
  if (!NAME_RE.test(name)) return res.status(400).send(JSON.stringify({ ok: false, error: 'unknown method' }));
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (name === 'team_login') return teamLogin(req, res, body);
  if (name === 'team_logout') { setCookie(res, '', 0); return res.status(200).send(JSON.stringify({ ok: true, data: true })); }
  if (!signedIn(req)) return res.status(200).send(JSON.stringify({ ok: false, need_login: true, error: 'กรุณาใส่รหัสทีม' }));
  if (name === 'team_invite') return teamInvite(req, res, body);
  const backend = (process.env.BACKEND || 'gas').toLowerCase();
  try {
    if (backend === 'gas') return res.status(200).send(await viaGas(name, body, req));
    return res.status(200).send(JSON.stringify({ ok: false, error: 'BACKEND "' + backend + '" ยังไม่รองรับ — ตั้ง BACKEND=gas' }));
  } catch (e) {
    console.error(name, e);
    return res.status(502).send(JSON.stringify({ ok: false, error: 'เชื่อมต่อ Google ไม่ได้ — ลองใหม่อีกครั้ง' }));
  }
};

/** Officer: a signed link that signs a phone in without the code (QR) — void when TEAM_CODE changes */
async function teamInvite(req, res, body) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '', base = 'https://' + host + '/';
  if (!teamCode()) return res.status(200).send(JSON.stringify({ ok: true, data: { gate: false, url: base } }));
  const info = JSON.parse(await viaGas('app_info', { args: [], ctx: body.ctx || {} }, req));
  if (!info.ok || !info.data || info.data.role !== 'officer') return res.status(200).send(JSON.stringify({ ok: false, error: 'เฉพาะ Officer เท่านั้นที่สร้าง QR เข้าได้เลย' }));
  const days = Math.max(1, Math.min(365, Math.round(Number((body.args || [])[0]) || 30)));
  const exp = Date.now() + days * 864e5;
  return res.status(200).send(JSON.stringify({ ok: true, data: { gate: true, days, exp, url: base + '?join=' + exp + '.' + sign(exp, 'invite') } }));
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
