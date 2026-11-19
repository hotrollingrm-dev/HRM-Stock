/* HRM STOCK · Supabase (Postgres) backend
   Runs the very same backend code as Google Apps Script (Code.gs) — the code is fetched from the Apps Script project
   (__core_source) and kept in the database, so the business logic never lives in this public repo.
   Google services are replaced by small stand-ins:
     Sheets      → hrm.chunk  (each tab stored as blocks of 400 rows · JSON) — only changed blocks are written
     Properties  → hrm.prop   · Cache → memory (+ hrm.prop for once-a-day guards) · Lock → one Postgres advisory lock
     Drive       → hrm.file (scans) / hrm.backup (whole-database copies, gzip) · UrlFetch POST → sent after the save
     Triggers    → hrm.prop list, run by /api/_sb?job=tick (pg_cron every 5 min, Vercel cron daily as back-up)
   Every request: load what changed since last time (one query) → run the call → if anything changed: lock, check nobody
   else saved in between (else reload and run again), write the changed blocks, commit. */
'use strict';
const vm = require('vm'), crypto = require('crypto'), zlib = require('zlib');

const CHUNK = 400;
const TZ_MS = 7 * 3600e3;                       // Asia/Bangkok, no daylight saving
const LOCK_ID = 733101;
const INTERNAL = '\u0001';                      // props only this runtime uses (cache guards, triggers) — hidden from getProperties()
const MEM_CACHE = /^(T\d+:|O\d+)/;              // table / result caches stay in memory (they are keyed by rev anyway)

const SCHEMA_SQL = `
create schema if not exists hrm;
create table if not exists hrm.head (id int primary key, ver bigint not null);
insert into hrm.head values (1, 0) on conflict do nothing;
create table if not exists hrm.chunk (sheet text not null, chunk int not null, ver bigint not null, data jsonb, primary key (sheet, chunk));
create index if not exists chunk_ver on hrm.chunk (ver);
create table if not exists hrm.prop (k text primary key, v text, ver bigint not null);
create index if not exists prop_ver on hrm.prop (ver);
create table if not exists hrm.file (id text primary key, name text, mime text, size int, data bytea, created_at timestamptz default now());
create table if not exists hrm.backup (id text primary key, name text, size int, created_at timestamptz default now(), trashed boolean default false, data bytea);
create table if not exists hrm.core (id int primary key, v text, b64 text, at timestamptz default now());
create table if not exists hrm.flag (k text primary key, v text, at timestamptz default now());
revoke all on schema hrm from public;
`;

