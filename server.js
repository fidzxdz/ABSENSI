'use strict';
/*
 * Sistem Absensi Wajah — backend tanpa dependensi npm.
 * Butuh Node.js >= 22.13 (memakai node:sqlite bawaan).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { validTz, zonedToUtcMs, todayInZone, formatTime, formatDateTime } = require('./lib/timeutil');
const { buildXlsx, STYLE } = require('./lib/xlsx');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // aman: hanya lokal; Tailscale Serve yang membuka ke tailnet
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(SNAP_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'absensi.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','coadmin','panitia')),
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  institution TEXT NOT NULL DEFAULT '',
  descriptors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('hadir','terlambat')),
  method TEXT NOT NULL CHECK (method IN ('face','manual','admin')),
  scanned_at TEXT NOT NULL,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  scanned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id INTEGER,
  distance REAL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS manual_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  claimed_name TEXT NOT NULL DEFAULT '',
  claimed_serial TEXT NOT NULL DEFAULT '',
  serial_match INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  has_snapshot INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  face_confirmed INTEGER NOT NULL DEFAULT 0,
  name_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id INTEGER,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_time ON attendance(scanned_at);
CREATE INDEX IF NOT EXISTS idx_req_status ON manual_requests(status);
`);

const nowIso = () => new Date().toISOString();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}

// ---------------------------------------------------------------- pengaturan
const DEFAULTS = {
  event_name: 'Acara Saya',
  event_date: '',
  start_time: '07:30',
  late_time: '08:00',
  end_time: '12:00',
  timezone: 'Asia/Jakarta',
  match_threshold: '0.5',
  require_serial: '0',
  serial_prefix: 'PST',
};
function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) s[r.key] = r.value;
  if (!s.event_date) s.event_date = todayInZone(s.timezone);
  return {
    ...s,
    match_threshold: Number(s.match_threshold),
    require_serial: s.require_serial === '1',
  };
}
function setSetting(k, v) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
}
function eventWindow(s) {
  return {
    open: zonedToUtcMs(s.event_date, s.start_time, s.timezone),
    late: zonedToUtcMs(s.event_date, s.late_time, s.timezone),
    close: zonedToUtcMs(s.event_date, s.end_time, s.timezone),
  };
}
// state: before | ok | closed
function classify(s, ms) {
  const w = eventWindow(s);
  if (ms < w.open) return { state: 'before' };
  if (ms > w.close) return { state: 'closed' };
  if (ms <= w.late) return { state: 'ok', status: 'hadir', lateMin: 0 };
  return { state: 'ok', status: 'terlambat', lateMin: Math.ceil((ms - w.late) / 60000) };
}

// ---------------------------------------------------------------- util
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bad = (m, extra) => new HttpError(400, m, extra);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(pw, salt, 64);
  const exp = Buffer.from(h, 'hex');
  return exp.length === calc.length && crypto.timingSafeEqual(calc, exp);
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const SERIAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomChars(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += SERIAL_CHARS[b[i] % SERIAL_CHARS.length];
  return s;
}
function newSerial(prefix) {
  const pre = String(prefix || 'PST').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'PST';
  for (let i = 0; i < 50; i++) {
    const code = `${pre}-${randomChars(4)}-${randomChars(4)}`;
    if (!one('SELECT 1 AS x FROM participants WHERE serial_code = ?', code)) return code;
  }
  throw new HttpError(500, 'Gagal membuat kode seri unik');
}
const normSerial = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function cleanText(v, max, label, required = false) {
  const s = String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (required && !s) throw bad(`${label} wajib diisi`);
  if (s.length > max) throw bad(`${label} terlalu panjang (maks ${max} karakter)`);
  return s;
}

function parseDataUrlJpeg(d, maxBytes = 1_500_000) {
  if (typeof d !== 'string') return null;
  const m = /^data:image\/jpe?g;base64,([A-Za-z0-9+/=]+)$/.exec(d);
  if (!m) throw bad('Format gambar tidak valid (harus JPEG)');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > maxBytes) throw bad('Ukuran gambar terlalu besar');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('Berkas bukan JPEG yang valid');
  return buf;
}

function validDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10);
}

function logError(type, message, userId = null, requestId = null) {
  try {
    run('INSERT INTO error_logs(type,message,user_id,request_id,created_at) VALUES(?,?,?,?,?)', type, String(message).slice(0, 500), userId, requestId, nowIso());
  } catch (e) {
    console.error('Gagal menulis error_logs', e);
  }
}

// ---------------------------------------------------------------- sesi & auth
const SESSION_MS = 12 * 3600 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const th = sha(tok);
  const s = one('SELECT s.user_id, s.expires_at FROM sessions s WHERE s.token_hash = ?', th);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    run('DELETE FROM sessions WHERE token_hash = ?', th);
    return null;
  }
  const u = one('SELECT id, username, name, role, active FROM users WHERE id = ?', s.user_id);
  if (!u || !u.active) return null;
  return u;
}
function isHttps(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return ra;
}

const loginFails = new Map();
function loginBlocked(key) {
  const e = loginFails.get(key);
  if (!e) return false;
  if (Date.now() - e.first > 10 * 60 * 1000) {
    loginFails.delete(key);
    return false;
  }
  return e.count >= 8;
}
function loginFail(key) {
  const e = loginFails.get(key);
  if (!e || Date.now() - e.first > 10 * 60 * 1000) loginFails.set(key, { count: 1, first: Date.now() });
  else e.count++;
}

const errRate = new Map();
function errRateOk(uid) {
  const now = Date.now();
  const arr = (errRate.get(uid) || []).filter((t) => now - t < 60000);
  if (arr.length >= 30) return false;
  arr.push(now);
  errRate.set(uid, arr);
  return true;
}

// ---------------------------------------------------------------- router
const routes = [];
function route(method, pattern, roles, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, roles, handler });
}
const STAFF = ['admin', 'coadmin'];
const SCANNERS = ['admin', 'coadmin', 'panitia'];
const ANY = ['admin', 'coadmin', 'panitia'];

function readBody(req, limit = 4_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Permintaan terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(bad('JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? headers['Content-Type'] || 'application/octet-stream' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

// ---------------------------------------------------------------- helper domain
function participantView(p, att) {
  const desc = JSON.parse(p.descriptors || '[]');
  return {
    id: p.id,
    serial_code: p.serial_code,
    name: p.name,
    institution: p.institution,
    face_count: desc.length,
    has_photo: fs.existsSync(path.join(PHOTO_DIR, `${p.id}.jpg`)),
    attendance: att
      ? {
          status: att.status,
          method: att.method,
          scanned_at: att.scanned_at,
          late_minutes: att.late_minutes,
        }
      : null,
  };
}
function listParticipants() {
  const ps = all('SELECT * FROM participants ORDER BY name COLLATE NOCASE');
  const atts = new Map(all('SELECT * FROM attendance').map((a) => [a.participant_id, a]));
  return ps.map((p) => participantView(p, atts.get(p.id)));
}
function stats() {
  const total = one('SELECT COUNT(*) AS n FROM participants').n;
  const hadir = one("SELECT COUNT(*) AS n FROM attendance WHERE status='hadir'").n;
  const terlambat = one("SELECT COUNT(*) AS n FROM attendance WHERE status='terlambat'").n;
  const byMethod = {};
  for (const r of all('SELECT method, COUNT(*) AS n FROM attendance GROUP BY method')) byMethod[r.method] = r.n;
  return {
    total,
    hadir,
    terlambat,
    belum: total - hadir - terlambat,
    by_method: byMethod,
    pending_requests: one("SELECT COUNT(*) AS n FROM manual_requests WHERE status='pending'").n,
    open_errors: one("SELECT COUNT(*) AS n FROM error_logs WHERE resolved=0 AND type != 'manual_request'").n,
  };
}
function statusInfo() {
  const s = getSettings();
  const now = Date.now();
  const w = eventWindow(s);
  const c = classify(s, now);
  return {
    settings: s,
    now,
    window: w,
    state: c.state === 'ok' ? (c.status === 'hadir' ? 'open' : 'late') : c.state,
  };
}

function requestView(r) {
  const p = r.participant_id ? one('SELECT id, name, serial_code, institution FROM participants WHERE id = ?', r.participant_id) : null;
  const by = r.requested_by ? one('SELECT name FROM users WHERE id = ?', r.requested_by) : null;
  const rv = r.reviewed_by ? one('SELECT name FROM users WHERE id = ?', r.reviewed_by) : null;
  return {
    id: r.id,
    participant_id: r.participant_id,
    participant: p
      ? { id: p.id, name: p.name, institution: p.institution, has_photo: fs.existsSync(path.join(PHOTO_DIR, `${p.id}.jpg`)) }
      : null,
    claimed_name: r.claimed_name,
    claimed_serial: r.claimed_serial,
    serial_match: !!r.serial_match,
    reason: r.reason,
    note: r.note,
    has_snapshot: !!r.has_snapshot,
    status: r.status,
    requested_by: by ? by.name : '-',
    requested_by_id: r.requested_by,
    created_at: r.created_at,
    reviewed_by: rv ? rv.name : null,
    reviewed_at: r.reviewed_at,
    review_note: r.review_note,
  };
}

// ---------------------------------------------------------------- ROUTES: auth
route('POST', '/api/login', null, async ({ req, res, body }) => {
  const username = cleanText(body.username, 60, 'Username', true);
  const password = String(body.password || '');
  const key = `${clientIp(req)}|${username.toLowerCase()}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.');
  const u = one('SELECT * FROM users WHERE username = ?', username);
  const ok = verifyPassword(password, u ? u.pass_hash : DUMMY_HASH) && u && u.active;
  if (!ok) {
    loginFail(key);
    throw new HttpError(401, 'Username atau password salah');
  }
  loginFails.delete(key);
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), u.id, Date.now() + SESSION_MS);
  const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
  send(res, 200, { user: { id: u.id, username: u.username, name: u.name, role: u.role } }, { 'Set-Cookie': cookie });
});

route('POST', '/api/logout', null, async ({ req, res }) => {
  const tok = parseCookies(req.headers.cookie).sid;
  if (tok) run('DELETE FROM sessions WHERE token_hash = ?', sha(tok));
  send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
});

route('GET', '/api/me', null, async ({ user }) => ({ user: user || null }));

route('POST', '/api/password', ANY, async ({ user, body }) => {
  const u = one('SELECT * FROM users WHERE id = ?', user.id);
  if (!verifyPassword(String(body.old_password || ''), u.pass_hash)) throw bad('Password lama salah');
  const np = String(body.new_password || '');
  if (np.length < 8) throw bad('Password baru minimal 8 karakter');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(np), user.id);
  return { ok: true };
});

// ---------------------------------------------------------------- ROUTES: pengaturan & status
route('GET', '/api/status', ANY, async () => ({ ...statusInfo(), stats: stats() }));

route('PUT', '/api/settings', ['admin'], async ({ body }) => {
  const cur = getSettings();
  const next = { ...cur };
  if (body.event_name !== undefined) next.event_name = cleanText(body.event_name, 100, 'Nama acara', true);
  if (body.timezone !== undefined) {
    const tz = cleanText(body.timezone, 60, 'Zona waktu', true);
    if (!validTz(tz)) throw bad('Zona waktu tidak valid (contoh: Asia/Jakarta)');
    next.timezone = tz;
  }
  if (body.event_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.event_date)) throw bad('Tanggal tidak valid');
    next.event_date = body.event_date;
  }
  for (const k of ['start_time', 'late_time', 'end_time']) {
    if (body[k] !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[k])) throw bad(`Format jam ${k} tidak valid (HH:MM)`);
      next[k] = body[k];
    }
  }
  if (body.match_threshold !== undefined) {
    const t = Number(body.match_threshold);
    if (!(t >= 0.3 && t <= 0.7)) throw bad('Ambang kecocokan wajah harus antara 0.30 dan 0.70');
    next.match_threshold = t;
  }
  if (body.require_serial !== undefined) next.require_serial = !!body.require_serial;
  if (body.serial_prefix !== undefined) {
    const p = String(body.serial_prefix).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (p.length < 2 || p.length > 6) throw bad('Awalan kode seri 2–6 huruf/angka');
    next.serial_prefix = p;
  }
  const w = eventWindow(next);
  if (!(w.open <= w.late && w.late <= w.close)) throw bad('Urutan jam harus: jam buka ≤ batas terlambat ≤ jam tutup');
  for (const [k, v] of Object.entries(next)) setSetting(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  return statusInfo();
});

// ---------------------------------------------------------------- ROUTES: pengguna
route('GET', '/api/users', ['admin'], async () => ({
  users: all('SELECT id, username, name, role, active, created_at FROM users ORDER BY role, name COLLATE NOCASE'),
}));
route('POST', '/api/users', ['admin'], async ({ body }) => {
  const username = cleanText(body.username, 40, 'Username', true);
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) throw bad('Username 3–40 karakter (huruf, angka, . _ -)');
  const name = cleanText(body.name, 80, 'Nama', true);
  if (!['admin', 'coadmin', 'panitia'].includes(body.role)) throw bad('Peran tidak valid');
  const pw = String(body.password || '');
  if (pw.length < 8) throw bad('Password minimal 8 karakter');
  if (one('SELECT 1 AS x FROM users WHERE username = ?', username)) throw bad('Username sudah dipakai');
  const r = run('INSERT INTO users(username,name,role,pass_hash,active,created_at) VALUES(?,?,?,?,1,?)', username, name, body.role, hashPassword(pw), nowIso());
  return { id: Number(r.lastInsertRowid) };
});
route('PUT', '/api/users/:id', ['admin'], async ({ params, user, body }) => {
  const id = Number(params.id);
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan');
  const name = body.name !== undefined ? cleanText(body.name, 80, 'Nama', true) : u.name;
  const role = body.role !== undefined ? body.role : u.role;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : u.active;
  if (!['admin', 'coadmin', 'panitia'].includes(role)) throw bad('Peran tidak valid');
  if (id === user.id && (role !== 'admin' || !active)) throw bad('Kamu tidak bisa menurunkan/menonaktifkan akunmu sendiri');
  let hash = u.pass_hash;
  if (body.password) {
    if (String(body.password).length < 8) throw bad('Password minimal 8 karakter');
    hash = hashPassword(String(body.password));
  }
  run('UPDATE users SET name=?, role=?, active=?, pass_hash=? WHERE id=?', name, role, active, hash, id);
  if (!active || body.password) run('DELETE FROM sessions WHERE user_id = ?', id);
  return { ok: true };
});

// ---------------------------------------------------------------- ROUTES: peserta
route('GET', '/api/participants', STAFF, async () => ({ participants: listParticipants() }));

route('POST', '/api/participants', ['admin'], async ({ body }) => {
  const name = cleanText(body.name, 100, 'Nama', true);
  const institution = cleanText(body.institution, 100, 'Instansi');
  const code = newSerial(getSettings().serial_prefix);
  const r = run('INSERT INTO participants(serial_code,name,institution,created_at) VALUES(?,?,?,?)', code, name, institution, nowIso());
  return { id: Number(r.lastInsertRowid), serial_code: code };
});

route('POST', '/api/participants/import', ['admin'], async ({ body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw bad('Tidak ada data untuk diimpor');
  if (rows.length > 500) throw bad('Maksimal 500 baris per impor');
  const prefix = getSettings().serial_prefix;
  const created = tx(() =>
    rows.map((r) => {
      const name = cleanText(r.name, 100, 'Nama', true);
      const institution = cleanText(r.institution, 100, 'Instansi');
      const code = newSerial(prefix);
      const x = run('INSERT INTO participants(serial_code,name,institution,created_at) VALUES(?,?,?,?)', code, name, institution, nowIso());
      return { id: Number(x.lastInsertRowid), name, serial_code: code };
    })
  );
  return { created };
});

route('PUT', '/api/participants/:id', ['admin'], async ({ params, body }) => {
  const id = Number(params.id);
  const p = one('SELECT * FROM participants WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Peserta tidak ditemukan');
  const name = cleanText(body.name ?? p.name, 100, 'Nama', true);
  const institution = cleanText(body.institution ?? p.institution, 100, 'Instansi');
  run('UPDATE participants SET name=?, institution=? WHERE id=?', name, institution, id);
  return { ok: true };
});

route('DELETE', '/api/participants/:id', ['admin'], async ({ params }) => {
  const id = Number(params.id);
  const r = run('DELETE FROM participants WHERE id = ?', id);
  if (!r.changes) throw new HttpError(404, 'Peserta tidak ditemukan');
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, `${id}.jpg`));
  } catch {}
  return { ok: true };
});

const MAX_SAMPLES = 5;
route('POST', '/api/participants/:id/face', ['admin'], async ({ params, body }) => {
  const id = Number(params.id);
  const p = one('SELECT * FROM participants WHERE id = ?', id);
  if (!p) throw new HttpError(404, 'Peserta tidak ditemukan');
  if (!validDescriptor(body.descriptor)) throw bad('Data wajah tidak valid');
  const photo = parseDataUrlJpeg(body.photo);
  let list = body.replace ? [] : JSON.parse(p.descriptors || '[]');
  if (list.length >= MAX_SAMPLES) list.shift(); // buang sampel terlama
  list.push(body.descriptor.map((x) => Math.round(x * 10000) / 10000));
  run('UPDATE participants SET descriptors = ? WHERE id = ?', JSON.stringify(list), id);
  if (photo) fs.writeFileSync(path.join(PHOTO_DIR, `${id}.jpg`), photo);
  return { face_count: list.length };
});

route('DELETE', '/api/participants/:id/face', ['admin'], async ({ params }) => {
  const id = Number(params.id);
  run("UPDATE participants SET descriptors = '[]' WHERE id = ?", id);
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, `${id}.jpg`));
  } catch {}
  return { ok: true };
});

route('GET', '/api/participants/:id/photo', STAFF, async ({ params, res }) => {
  const f = path.join(PHOTO_DIR, `${Number(params.id)}.jpg`);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Foto tidak ada');
  send(res, 200, fs.readFileSync(f), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' });
});

// pencarian ringan untuk panitia: tidak membocorkan kode seri
route('GET', '/api/search', ANY, async ({ query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 2) return { results: [] };
  const like = `%${q.replace(/[%_]/g, '')}%`;
  return {
    results: all('SELECT id, name, institution FROM participants WHERE name LIKE ? COLLATE NOCASE ORDER BY name COLLATE NOCASE LIMIT 15', like),
  };
});

// ---------------------------------------------------------------- ROUTES: absensi wajah
route('GET', '/api/descriptors', SCANNERS, async () => {
  const s = getSettings();
  const atts = new Set(all('SELECT participant_id FROM attendance').map((a) => a.participant_id));
  const people = all("SELECT id, descriptors FROM participants WHERE descriptors != '[]'").map((p) => ({
    id: p.id,
    descriptors: JSON.parse(p.descriptors),
    attended: atts.has(p.id),
  }));
  return {
    threshold: s.match_threshold,
    require_serial: s.require_serial,
    total_participants: one('SELECT COUNT(*) AS n FROM participants').n,
    people,
  };
});

route('POST', '/api/attendance/face', SCANNERS, async ({ user, body }) => {
  const s = getSettings();
  const pid = Number(body.participant_id);
  const p = one('SELECT * FROM participants WHERE id = ?', pid);
  if (!p) {
    logError('db_error', `Scan wajah merujuk peserta id=${pid} yang tidak ada di database`, user.id);
    throw new HttpError(404, 'Data peserta tidak ditemukan di database');
  }
  const dist = Number(body.distance);
  if (!Number.isFinite(dist) || dist < 0 || dist > s.match_threshold + 0.01) throw bad('Skor kecocokan wajah tidak memenuhi ambang batas');
  if (s.require_serial && normSerial(body.serial) !== normSerial(p.serial_code)) {
    logError('face_error', `Kode seri tidak cocok saat scan wajah untuk "${p.name}"`, user.id);
    throw bad('Kode seri tidak cocok dengan peserta yang dikenali', { code: 'serial_mismatch' });
  }
  const view = { id: p.id, name: p.name, serial_code: p.serial_code, institution: p.institution };
  const existing = one('SELECT * FROM attendance WHERE participant_id = ?', pid);
  if (existing) return { ok: true, already: true, participant: view, status: existing.status, scanned_at: existing.scanned_at, late_minutes: existing.late_minutes, method: existing.method };
  const now = Date.now();
  const c = classify(s, now);
  if (c.state === 'before') throw bad('Absensi belum dibuka', { code: 'before' });
  if (c.state === 'closed') throw bad('Absensi sudah ditutup', { code: 'closed' });
  const iso = new Date(now).toISOString();
  const r = run('INSERT OR IGNORE INTO attendance(participant_id,status,method,scanned_at,late_minutes,scanned_by,distance) VALUES(?,?,?,?,?,?,?)', pid, c.status, 'face', iso, c.lateMin, user.id, dist);
  if (!r.changes) {
    const ex = one('SELECT * FROM attendance WHERE participant_id = ?', pid);
    return { ok: true, already: true, participant: view, status: ex.status, scanned_at: ex.scanned_at, late_minutes: ex.late_minutes, method: ex.method };
  }
  return { ok: true, already: false, participant: view, status: c.status, scanned_at: iso, late_minutes: c.lateMin, method: 'face' };
});

route('GET', '/api/attendance', ANY, async ({ user }) => {
  const mine = user.role === 'panitia';
  const rows = all(
    `SELECT a.*, p.name, p.serial_code, p.institution, u.name AS by_name
     FROM attendance a JOIN participants p ON p.id = a.participant_id
     LEFT JOIN users u ON u.id = a.scanned_by
     ${mine ? 'WHERE a.scanned_by = ?' : ''} ORDER BY a.scanned_at DESC LIMIT ${mine ? 30 : 1000}`,
    ...(mine ? [user.id] : [])
  );
  return { attendance: rows };
});

// absen manual langsung oleh admin
route('POST', '/api/attendance/admin', ['admin'], async ({ user, body }) => {
  const pid = Number(body.participant_id);
  const p = one('SELECT * FROM participants WHERE id = ?', pid);
  if (!p) throw new HttpError(404, 'Peserta tidak ditemukan');
  if (one('SELECT 1 AS x FROM attendance WHERE participant_id = ?', pid)) throw bad('Peserta sudah tercatat hadir');
  const s = getSettings();
  const now = Date.now();
  const c = classify(s, now);
  let status = c.status;
  let late = c.lateMin || 0;
  if (c.state === 'before') {
    status = 'hadir';
    late = 0;
  } else if (c.state === 'closed') {
    status = 'terlambat';
    late = Math.ceil((now - eventWindow(s).late) / 60000);
  }
  if (body.status === 'hadir') {
    status = 'hadir';
    late = 0;
  } else if (body.status === 'terlambat') {
    status = 'terlambat';
    late = Math.max(late, 1);
  }
  const note = cleanText(body.note, 300, 'Catatan');
  if (!note) throw bad('Alasan absen manual wajib diisi');
  run('INSERT INTO attendance(participant_id,status,method,scanned_at,late_minutes,scanned_by,note) VALUES(?,?,?,?,?,?,?)', pid, status, 'admin', new Date(now).toISOString(), late, user.id, note);
  return { ok: true, status };
});

route('DELETE', '/api/attendance/:pid', ['admin'], async ({ params }) => {
  const r = run('DELETE FROM attendance WHERE participant_id = ?', Number(params.pid));
  if (!r.changes) throw new HttpError(404, 'Data absensi tidak ditemukan');
  return { ok: true };
});

// ---------------------------------------------------------------- ROUTES: pengajuan absen manual
const REASONS = { face_not_found: 'Wajah tidak terdeteksi/dikenali', db_error: 'Data peserta error / tidak ditemukan di database', other: 'Lainnya' };

route('POST', '/api/manual-requests', SCANNERS, async ({ user, body }) => {
  const reason = REASONS[body.reason] ? body.reason : null;
  if (!reason) throw bad('Alasan pengajuan tidak valid');
  const note = cleanText(body.note, 400, 'Catatan');
  const serialTyped = cleanText(body.serial, 40, 'Kode seri', true);
  let participantId = body.participant_id ? Number(body.participant_id) : null;
  let claimedName = cleanText(body.claimed_name, 100, 'Nama');
  let p = null;
  if (participantId) {
    p = one('SELECT * FROM participants WHERE id = ?', participantId);
    if (!p) throw bad('Peserta yang dipilih tidak ditemukan');
    if (normSerial(serialTyped) !== normSerial(p.serial_code)) throw bad('Kode seri tidak cocok dengan nama peserta yang dipilih. Periksa kembali kartu/kode peserta.');
    claimedName = p.name;
  } else {
    if (!claimedName) throw bad('Isi nama peserta');
    p = one('SELECT * FROM participants WHERE serial_code = ?', serialTyped.toUpperCase().replace(/\s/g, ''));
    if (!p) {
      const all2 = all('SELECT * FROM participants');
      p = all2.find((x) => normSerial(x.serial_code) === normSerial(serialTyped)) || null;
    }
    if (p) participantId = p.id;
  }
  if (participantId) {
    if (one('SELECT 1 AS x FROM attendance WHERE participant_id = ?', participantId)) throw bad('Peserta ini sudah tercatat hadir');
    if (one("SELECT 1 AS x FROM manual_requests WHERE participant_id = ? AND status = 'pending'", participantId)) throw bad('Sudah ada pengajuan yang menunggu verifikasi untuk peserta ini');
  }
  const serialMatch = p ? (normSerial(serialTyped) === normSerial(p.serial_code) ? 1 : 0) : 0;
  const snap = body.snapshot ? parseDataUrlJpeg(body.snapshot) : null;
  const created = nowIso();
  const id = tx(() => {
    const r = run(
      'INSERT INTO manual_requests(participant_id,claimed_name,claimed_serial,serial_match,reason,note,has_snapshot,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      participantId, claimedName, serialTyped.toUpperCase(), serialMatch, reason, note, snap ? 1 : 0, user.id, created
    );
    const rid = Number(r.lastInsertRowid);
    logError('manual_request', `Pengajuan absen manual (${REASONS[reason]}) untuk "${claimedName}" oleh ${user.name}`, user.id, rid);
    return rid;
  });
  if (snap) fs.writeFileSync(path.join(SNAP_DIR, `${id}.jpg`), snap);
  return { id, linked: !!participantId };
});

route('GET', '/api/manual-requests', ANY, async ({ user, query }) => {
  const st = ['pending', 'approved', 'rejected'].includes(query.status) ? query.status : null;
  const cond = [];
  const params = [];
  if (st) {
    cond.push('status = ?');
    params.push(st);
  }
  if (user.role === 'panitia') {
    cond.push('requested_by = ?');
    params.push(user.id);
  }
  const rows = all(`SELECT * FROM manual_requests ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`, ...params);
  return { requests: rows.map(requestView), reasons: REASONS };
});

route('GET', '/api/manual-requests/:id/snapshot', ANY, async ({ user, params, res }) => {
  const id = Number(params.id);
  const r = one('SELECT requested_by FROM manual_requests WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Tidak ditemukan');
  if (user.role === 'panitia' && r.requested_by !== user.id) throw new HttpError(403, 'Tidak diizinkan');
  const f = path.join(SNAP_DIR, `${id}.jpg`);
  if (!fs.existsSync(f)) throw new HttpError(404, 'Tidak ada foto');
  send(res, 200, fs.readFileSync(f), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' });
});

route('POST', '/api/manual-requests/:id/approve', STAFF, async ({ user, params, body }) => {
  const id = Number(params.id);
  return tx(() => {
    const r = one('SELECT * FROM manual_requests WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'Pengajuan tidak ditemukan');
    if (r.status !== 'pending') throw bad('Pengajuan ini sudah diproses');
    if (body.face_match !== true || body.name_match !== true) throw bad('Verifikasi wajah dan nama wajib dikonfirmasi sebelum menyetujui');
    let pid = r.participant_id;
    if (!pid && body.participant_id) pid = Number(body.participant_id);
    const p = pid ? one('SELECT * FROM participants WHERE id = ?', pid) : null;
    if (!p) throw bad('Pengajuan belum terhubung ke data peserta. Pilih peserta yang sesuai terlebih dahulu.');
    const note = cleanText(body.note, 300, 'Catatan');
    const reviewed = nowIso();
    if (one('SELECT 1 AS x FROM attendance WHERE participant_id = ?', pid)) {
      run("UPDATE manual_requests SET status='rejected', reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?", user.id, reviewed, 'Otomatis ditolak: peserta sudah tercatat hadir', id);
      run('UPDATE error_logs SET resolved=1, resolved_by=?, resolved_at=? WHERE request_id=? AND resolved=0', user.id, reviewed, id);
      return { ok: true, duplicate: true };
    }
    // waktu absen = saat pengajuan dibuat (bukan saat disetujui) supaya adil untuk status terlambat
    const s = getSettings();
    const t = Date.parse(r.created_at);
    const c = classify(s, t);
    let status = c.status;
    let late = c.lateMin || 0;
    if (c.state === 'before') {
      status = 'hadir';
      late = 0;
    } else if (c.state === 'closed') {
      status = 'terlambat';
      late = Math.ceil((t - eventWindow(s).late) / 60000);
    }
    run(
      "UPDATE manual_requests SET status='approved', participant_id=?, serial_match=?, reviewed_by=?, reviewed_at=?, review_note=?, face_confirmed=1, name_confirmed=1 WHERE id=?",
      pid, normSerial(r.claimed_serial) === normSerial(p.serial_code) ? 1 : 0, user.id, reviewed, note, id
    );
    run('INSERT INTO attendance(participant_id,status,method,scanned_at,late_minutes,scanned_by,request_id,note) VALUES(?,?,?,?,?,?,?,?)', pid, status, 'manual', r.created_at, late, r.requested_by, id, note || REASONS[r.reason]);
    run('UPDATE error_logs SET resolved=1, resolved_by=?, resolved_at=? WHERE request_id=? AND resolved=0', user.id, reviewed, id);
    return { ok: true, status };
  });
});

route('POST', '/api/manual-requests/:id/reject', STAFF, async ({ user, params, body }) => {
  const id = Number(params.id);
  const r = one('SELECT * FROM manual_requests WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Pengajuan tidak ditemukan');
  if (r.status !== 'pending') throw bad('Pengajuan ini sudah diproses');
  const note = cleanText(body.note, 300, 'Alasan penolakan', true);
  const now = nowIso();
  run("UPDATE manual_requests SET status='rejected', reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?", user.id, now, note, id);
  run('UPDATE error_logs SET resolved=1, resolved_by=?, resolved_at=? WHERE request_id=? AND resolved=0', user.id, now, id);
  return { ok: true };
});

// ---------------------------------------------------------------- ROUTES: error log
const CLIENT_ERR_TYPES = ['face_unrecognized', 'face_error', 'db_error', 'camera', 'other'];
route('POST', '/api/errors', SCANNERS, async ({ user, body }) => {
  if (!errRateOk(user.id)) throw new HttpError(429, 'Terlalu banyak laporan');
  const type = CLIENT_ERR_TYPES.includes(body.type) ? body.type : 'other';
  logError(type, `${cleanText(body.message, 300, 'Pesan', true)} (oleh ${user.name})`, user.id);
  return { ok: true };
});
route('GET', '/api/errors', STAFF, async ({ query }) => {
  const onlyOpen = query.all !== '1';
  const rows = all(
    `SELECT e.*, u.name AS user_name, r.name AS resolved_by_name FROM error_logs e
     LEFT JOIN users u ON u.id = e.user_id LEFT JOIN users r ON r.id = e.resolved_by
     ${onlyOpen ? 'WHERE e.resolved = 0' : ''} ORDER BY e.id DESC LIMIT 300`
  );
  return { errors: rows };
});
route('POST', '/api/errors/:id/resolve', STAFF, async ({ user, params }) => {
  run('UPDATE error_logs SET resolved=1, resolved_by=?, resolved_at=? WHERE id=?', user.id, nowIso(), Number(params.id));
  return { ok: true };
});
route('POST', '/api/errors/resolve-all', STAFF, async ({ user }) => {
  run("UPDATE error_logs SET resolved=1, resolved_by=?, resolved_at=? WHERE resolved=0 AND type != 'manual_request'", user.id, nowIso());
  return { ok: true };
});

// ---------------------------------------------------------------- ROUTES: export Excel
route('GET', '/api/export.xlsx', STAFF, async ({ res }) => {
  const s = getSettings();
  const tz = s.timezone;
  const w = eventWindow(s);
  const people = all('SELECT * FROM participants ORDER BY name COLLATE NOCASE');
  const atts = new Map(
    all(
      `SELECT a.*, u.name AS verifier FROM attendance a
       LEFT JOIN manual_requests m ON m.id = a.request_id
       LEFT JOIN users u ON u.id = m.reviewed_by`
    ).map((a) => [a.participant_id, a])
  );
  const METHOD = { face: 'Wajah', manual: 'Manual (disetujui verifikator)', admin: 'Manual (admin)' };
  const rows = people.map((p, i) => {
    const a = atts.get(p.id);
    const status = a ? (a.status === 'hadir' ? 'Hadir' : 'Terlambat') : 'Tidak Hadir';
    return {
      no: i + 1,
      serial: p.serial_code,
      name: p.name,
      inst: p.institution,
      status,
      time: a ? formatTime(Date.parse(a.scanned_at), tz) : '',
      late: a && a.status === 'terlambat' ? a.late_minutes : '',
      method: a ? METHOD[a.method] : '',
      verifier: a && a.method === 'manual' ? a.verifier || '' : '',
      note: a ? a.note || '' : '',
    };
  });
  const sty = { Hadir: STYLE.green, Terlambat: STYLE.amber, 'Tidak Hadir': STYLE.red };
  const H = (t) => ({ v: t, s: STYLE.header });
  const header = ['No', 'Kode Seri', 'Nama', 'Instansi/Kelompok', 'Status', 'Jam Absen', 'Terlambat (menit)', 'Metode', 'Diverifikasi Oleh', 'Catatan'].map(H);
  const toRow = (r, no) => [no, r.serial, r.name, r.inst, { v: r.status, s: sty[r.status] }, r.time, r.late, r.method, r.verifier, r.note];
  const mk = (name, list) => ({
    name,
    widths: [6, 17, 32, 26, 14, 12, 18, 30, 22, 36],
    freezeRow: 1,
    autoFilter: `A1:J${list.length + 1}`,
    rows: [header, ...list.map((r, i) => toRow(r, i + 1))],
  });
  const hadir = rows.filter((r) => r.status === 'Hadir');
  const telat = rows.filter((r) => r.status === 'Terlambat');
  const absen = rows.filter((r) => r.status === 'Tidak Hadir');
  const total = rows.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  const summary = {
    name: 'Ringkasan',
    widths: [30, 18, 14],
    rows: [
      [{ v: `Rekap Absensi — ${s.event_name}`, s: STYLE.title }],
      [],
      [{ v: 'Tanggal acara', s: STYLE.bold }, s.event_date],
      [{ v: 'Jam absensi dibuka', s: STYLE.bold }, formatTime(w.open, tz).slice(0, 5)],
      [{ v: 'Batas tepat waktu (setelahnya terlambat)', s: STYLE.bold }, formatTime(w.late, tz).slice(0, 5)],
      [{ v: 'Jam absensi ditutup', s: STYLE.bold }, formatTime(w.close, tz).slice(0, 5)],
      [{ v: 'Zona waktu', s: STYLE.bold }, tz],
      [{ v: 'Diekspor pada', s: STYLE.bold }, formatDateTime(Date.now(), tz)],
      [],
      [H('Keterangan'), H('Jumlah'), H('Persentase (%)')],
      [{ v: 'Total peserta', s: STYLE.bold }, total, 100],
      [{ v: 'Hadir (tepat waktu)', s: STYLE.green }, hadir.length, pct(hadir.length)],
      [{ v: 'Terlambat', s: STYLE.amber }, telat.length, pct(telat.length)],
      [{ v: 'Tidak hadir', s: STYLE.red }, absen.length, pct(absen.length)],
    ],
  };
  const buf = buildXlsx([summary, mk('Semua Peserta', rows), mk('Hadir', hadir), mk('Terlambat', telat), mk('Tidak Hadir', absen)]);
  const fname = `absensi-${s.event_name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'acara'}-${s.event_date}.xlsx`;
  send(res, 200, buf, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fname}"`,
  });
});

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: 'Tidak ditemukan' });
  }
  const ext = path.extname(file).toLowerCase();
  const vendor = rel.startsWith('/vendor/');
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': vendor ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Metode tidak diizinkan' });
      return serveStatic(req, res, url.pathname);
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Endpoint tidak ditemukan' });
    const m = r.re.exec(url.pathname);
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const user = getUser(req);
    if (r.roles) {
      if (!user) throw new HttpError(401, 'Silakan login terlebih dahulu');
      if (!r.roles.includes(user.role)) throw new HttpError(403, 'Kamu tidak punya akses ke fitur ini');
    }
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json') && Number(req.headers['content-length'] || 0) > 0) throw new HttpError(415, 'Content-Type harus application/json');
      body = await readBody(req);
    }
    const query = Object.fromEntries(url.searchParams);
    const out = await r.handler({ req, res, user, params, body, query });
    if (!res.writableEnded && !res.headersSent) send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    logError('server', `${req.method} ${req.url}: ${e.message}`);
    send(res, 500, { error: 'Terjadi kesalahan pada server' });
  }
});

// ---------------------------------------------------------------- seed admin
function seed() {
  const n = one('SELECT COUNT(*) AS n FROM users').n;
  if (n > 0) return;
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  run('INSERT INTO users(username,name,role,pass_hash,active,created_at) VALUES(?,?,?,?,1,?)', 'admin', 'Administrator', 'admin', hashPassword(pw), nowIso());
  console.log('\n==============================================================');
  console.log(' Akun admin pertama dibuat:');
  console.log('   username : admin');
  console.log(`   password : ${pw}`);
  console.log(' Segera login lalu ganti password (tombol "Ganti Password").');
  console.log(' Lupa password? jalankan: npm run reset-password -- admin PasswordBaru123');
  console.log('==============================================================\n');
}

if (require.main === module) {
  seed();
  server.listen(PORT, HOST, () => {
    console.log(`Absensi Wajah berjalan di http://${HOST}:${PORT}`);
    console.log('Untuk akses kamera dari perangkat lain, gunakan HTTPS (lihat README: tailscale serve).');
  });
}

module.exports = { server, db, hashPassword };
