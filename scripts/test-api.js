'use strict';
// Tes end-to-end API. Jalankan: npm test   (memakai database sementara, tidak menyentuh data asli)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'absensi-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
const TZ = 'Asia/Jakarta';

function hhmm(ms) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return p;
}
function dateIn(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

class Client {
  constructor() {
    this.cookie = '';
  }
  async req(method, url, body) {
    const r = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, data, headers: r.headers };
  }
}

const desc = () => Array.from({ length: 128 }, () => Math.round((Math.random() - 0.5) * 0.4 * 10000) / 10000);
// JPEG minimal valid (1x1)
const JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let step = 0;
const ok = (m) => console.log(`  ✔ ${++step}. ${m}`);

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'AdminPass123' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  srv.stdout.on('data', (d) => (logs += d));
  srv.stderr.on('data', (d) => (logs += d));
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(BASE + '/api/me');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const admin = new Client();
    const co = new Client();
    const pan = new Client();

    // --- auth
    let r = await new Client().req('POST', '/api/login', { username: 'admin', password: 'salah' });
    assert.equal(r.status, 401);
    r = await admin.req('POST', '/api/login', { username: 'admin', password: 'AdminPass123' });
    assert.equal(r.status, 200);
    ok('login admin (dan password salah ditolak)');

    r = await admin.req('POST', '/api/users', { username: 'coadmin1', name: 'Co Admin', role: 'coadmin', password: 'CoAdmin1234' });
    assert.equal(r.status, 200);
    r = await admin.req('POST', '/api/users', { username: 'panitia1', name: 'Panitia Satu', role: 'panitia', password: 'Panitia1234' });
    assert.equal(r.status, 200);
    assert.equal((await co.req('POST', '/api/login', { username: 'coadmin1', password: 'CoAdmin1234' })).status, 200);
    assert.equal((await pan.req('POST', '/api/login', { username: 'panitia1', password: 'Panitia1234' })).status, 200);
    ok('membuat & login co-admin dan panitia');

    // --- peserta
    r = await admin.req('POST', '/api/participants', { name: 'Budi Santoso', institution: 'Tim A' });
    assert.equal(r.status, 200);
    const budi = r.data;
    assert.match(budi.serial_code, /^PST-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    r = await admin.req('POST', '/api/participants/import', { rows: [{ name: 'Siti Aminah', institution: 'Tim A' }, { name: 'Andi Wijaya', institution: 'Tim B' }, { name: 'Dewi Lestari' }] });
    assert.equal(r.data.created.length, 3);
    const [siti, andi, dewi] = r.data.created;
    const codes = new Set([budi.serial_code, ...r.data.created.map((c) => c.serial_code)]);
    assert.equal(codes.size, 4);
    ok('peserta dibuat, kode seri unik');

    for (const p of [budi, siti, andi]) {
      r = await admin.req('POST', `/api/participants/${p.id}/face`, { descriptor: desc(), photo: JPEG });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    r = await admin.req('POST', `/api/participants/${budi.id}/face`, { descriptor: [1, 2, 3], photo: JPEG });
    assert.equal(r.status, 400);
    ok('registrasi wajah (descriptor tidak valid ditolak)');

    // --- hak akses
    assert.equal((await pan.req('GET', '/api/participants')).status, 403);
    assert.equal((await pan.req('POST', '/api/participants', { name: 'X' })).status, 403);
    assert.equal((await co.req('POST', '/api/participants', { name: 'X' })).status, 403);
    assert.equal((await pan.req('GET', '/api/export.xlsx')).status, 403);
    assert.equal((await new Client().req('GET', '/api/status')).status, 401);
    assert.equal((await co.req('GET', '/api/participants')).status, 200);
    ok('pembatasan peran (panitia/co-admin tidak bisa mengelola data)');

    r = await pan.req('GET', '/api/descriptors');
    assert.equal(r.status, 200);
    assert.equal(r.data.people.length, 3);
    assert.ok(!JSON.stringify(r.data).includes('PST-'), 'kode seri tidak boleh bocor ke panitia');
    r = await pan.req('GET', '/api/search?q=bud');
    assert.equal(r.data.results.length, 1);
    assert.ok(!('serial_code' in r.data.results[0]));
    ok('panitia menerima descriptor tanpa kode seri');

    // --- jam: sebelum dibuka
    const now = Date.now();
    r = await admin.req('PUT', '/api/settings', { event_name: 'Seminar Uji', event_date: dateIn(now + 86400000), start_time: '08:00', late_time: '09:00', end_time: '12:00' });
    assert.equal(r.status, 200);
    r = await pan.req('POST', '/api/attendance/face', { participant_id: budi.id, distance: 0.3 });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'before');
    // urutan jam salah
    r = await admin.req('PUT', '/api/settings', { start_time: '10:00', late_time: '09:00' });
    assert.equal(r.status, 400);
    ok('absensi sebelum jam buka ditolak; urutan jam divalidasi');

    // --- hadir tepat waktu (jendela = sekarang, batas terlambat 5 jam lagi bila memungkinkan)
    const today = dateIn(now);
    const minsNow = Number(hhmm(now).slice(0, 2)) * 60 + Number(hhmm(now).slice(3));
    if (minsNow < 60 || minsNow > 22 * 60) {
      console.log('  (melewati tes jendela waktu karena dekat tengah malam)');
    } else {
      const lateOnTime = `${String(Math.floor((minsNow + 60) / 60)).padStart(2, '0')}:00`;
      r = await admin.req('PUT', '/api/settings', { event_date: today, start_time: '00:00', late_time: lateOnTime, end_time: '23:59' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      r = await pan.req('POST', '/api/attendance/face', { participant_id: budi.id, distance: 0.3 });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.status, 'hadir');
      assert.equal(r.data.participant.name, 'Budi Santoso');
      r = await pan.req('POST', '/api/attendance/face', { participant_id: budi.id, distance: 0.3 });
      assert.equal(r.data.already, true);
      r = await pan.req('POST', '/api/attendance/face', { participant_id: siti.id, distance: 0.9 });
      assert.equal(r.status, 400, 'jarak > ambang harus ditolak');
      ok('hadir tepat waktu, absen ganda terdeteksi, skor jelek ditolak');

      // terlambat
      r = await admin.req('PUT', '/api/settings', { start_time: '00:00', late_time: '00:01', end_time: '23:59' });
      r = await pan.req('POST', '/api/attendance/face', { participant_id: siti.id, distance: 0.3 });
      assert.equal(r.data.status, 'terlambat');
      assert.ok(r.data.late_minutes > 0);
      ok(`terlambat terhitung (${r.data.late_minutes} menit)`);
    }

    // --- kode seri wajib (opsional)
    await admin.req('PUT', '/api/settings', { require_serial: true });
    r = await pan.req('POST', '/api/attendance/face', { participant_id: andi.id, distance: 0.3, serial: 'SALAH-1234' });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'serial_mismatch');
    r = await pan.req('POST', '/api/attendance/face', { participant_id: andi.id, distance: 0.3, serial: andi.serial_code.toLowerCase().replace(/-/g, ' ') });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await admin.req('PUT', '/api/settings', { require_serial: false });
    ok('konfirmasi kode seri berfungsi (tidak sensitif huruf besar/strip)');

    // --- absen manual: pengajuan -> verifikasi
    r = await pan.req('POST', '/api/manual-requests', { participant_id: dewi.id, serial: 'PST-SALAH-0000', reason: 'face_not_found' });
    assert.equal(r.status, 400);
    r = await pan.req('POST', '/api/manual-requests', { participant_id: dewi.id, serial: dewi.serial_code, reason: 'face_not_found', note: 'Wajah tertutup masker', snapshot: JPEG });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const reqId = r.data.id;
    r = await pan.req('POST', '/api/manual-requests', { participant_id: dewi.id, serial: dewi.serial_code, reason: 'other' });
    assert.equal(r.status, 400, 'pengajuan ganda harus ditolak');
    ok('pengajuan manual: kode seri harus cocok, pengajuan ganda ditolak');

    assert.equal((await pan.req('POST', `/api/manual-requests/${reqId}/approve`, { face_match: true, name_match: true })).status, 403);
    r = await admin.req('POST', `/api/manual-requests/${reqId}/approve`, { face_match: true });
    assert.equal(r.status, 400);
    r = await co.req('GET', `/api/manual-requests/${reqId}/snapshot`);
    assert.equal(r.status, 200);
    r = await co.req('POST', `/api/manual-requests/${reqId}/approve`, { face_match: true, name_match: true, note: 'Sudah dicek' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await admin.req('GET', '/api/participants');
    const d = r.data.participants.find((p) => p.id === dewi.id);
    assert.equal(d.attendance.method, 'manual');
    ok('co-admin menyetujui, absensi manual tercatat; panitia tak bisa menyetujui');

    // data tidak ada di database -> pengajuan tanpa tautan, admin menautkan
    r = await pan.req('POST', '/api/manual-requests', { claimed_name: 'Rudi Hartono', serial: 'PST-XXXX-YYYY', reason: 'db_error' });
    assert.equal(r.status, 200);
    assert.equal(r.data.linked, false);
    const req2 = r.data.id;
    r = await admin.req('POST', `/api/manual-requests/${req2}/approve`, { face_match: true, name_match: true });
    assert.equal(r.status, 400, 'tanpa tautan peserta tidak boleh disetujui');
    r = await admin.req('POST', `/api/manual-requests/${req2}/reject`, { note: 'Bukan peserta terdaftar' });
    assert.equal(r.status, 200);
    ok('pengajuan untuk data tidak ditemukan: tak bisa disetujui tanpa tautan, bisa ditolak');

    // --- admin manual + batal
    r = await admin.req('POST', `/api/attendance/admin`, { participant_id: dewi.id, note: 'x' });
    assert.equal(r.status, 400, 'sudah hadir');
    assert.equal((await admin.req('DELETE', `/api/attendance/${dewi.id}`)).status, 200);
    r = await admin.req('POST', `/api/attendance/admin`, { participant_id: dewi.id });
    assert.equal(r.status, 400, 'alasan wajib');
    r = await admin.req('POST', `/api/attendance/admin`, { participant_id: dewi.id, note: 'HP peserta hilang', status: 'hadir' });
    assert.equal(r.status, 200);
    ok('absen manual oleh admin (alasan wajib) & pembatalan');

    // --- error log
    r = await co.req('GET', '/api/errors?all=1');
    assert.ok(r.data.errors.length >= 2);
    assert.ok(r.data.errors.filter((e) => e.type === 'manual_request').every((e) => e.resolved === 1), 'log pengajuan otomatis selesai setelah diproses');
    await pan.req('POST', '/api/errors', { type: 'face_unrecognized', message: 'Wajah tidak dikenali' });
    r = await co.req('GET', '/api/errors');
    // terbuka: salah-kode-seri (langkah 10) + wajah tidak dikenali; pengajuan manual sudah selesai otomatis
    assert.deepEqual(r.data.errors.map((e) => e.type).sort(), ['face_error', 'face_unrecognized']);
    ok('error log tercatat & otomatis selesai saat pengajuan diproses');

    // --- status & statistik
    r = await admin.req('GET', '/api/status');
    assert.equal(r.data.stats.total, 4);
    assert.equal(r.data.stats.hadir + r.data.stats.terlambat, 4 - r.data.stats.belum);
    ok(`statistik: ${JSON.stringify({ t: r.data.stats.total, h: r.data.stats.hadir, l: r.data.stats.terlambat, b: r.data.stats.belum })}`);

    // --- export
    r = await co.req('GET', '/api/export.xlsx');
    assert.equal(r.status, 200);
    assert.equal(r.data.slice(0, 2).toString(), 'PK');
    const xp = path.join(DATA, 'out.xlsx');
    fs.writeFileSync(xp, r.data);
    console.log(`  → xlsx ditulis: ${xp}`);
    ok('export xlsx terunduh');

    // --- ganti password & sesi
    r = await pan.req('POST', '/api/password', { old_password: 'Panitia1234', new_password: 'Baru12345678' });
    assert.equal(r.status, 200);
    await admin.req('PUT', `/api/users/${(await admin.req('GET', '/api/users')).data.users.find((u) => u.username === 'panitia1').id}`, { active: false });
    assert.equal((await pan.req('GET', '/api/status')).status, 401);
    ok('ganti password; akun dinonaktifkan langsung kehilangan sesi');

    console.log(`\nSEMUA TES LULUS (${step}). File xlsx: ${xp}`);
    process.env.XLSX_PATH = xp;
    fs.writeFileSync(path.join(os.tmpdir(), 'absensi-last-xlsx.txt'), xp);
  } catch (e) {
    console.error('\nTES GAGAL:', e.message);
    console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    console.error('--- log server ---\n' + logs.slice(-1500));
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