/* ---------------------------------------------------------------- database */
let _sql = null, _schema = false;
function db() {
  if (_sql) return _sql;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('ยังไม่ได้ตั้ง SUPABASE_DB_URL ใน Vercel');
  const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
  _sql = require('postgres')(url, { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 15, ssl: local ? false : 'require', onnotice: () => { } });
  return _sql;
}
/** tables made once (several instances may start together → one at a time under a lock) */
function ensureSchema() {
  if (!_schema) _schema = (async () => {
    const [r] = await db()`select to_regclass('hrm.flag') as t`;
    if (r && r.t) return;
    await db().begin(async tx => { await tx`select pg_advisory_xact_lock(733102)`; await tx.unsafe(SCHEMA_SQL); });
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}
const configured = () => !!process.env.SUPABASE_DB_URL;

/* ---------------------------------------------------------------- in-memory copy of the data */
const S = {
  ver: -1,                 // hrm.head.ver this copy matches
  sheets: new Map(),       // name → { d: rows[][], n: blocks stored }
  props: new Map(),
  coreV: null,
  backups: null,           // prefetched list (backup calls only)
  snaps: new Map(),        // prefetched backup contents (restore)
};
function invalidate() { S.ver = -1; S.sheets.clear(); S.props.clear(); }

/** changes since S.ver — one statement, so it is one consistent snapshot */
async function sync(conn) {
  const q = conn || db();
  const [r] = await q`select (select ver from hrm.head where id = 1) as head,
    (select coalesce(json_agg(json_build_array(sheet, chunk, data) order by sheet, chunk), '[]'::json) from hrm.chunk where ver > ${S.ver}) as chunks,
    (select coalesce(json_agg(json_build_array(k, v)), '[]'::json) from hrm.prop where ver > ${S.ver}) as props,
    (select v from hrm.core where id = 1) as core_v`;
  const head = Number(r.head);
  if (S.ver === -1) { S.sheets.clear(); S.props.clear(); }
  const touched = new Map();
  for (const [name, chunk, data] of r.chunks) { if (!touched.has(name)) touched.set(name, []); touched.get(name).push([chunk, data]); }
  for (const [name, list] of touched) {
    let sh = S.sheets.get(name);
    for (const [c, data] of list) {
      if (c === 0 && data === null) { sh = null; S.sheets.delete(name); continue; }
      if (!sh) { sh = { d: [], n: 0 }; S.sheets.set(name, sh); }
      if (data === null) { if (sh.d.length > c * CHUNK) sh.d.length = c * CHUNK; sh.n = Math.min(sh.n, c); continue; }
      for (let i = 0; i < data.length; i++) sh.d[c * CHUNK + i] = data[i] || [];
      if (data.length < CHUNK) sh.d.length = c * CHUNK + data.length;
      sh.n = Math.max(sh.n, c + 1);
      if (data.length < CHUNK) sh.n = c + 1;
    }
  }
  for (const [k, v] of r.props) { if (v === null) S.props.delete(k); else S.props.set(k, v); }
  S.ver = head; S.coreV = r.core_v || null;
}

/* ---------------------------------------------------------------- what one call changed */
const T = {
  sheets: new Map(),   // name → Set(block) | 'all'
  dropped: new Set(), props: new Set(), files: [], backups: [], trash: [], out: [],
  begin() { this.sheets.clear(); this.dropped.clear(); this.props.clear(); this.files = []; this.backups = []; this.trash = []; this.out = []; },
  dirty() { return this.sheets.size || this.dropped.size || this.props.size || this.files.length || this.backups.length || this.trash.length; },
  mark(name, fromRow, toRow) {
    if (this.sheets.get(name) === 'all') return;
    if (toRow === undefined) { this.sheets.set(name, 'all'); return; }
    let s = this.sheets.get(name); if (!s) this.sheets.set(name, s = new Set());
    for (let c = Math.floor(fromRow / CHUNK); c <= Math.floor(Math.max(fromRow, toRow) / CHUNK); c++) s.add(c);
  },
};

async function writeDirty(tx) {
  const [h] = await tx`update hrm.head set ver = ver + 1 where id = 1 returning ver`;
  const ver = Number(h.ver), rows = [];
  for (const name of T.dropped) { if (!S.sheets.has(name)) rows.push([name, 0, null]); }
  for (const [name, set] of T.sheets) {
    const sh = S.sheets.get(name); if (!sh) continue;
    trimSheet(sh.d);
    const n = Math.max(1, Math.ceil(sh.d.length / CHUNK));
    const blocks = new Set(set === 'all' ? Array.from({ length: n }, (_, i) => i) : set);
    if (n !== sh.n) blocks.add(n - 1);                        // carries the new length
    for (const c of blocks) if (c < n) rows.push([name, c, sh.d.slice(c * CHUNK, (c + 1) * CHUNK).map(cleanRow)]);
    for (let c = n; c < sh.n; c++) rows.push([name, c, null]);  // blocks past the new end
    sh.nNext = n;
  }
  if (rows.length) await tx`insert into hrm.chunk (sheet, chunk, ver, data)
      select x->>0, (x->>1)::int, ${ver}, x->2 from json_array_elements(${tx.json(rows)}::json) x
      on conflict (sheet, chunk) do update set ver = excluded.ver, data = excluded.data`;
  const props = [...T.props].map(k => [k, S.props.has(k) ? S.props.get(k) : null]);
  if (props.length) await tx`insert into hrm.prop (k, v, ver)
      select x->>0, x->>1, ${ver} from json_array_elements(${tx.json(props)}::json) x
      on conflict (k) do update set v = excluded.v, ver = excluded.ver`;
  for (const f of T.files) await tx`insert into hrm.file (id, name, mime, size, data) values (${f.id}, ${f.name}, ${f.mime}, ${f.data.length}, ${f.data})`;
  for (const b of T.backups) await tx`insert into hrm.backup (id, name, size, data) values (${b.id}, ${b.name}, ${b.data.length}, ${b.data})`;
  for (const id of T.trash) await tx`update hrm.backup set trashed = true, data = null where id = ${id}`;
  return ver;
}
function afterWrite(ver) {
  for (const [name] of T.sheets) { const sh = S.sheets.get(name); if (sh && sh.nNext !== undefined) { sh.n = sh.nNext; delete sh.nNext; } }
  S.ver = ver;
}
const cleanRow = r => Array.isArray(r) ? r.map(v => v === undefined ? '' : v) : [];
function trimSheet(d) { while (d.length && !(d[d.length - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) d.pop(); }

/* ---------------------------------------------------------------- Apps Script stand-ins */
const pad = n => String(n).padStart(2, '0');
function fmtDate(d, f) {
  const t = new Date((d instanceof Date ? d : new Date(d)).getTime() + TZ_MS);
  const map = { yyyy: t.getUTCFullYear(), MM: pad(t.getUTCMonth() + 1), dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()), mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds()) };
  return String(f).replace(/yyyy|MM|dd|HH|mm|ss/g, k => map[k]);
}
function cellIn(v) {   // what Google Sheets would keep
  if (v instanceof Date) return fmtDate(v, 'yyyy-MM-dd HH:mm:ss');
  if (typeof v === 'string' && v.charAt(0) === "'") return v.slice(1);
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' && !isFinite(v)) return '';
  return v;
}
const bytesOf = b => typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from((b || []).map(x => x & 255));
const chain = o => new Proxy(o, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' ? () => chain(t) : undefined) });

class Range {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr || 1; this.nc = nc || 1; }
  getValues() {
    const d = this.sh.data(), o = [];
    for (let i = 0; i < this.nr; i++) { const row = d[this.r - 1 + i] || [], x = []; for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; x.push(v === undefined || v === null ? '' : v); } o.push(x); }
    return o;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(String)); }
  getValue() { return this.getValues()[0][0]; }
  setValues(v) {
    const d = this.sh.data(true);
    v.forEach((row, i) => { const R = this.r - 1 + i; while (d.length <= R) d.push([]); if (!d[R]) d[R] = []; row.forEach((x, j) => { d[R][this.c - 1 + j] = cellIn(x); }); });
    T.mark(this.sh.name, this.r - 1, this.r - 2 + v.length);
    return chain(this);
  }
  setValue(x) { return this.setValues([[x]]); }
  clearContent() {
    const d = this.sh.data(true);
    for (let i = 0; i < this.nr; i++) { const row = d[this.r - 1 + i]; if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = ''; }
    T.mark(this.sh.name, this.r - 1, this.r - 2 + this.nr);
    return chain(this);
  }
  getRow() { return this.r; } getColumn() { return this.c; } getNumRows() { return this.nr; } getNumColumns() { return this.nc; }
}
class Sheet {
  constructor(name, ro) { this.name = name; this.ro = ro || null; }
  data(write) {
    if (this.ro) { if (write) throw new Error('backup copy is read-only'); return this.ro; }
    const s = S.sheets.get(this.name); if (!s) throw new Error('sheet gone: ' + this.name); return s.d;
  }
  getName() { return this.name; }
  getLastRow() { const d = this.data(); let n = d.length; while (n && !(d[n - 1] || []).some(v => v !== '' && v !== undefined && v !== null)) n--; return n; }
  getLastColumn() { let m = 0; for (const r of this.data()) { if (!r) continue; let k = r.length; while (k && (r[k - 1] === '' || r[k - 1] == null)) k--; if (k > m) m = k; } return m; }
  getMaxRows() { return Math.max(1000, this.data().length); } getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') { const m = r.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); const col = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
      if (!m) return chain(new Range(this, 1, 1, 1, 1)); const c1 = col(m[1]), r1 = +m[2]; return chain(new Range(this, r1, c1, m[4] ? +m[4] - r1 + 1 : 1, m[3] ? col(m[3]) - c1 + 1 : 1)); }
    return chain(new Range(this, r, c, nr, nc));
  }
  getDataRange() { return chain(new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()))); }
  appendRow(v) { const d = this.data(true); const at = this.getLastRow(); d.length = at; d.push(v.map(cellIn)); T.mark(this.name, at, at); return chain(this); }
  deleteRow(r) { const d = this.data(true); d.splice(r - 1, 1); T.mark(this.name, r - 1, Math.max(r - 1, d.length)); return chain(this); }
  deleteRows(r, n) { const d = this.data(true); d.splice(r - 1, n); T.mark(this.name, r - 1, Math.max(r - 1, d.length)); return chain(this); }
  clearContents() { const d = this.data(true); d.length = 0; T.mark(this.name); return chain(this); }
  clear() { return this.clearContents(); }
  getSheetId() { return this.name; }
}
const SSID = 'SB';
function makeSS(ro) {   // ro: {name: rows} → a read-only backup copy
  return chain({
    getId: () => ro ? ro.__id : SSID, getName: () => ro ? ro.__name : 'HRM Stock · Supabase', getUrl: () => '',
    getSheetByName(n) { if (ro) return ro.sheets[n] ? chain(new Sheet(n, ro.sheets[n])) : null; return S.sheets.has(n) ? chain(new Sheet(n)) : null; },
    getSheets() { return ro ? Object.keys(ro.sheets).map(n => chain(new Sheet(n, ro.sheets[n]))) : [...S.sheets.keys()].map(n => chain(new Sheet(n))); },
    insertSheet(n) { if (ro) throw new Error('read-only'); if (!S.sheets.has(n)) { S.sheets.set(n, { d: [], n: 0 }); T.dropped.delete(n); T.mark(n); } return chain(new Sheet(n)); },
    deleteSheet(sh) { if (ro) return; const n = sh.getName(); S.sheets.delete(n); T.sheets.delete(n); T.dropped.add(n); },
  });
}
function snapshotNow() {   // the whole database as it is at this moment (for Drive "makeCopy")
  const sheets = {}; for (const [n, s] of S.sheets) sheets[n] = s.d.map(cleanRow);
  return zlib.gzipSync(JSON.stringify({ sheets, at: fmtDate(new Date(), 'yyyy-MM-dd HH:mm:ss') }));
}

