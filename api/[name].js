/* HRM STOCK · Vercel API proxy
   Browser → POST /api/<name> {args, ctx} → backend → {ok, data, error, ctx}
   BACKEND=gas      : forwards to the Google Apps Script web app (GAS_URL) with the shared key (GAS_KEY = Script Property WEB_KEY)
   BACKEND=supabase : planned (phase 2) */
const NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).send(JSON.stringify({ ok: false, error: 'POST only' }));
  const name = String(req.query.name || '');
  if (!NAME_RE.test(name)) return res.status(400).send(JSON.stringify({ ok: false, error: 'unknown method' }));
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const backend = (process.env.BACKEND || 'gas').toLowerCase();
  try {
    if (backend === 'gas') return res.status(200).send(await viaGas(name, body, req));
    return res.status(200).send(JSON.stringify({ ok: false, error: 'BACKEND "' + backend + '" ยังไม่รองรับ — ตั้ง BACKEND=gas' }));
  } catch (e) {
    console.error(name, e);
    return res.status(502).send(JSON.stringify({ ok: false, error: 'เชื่อมต่อ Google ไม่ได้ — ลองใหม่อีกครั้ง' }));
  }
};

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