/* props */
function setProp(k, v) { k = String(k); if (v === null || v === undefined) S.props.delete(k); else S.props.set(k, String(v)); T.props.add(k); }
const Props = {
  getProperty: k => S.props.has(String(k)) ? S.props.get(String(k)) : null,
  setProperty(k, v) { setProp(k, v); return Props; },
  deleteProperty(k) { setProp(k, null); return Props; },
  getProperties() { const o = {}; for (const [k, v] of S.props) if (k.charAt(0) !== INTERNAL) o[k] = v; return o; },
  setProperties(o) { Object.keys(o || {}).forEach(k => setProp(k, o[k])); return Props; },
  getKeys() { return Object.keys(Props.getProperties()); },
};
/* cache: memory, plus once-a-day guards kept in hrm.prop so every Vercel instance agrees */
const memCache = new Map();
const Cache = {
  get(k) {
    k = String(k);
    if (!MEM_CACHE.test(k) && S.props.has(INTERNAL + 'C:' + k)) { try { const o = JSON.parse(S.props.get(INTERNAL + 'C:' + k)); if (o.e > Date.now()) return o.v; } catch (e) { } return null; }
    const o = memCache.get(k); if (!o) return null; if (o.e < Date.now()) { memCache.delete(k); return null; } return o.v;
  },
  put(k, v, ttl) {
    k = String(k); const e = Date.now() + 1000 * Math.min(21600, Number(ttl) || 600);
    if (MEM_CACHE.test(k)) { memCache.set(k, { v: String(v), e }); if (memCache.size > 3000) memCache.delete(memCache.keys().next().value); }
    else setProp(INTERNAL + 'C:' + k, JSON.stringify({ v: String(v), e }));
  },
  remove(k) { k = String(k); memCache.delete(k); if (S.props.has(INTERNAL + 'C:' + k)) setProp(INTERNAL + 'C:' + k, null); },
  getAll(ks) { const o = {}; ks.forEach(k => { const v = Cache.get(k); if (v !== null) o[k] = v; }); return o; },
  putAll(o, ttl) { Object.keys(o).forEach(k => Cache.put(k, o[k], ttl)); },
  removeAll(ks) { ks.forEach(k => Cache.remove(k)); },
};
/* triggers: kept as a list in hrm.prop, run by tick() */
function trigList() { try { return JSON.parse(Props.getProperty(INTERNAL + 'TRIG') || '[]'); } catch (e) { return []; } }
function trigSave(L) { setProp(INTERNAL + 'TRIG', JSON.stringify(L)); }
const trigObj = t => ({ getHandlerFunction: () => t.fn, getUniqueId: () => t.id, getEventType: () => 'CLOCK', getTriggerSource: () => 'CLOCK' });
const ScriptAppShim = {
  getProjectTriggers: () => trigList().map(trigObj),
  deleteTrigger(t) { const id = t.getUniqueId(); trigSave(trigList().filter(x => x.id !== id)); },
  newTrigger(fn) {
    const t = { id: crypto.randomUUID(), fn: String(fn), min: null, hour: null };
    const b = chain({ timeBased: () => b, everyMinutes: n => { t.min = Math.max(5, +n || 5); return b; }, everyHours: n => { t.min = 60 * (+n || 1); return b; },
      everyDays: () => { if (t.hour === null) t.hour = 0; return b; }, atHour: h => { t.hour = +h || 0; return b; }, nearMinute: () => b, inTimezone: () => b,
      create: () => { const L = trigList(); L.push(t); trigSave(L); return trigObj(t); } });
    return b;
  },
  getService: () => ({ getUrl: () => Props.getProperty('APP_URL') || '' }),
  getOAuthToken: () => '',
};
/* Drive: scans → hrm.file · whole-database copies → hrm.backup */
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
function folderObj(kind) {
  return chain({
    getId: () => 'sbd_' + kind, getName: () => 'HRM Stock - ' + kind, getUrl: () => '', isTrashed: () => false,
    createFile(blob) {
      const id = 'sbf_' + crypto.randomUUID().replace(/-/g, '');
      const f = { id, name: blob.name || 'file', mime: blob.mime || 'application/octet-stream', data: Buffer.from(blob.bytes || []) };
      T.files.push(f); return fileObj(f.id, f.name, f.mime, f.data.length, new Date());
    },
    getFiles() {
      if (kind !== 'Backup') return iter([]);
      const L = (S.backups || []).filter(b => !b.trashed && T.trash.indexOf(b.id) < 0).map(b => backupObj(b))
        .concat(T.backups.map(b => backupObj({ id: b.id, name: b.name, size: b.data.length, created_at: b.at })));
      return iter(L);
    },
  });
}
const iter = L => { let i = 0; return { hasNext: () => i < L.length, next: () => L[i++] }; };
const fileObj = (id, name, mime, size, at) => chain({ getId: () => id, getName: () => name, getMimeType: () => mime, getSize: () => size, getDateCreated: () => at,
  getUrl: () => (Props.getProperty('APP_URL') || '') + '/api/_file?id=' + id, setSharing: () => { }, setTrashed: () => { } });
const backupObj = b => chain({ getId: () => b.id, getName: () => b.name, getMimeType: () => MIME_SHEET, getSize: () => b.size || 0,
  getDateCreated: () => new Date(b.created_at), getUrl: () => '', setTrashed(x) { if (x) T.trash.push(b.id); } });
const DriveShim = {
  Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
  createFolder: name => folderObj(String(name).replace(/^HRM Stock - /, '')),
  getFolderById(id) { if (/^sbd_/.test(String(id))) return folderObj(String(id).slice(4)); throw new Error('no folder'); },
  getFileById(id) {
    id = String(id);
    if (id === SSID) return chain({ getId: () => SSID, getName: () => 'HRM Stock · Supabase', getUrl: () => '', getMimeType: () => MIME_SHEET,
      makeCopy(name) { const b = { id: 'sbb_' + crypto.randomUUID().replace(/-/g, ''), name: String(name), data: snapshotNow(), at: new Date() }; T.backups.push(b); return backupObj({ id: b.id, name: b.name, size: b.data.length, created_at: b.at }); } });
    const b = (S.backups || []).find(x => x.id === id); if (b) return backupObj(b);
    throw new Error('ไม่พบไฟล์');
  },
};
/* UrlFetch: POSTs (LINE, phone notifications) are sent after the save; GETs answer from the last result */
function fetchShim(url, opt) {
  opt = opt || {}; const method = String(opt.method || 'get').toLowerCase();
  if (method !== 'get') { T.out.push({ url: String(url), method: method.toUpperCase(), headers: Object.assign({}, opt.headers || {}, opt.contentType ? { 'Content-Type': opt.contentType } : {}), body: opt.payload }); return resp(200, '{}'); }
  const key = INTERNAL + 'U:' + String(url).slice(0, 180); T.out.push({ url: String(url), method: 'GET', headers: opt.headers || {}, keep: key });
  try { const o = JSON.parse(Props.getProperty(key) || 'null'); if (o) return resp(o.code, o.text); } catch (e) { }
  return resp(200, '{}');
}
const resp = (code, text) => ({ getResponseCode: () => code, getContentText: () => text, getBlob: () => ({ getBytes: () => [...Buffer.from(text)], setName() { return this; } }), getHeaders: () => ({}) });

/* ---------------------------------------------------------------- the backend code (Code.gs) */
const OVERRIDES = `
Api.prototype.open_folder = function () { throw new ApiError('ข้อมูลอยู่ในฐานข้อมูล Supabase แล้ว — สำรองข้อมูล / กู้คืนได้ที่ ตั้งค่า › สำรอง & กู้คืน'); };
(function () {
  const so = Api.prototype.scan_open;
  if (so) Api.prototype.scan_open = function (did) {
    const r = so.call(this, did), d = this.st().find('document', x => x.id === did), id = String(d && d.scan_file || '').split('|')[0];
    if (id.indexOf('sbf_') === 0) r.url = (PropertiesService.getScriptProperties().getProperty('APP_URL') || '') + '/api/_file?id=' + encodeURIComponent(id);
    return r;
  };
  const ai = Api.prototype.app_info;
  if (ai) Api.prototype.app_info = function () { const r = ai.apply(this, arguments); if (r && typeof r === 'object') { r.backend = 'supabase'; r.gas = false; r.data_dir = 'Supabase'; r.data_url = ''; } return r; };
  ['export_excel', 'export_pdf'].forEach(n => { if (Api.prototype[n]) Api.prototype[n] = function () { throw new ApiError('บนเว็บใช้ปุ่มดาวน์โหลด Excel / พิมพ์ PDF ได้ตามปกติ'); }; });
})();
function __pushForget(eps) {
  const sh = pushSheet_();
  pushRows_().filter(r => eps.indexOf(r.endpoint) >= 0).sort((a, b) => b.row - a.row).forEach(r => sh.deleteRow(r.row));
  return true;
}
`;
let G = null;   // { v, ctx }
function buildContext(src, v) {
  const SS = makeSS();
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError, Set, Map, WeakMap, Symbol, Promise,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, escape, unescape, Intl, BigInt,
    SpreadsheetApp: chain({ getActiveSpreadsheet: () => SS, openById: id => String(id) === SSID ? SS : (S.snaps.get(String(id)) ? makeSS(S.snaps.get(String(id))) : (() => { throw new Error('ไม่พบไฟล์สำรองข้อมูล'); })()),
      flush() { }, create() { throw new Error('ใช้ไม่ได้บน Supabase'); }, CopyPasteType: {} }),
    PropertiesService: { getScriptProperties: () => Props, getUserProperties: () => Props, getDocumentProperties: () => Props },
    CacheService: { getScriptCache: () => Cache, getUserCache: () => Cache, getDocumentCache: () => Cache },
    LockService: { getScriptLock: () => ({ waitLock() { }, tryLock: () => true, releaseLock() { }, hasLock: () => true }), getUserLock: () => ({ waitLock() { }, tryLock: () => true, releaseLock() { } }) },
    Utilities: {
      formatDate: (d, tz, f) => fmtDate(d, f), getUuid: () => crypto.randomUUID(), sleep() { },
      computeHmacSha256Signature: (v, k) => [...crypto.createHmac('sha256', Buffer.from(Array.isArray(k) ? k : String(k))).update(Array.isArray(v) ? Buffer.from(v) : String(v)).digest()].map(b => b > 127 ? b - 256 : b),
      computeDigest: (alg, v) => [...crypto.createHash(alg === 'md5' ? 'md5' : 'sha256').update(typeof v === 'string' ? v : bytesOf(v)).digest()].map(b => b > 127 ? b - 256 : b),
      DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
      base64EncodeWebSafe: b => bytesOf(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Encode: b => bytesOf(b).toString('base64'),
      base64Decode: s => [...Buffer.from(String(s), 'base64')],
      newBlob: (bytes, mime, name) => ({ bytes: typeof bytes === 'string' ? [...Buffer.from(bytes)] : bytes, mime, name, getBytes() { return this.bytes; }, setName(n) { this.name = n; return this; }, getName() { return this.name; } }),
      Charset: { UTF_8: 'utf8' },
    },
    ScriptApp: ScriptAppShim, DriveApp: DriveShim, MimeType: { GOOGLE_SHEETS: MIME_SHEET, PDF: 'application/pdf' },
    UrlFetchApp: { fetch: fetchShim }, Logger: { log: (...a) => console.log(...a) },
    Session: { getScriptTimeZone: () => 'Asia/Bangkok', getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }) },
    ContentService: { createTextOutput: s => chain({ getContent: () => s, setMimeType() { return this; } }), MimeType: { JSON: 'json', TEXT: 'text' } },
    HtmlService: chain({}), MailApp: { sendEmail() { } },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'Code.gs' });
  vm.runInContext(OVERRIDES, ctx, { filename: 'sb-overrides.js' });
  return { v, ctx };
}
/** the backend code: local file (tests) → database copy → Apps Script (__core_source) */
async function loadCore(conn, gasCall) {
  if (process.env.HRM_CORE_FILE) {
    if (!G) G = buildContext(require('fs').readFileSync(process.env.HRM_CORE_FILE, 'utf8'), 'file');
    return G;
  }
  if (G && G.v === S.coreV && S.coreV) return G;
  const q = conn || db();
  let [row] = await q`select v, b64 from hrm.core where id = 1`;
  if (!row && gasCall) { await pullCore(gasCall); [row] = await q`select v, b64 from hrm.core where id = 1`; }
  if (!row) throw new Error('ยังไม่มีโค้ดหลังบ้านในฐานข้อมูล — ตั้งค่า › ย้ายไป Supabase › ดึงโค้ดหลังบ้าน');
  G = buildContext(Buffer.from(row.b64, 'base64').toString('utf8'), row.v);
  S.coreV = row.v;
  return G;
}
/** copy the current backend code from Apps Script into the database (after every GAS deploy the cron picks it up) */
async function pullCore(gasCall) {
  const r = await gasCall('__core_source', []);
  if (!r.ok || !r.data || !r.data.b64) throw new Error(r.error || 'Apps Script ยังไม่มีโค้ดสำหรับ Supabase — รอ GitHub Actions deploy รอบถัดไป');
  const [cur] = await db()`select v from hrm.core where id = 1`;
  if (cur && cur.v === r.data.v) return { v: r.data.v, changed: false };
  // the version lives in the same transaction as head, so every instance notices on its next sync
  await db().begin(async tx => {
    await tx`insert into hrm.core (id, v, b64, at) values (1, ${r.data.v}, ${r.data.b64}, now()) on conflict (id) do update set v = excluded.v, b64 = excluded.b64, at = now()`;
  });
  return { v: r.data.v, changed: true };
}

/* ---------------------------------------------------------------- one call at a time per instance */
let queue = Promise.resolve();
function serial(f) { const p = queue.then(f, f); queue = p.catch(() => { }); return p; }

/** run fn(ctx) against the data; saves whatever it changed. pre(conn): prefetch (backups) */
function run(fn, opt) {
  opt = opt || {};
  return serial(async () => {
    await ensureSchema();
    await sync();
    const g = await loadCore(null, opt.gasCall);
    if (opt.pre) await opt.pre(db());
    T.begin();
    let out;
    try { out = fn(g.ctx); } catch (e) { T.begin(); invalidate(); throw e; }
    if (!T.dirty()) { const ob = T.out; T.begin(); flushOut(ob); return out; }
    if (await isFrozen()) { T.begin(); invalidate(); throw Object.assign(new Error('frozen'), { frozen: true }); }
    let ver;
    try {
      ver = await db().begin(async tx => {
        await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
        const [h] = await tx`select ver from hrm.head where id = 1`;
        if (Number(h.ver) !== S.ver) {          // someone saved in between → start again from their data
          T.begin(); invalidate(); await sync(tx);
          if (opt.pre) await opt.pre(tx);
          const g2 = await loadCore(tx);
          out = fn(g2.ctx);
          if (!T.dirty()) return S.ver;
        }
        return writeDirty(tx);
      });
    } catch (e) { T.begin(); invalidate(); throw e; }
    afterWrite(ver);
    const ob = T.out; T.begin(); flushOut(ob);
    return out;
  });
}

/* things to send after the save (LINE · phone notifications) — awaited so Vercel does not freeze them */
let pending = [];
function flushOut(list) {
  if (!list || !list.length) return;
  const p = (async () => {
    for (const o of list) {
      try {
        const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.method === 'GET' ? undefined : o.body });
        const text = await r.text();
        if (o.keep) await run(() => { setProp(o.keep, JSON.stringify({ code: r.status, text: text.slice(0, 4000) })); }).catch(() => { });
        if (/\/api\/push_send$/.test(o.url)) {
          let j = {}; try { j = JSON.parse(text); } catch (e) { }
          const gone = (j.data && j.data.gone) || [];
          if (gone.length) await run(c => c.__pushForget(gone)).catch(() => { });
        }
        if (!r.ok) console.error('outbox', o.url.replace(/\?.*/, ''), r.status, text.slice(0, 200));
      } catch (e) { console.error('outbox', o.url.replace(/\?.*/, ''), e.message); }
    }
  })();
  pending.push(p);
}
async function drain() { const p = pending; pending = []; await Promise.all(p); }

/* ---------------------------------------------------------------- flags (switch / freeze) */
let flagCache = { at: 0, v: {} };
async function flags(fresh) {
  if (!fresh && Date.now() - flagCache.at < 15000) return flagCache.v;
  await ensureSchema();
  const rows = await db()`select k, v from hrm.flag`;
  const v = {}; rows.forEach(r => v[r.k] = r.v);
  flagCache = { at: Date.now(), v };
  return v;
}
async function setFlag(k, v) {
  await ensureSchema();
  if (v === null) await db()`delete from hrm.flag where k = ${k}`;
  else await db()`insert into hrm.flag (k, v, at) values (${k}, ${String(v)}, now()) on conflict (k) do update set v = excluded.v, at = now()`;
  flagCache.at = 0;
}
/** on a database error the call goes to Google — safe: after the switch Google is frozen (reads only, writes refused) */
async function isLive() {
  if (!configured()) return false;
  try { return (await flags()).live === '1'; } catch (e) { console.error('flags', e.message); return flagCache.v.live === '1' ? Promise.reject(e) : false; }
}
async function isFrozen() { try { return (await flags()).frozen === '1'; } catch (e) { return false; } }

/* ---------------------------------------------------------------- entry points */
const BACKUP_CALLS = ['backup_list', 'backup_restore', 'backup_now', 'data_reset'];
async function prefetchBackups(conn, name, args) {
  if (BACKUP_CALLS.indexOf(name) < 0) return;
  S.backups = await conn`select id, name, size, created_at, trashed from hrm.backup where not trashed order by created_at desc limit 120`;
  if (name === 'backup_restore' && args && args[0]) {
    const id = String(args[0]); S.snaps.clear();
    const [b] = await conn`select name, data from hrm.backup where id = ${id} and not trashed`;
    if (b && b.data) { const o = JSON.parse(zlib.gunzipSync(b.data).toString('utf8')); S.snaps.set(id, { __id: id, __name: b.name, sheets: o.sheets || {} }); }
  }
}
/** a normal app call — same answer shape as Apps Script ({ok, data, error, ctx} as text) */
async function call(name, args, ctx, origin, gasCall) {
  try {
    return await run(c => {
      if (/^https:\/\/[\w.-]+(:\d+)?$/.test(String(origin || '')) && Props.getProperty('APP_URL') !== origin) setProp('APP_URL', origin);
      return c.apiCore_(String(name), JSON.stringify(Array.isArray(args) ? args : []), JSON.stringify(ctx || {}));
    }, { pre: conn => prefetchBackups(conn, name, args), gasCall });
  } catch (e) {
    if (e.frozen) return JSON.stringify({ ok: false, error: 'กำลังย้ายข้อมูลกลับไป Google — รอสักครู่แล้วกดอีกครั้ง' });
    console.error('sb', name, e);
    return JSON.stringify({ ok: false, error: 'ฐานข้อมูลไม่ตอบ — ลองใหม่อีกครั้ง (' + String(e.message || e).slice(0, 120) + ')' });
  }
}
/** LINE webhook → lineHook_ */
async function lineHook(body, gasCall) {
  return run(c => { const o = c.lineHook_(body || {}); return o && o.getContent ? o.getContent() : 'ok'; }, { gasCall });
}
/** every 5 min: run due triggers (lineTick · pushTick · nightly backup) */
async function tick(gasCall) {
  const done = [];
  const now = new Date(), day = fmtDate(now, 'yyyy-MM-dd'), hour = +fmtDate(now, 'HH');
  const L = await run(() => trigList(), { gasCall });
  for (const t of L) {
    const lastKey = INTERNAL + 'TRUN:' + t.id;
    const due = await run(() => {
      const last = Props.getProperty(lastKey) || '';
      if (t.min) return !last || (now - new Date(last)) >= (t.min * 60e3 - 45e3);
      return t.hour !== null && hour >= t.hour && last.slice(0, 10) !== day;
    });
    if (!due) continue;
    try {
      await run(c => { setProp(lastKey, t.min ? now.toISOString() : day); if (typeof c[t.fn] === 'function') c[t.fn](); }, { pre: conn => prefetchBackups(conn, 'backup_now') });
      done.push(t.fn);
    } catch (e) { console.error('tick', t.fn, e.message); }
  }
  // cache guards past their time
  await run(() => { const n = Date.now(); for (const [k, v] of S.props) if (k.indexOf(INTERNAL + 'C:') === 0) { try { if (JSON.parse(v).e < n) setProp(k, null); } catch (e) { setProp(k, null); } } });
  return done;
}

/* ---------------------------------------------------------------- moving data in / out */
/** Google (dump) → database: replaces every tab and Script Property */
async function importDump(d) {
  if (!d || !d.sheets) throw new Error('ข้อมูลจาก Google ไม่ครบ');
  await ensureSchema();
  return serial(async () => {
    const counts = {};
    await db().begin(async tx => {
      await tx`select pg_advisory_xact_lock(${LOCK_ID})`;
      const [h] = await tx`update hrm.head set ver = ver + 1 where id = 1 returning ver`;
      const ver = Number(h.ver);
      await tx`delete from hrm.chunk`;
      const rows = [];
      Object.keys(d.sheets).forEach(name => {
        const all = (d.sheets[name] || []).map(cleanRow);
        trimSheet(all);
        counts[name] = Math.max(0, all.length - 1);
        const n = Math.max(1, Math.ceil(all.length / CHUNK));
        for (let c = 0; c < n; c++) rows.push([name, c, all.slice(c * CHUNK, (c + 1) * CHUNK)]);
      });
      for (let i = 0; i < rows.length; i += 50) {
        await tx`insert into hrm.chunk (sheet, chunk, ver, data) select x->>0, (x->>1)::int, ${ver}, x->2 from json_array_elements(${tx.json(rows.slice(i, i + 50))}::json) x`;
      }
      // props: everything from Google + this runtime's own (triggers rebuilt from Google's list)
      const keep = await tx`select k, v from hrm.prop where k like ${INTERNAL + '%'} and k not like ${INTERNAL + 'TRIG%'} and k not like ${INTERNAL + 'TRUN%'}`;
      await tx`delete from hrm.prop`;
      const P = Object.keys(d.props || {}).map(k => [k, String(d.props[k])]);
      keep.forEach(r => P.push([r.k, r.v]));
      const trig = []; const seen = new Set();
      (d.triggers || []).forEach(fn => {
        if (seen.has(fn)) return; seen.add(fn);
        if (fn === 'lineTick' || fn === 'pushTick') trig.push({ id: crypto.randomUUID(), fn, min: 5, hour: null });
        else if (fn === 'dailyBackup') trig.push({ id: crypto.randomUUID(), fn, min: null, hour: 1 });
        else if (fn === 'nightlyBackup') trig.push({ id: crypto.randomUUID(), fn, min: null, hour: +(d.props || {}).BACKUP_HOUR || 2 });
      });
      P.push([INTERNAL + 'TRIG', JSON.stringify(trig)]);
      if (P.length) await tx`insert into hrm.prop (k, v, ver) select x->>0, x->>1, ${ver} from json_array_elements(${tx.json(P)}::json) x`;
    });
    invalidate();
    return { counts, rev: d.rev, at: d.at };
  });
}
/** database → the same shape Google's dump has (for rolling back) */
async function exportDump() {
  return run(() => {
    const sheets = {}; for (const [n, s] of S.sheets) sheets[n] = s.d.map(cleanRow);
    const props = Props.getProperties();
    return { sheets, props, rev: Number(props.REV || 0), at: fmtDate(new Date(), 'yyyy-MM-dd HH:mm:ss') };
  });
}
async function counts() {
  return run(c => {
    const SCHEMA = vm.runInContext('SCHEMA', c);
    const o = {}; Object.keys(SCHEMA || {}).forEach(n => { const s = S.sheets.get(n); o[n] = s ? Math.max(0, s.d.length - 1) : 0; });
    return { tables: o, rev: Number(Props.getProperty('REV') || 0) };
  });
}
async function status() {
  const o = { configured: configured() };
  if (!o.configured) return o;
  try {
    await ensureSchema();
    const [r] = await db()`select (select ver from hrm.head where id = 1) as head, (select count(*) from hrm.chunk) as chunks,
      (select v from hrm.core where id = 1) as core_v, (select at from hrm.core where id = 1) as core_at,
      (select count(*) from hrm.backup where not trashed) as backups, (select coalesce(sum(size), 0) from hrm.file) as files,
      pg_database_size(current_database()) as bytes`;
    const f = await flags(true);
    let cron = null;
    try { const j = await db()`select jobname, schedule, active from cron.job where jobname = 'hrm-tick'`; cron = j[0] || false; } catch (e) { cron = null; }
    Object.assign(o, { ok: true, head: Number(r.head), chunks: Number(r.chunks), core: r.core_v, core_at: r.core_at, backups: Number(r.backups),
      files_bytes: Number(r.files), db_bytes: Number(r.bytes), live: f.live === '1', frozen: f.frozen === '1', moved_at: f.moved_at || null,
      copied_at: f.copied_at || null, cron, region_hint: process.env.VERCEL_REGION || null });
  } catch (e) { o.ok = false; o.error = String(e.message || e).slice(0, 300); }
  return o;
}
/** pg_cron + pg_net call /api/_sb?job=tick every 5 minutes with a key kept in the database */
async function setupCron(appUrl) {
  await ensureSchema();
  const out = { ok: false };
  try {
    await db().unsafe('create extension if not exists pg_cron');
    await db().unsafe('create extension if not exists pg_net');
    let [k] = await db()`select v from hrm.flag where k = 'cron_key'`;
    if (!k) { await setFlag('cron_key', crypto.randomBytes(24).toString('base64url')); }
    const url = String(appUrl).replace(/\/$/, '') + '/api/_sb?job=tick';
    const cmd = `select net.http_post(url := '${url.replace(/'/g, "''")}', headers := jsonb_build_object('Content-Type', 'application/json', 'x-hrm-cron', (select v from hrm.flag where k = 'cron_key')), body := '{}'::jsonb, timeout_milliseconds := 55000)`;
    await db()`select cron.unschedule(jobid) from cron.job where jobname = 'hrm-tick'`;
    await db()`select cron.schedule('hrm-tick', '*/5 * * * *', ${cmd})`;
    out.ok = true; out.url = url;
  } catch (e) { out.error = String(e.message || e).slice(0, 300); }
  return out;
}
async function cronKeyOk(given) {
  if (!given) return false;
  const f = await flags(true);
  const a = Buffer.from(String(given)), b = Buffer.from(String(f.cron_key || ''));
  return !!f.cron_key && a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function getFile(id) {
  await ensureSchema();
  const [f] = await db()`select name, mime, data from hrm.file where id = ${String(id)}`;
  return f || null;
}

module.exports = { configured, isLive, isFrozen, flags, setFlag, call, lineHook, tick, drain, pullCore, importDump, exportDump, counts, status, setupCron, cronKeyOk, getFile, ensureSchema, _S: S };
