/* Inti aplikasi: API, login, kerangka dashboard, tampilan Admin / Co-Admin. */
const App = (() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { me: null, status: null, tab: null, viewTimer: null, cleanup: null, globalTimer: null };
  const views = {};

  // ------------------------------------------------------------ util
  async function api(url, { method = 'GET', body } = {}) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (!r.ok) {
      if (r.status === 401 && state.me && url !== '/api/login') {
        state.me = null;
        renderLogin('Sesi berakhir, silakan login kembali.');
      }
      throw Object.assign(new Error(data.error || `Kesalahan (${r.status})`), { status: r.status, data });
    }
    return data;
  }
  function toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
  }
  const fail = (e) => toast(e.message || String(e), 'err');

  function openModal(html, { wide = false, onClose } = {}) {
    const root = $('#modal-root');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    root.appendChild(ov);
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    function close() {
      document.removeEventListener('keydown', onKey);
      ov.remove();
      if (onClose) onClose();
    }
    const first = $('input, select, textarea', ov);
    if (first) first.focus();
    return { el: ov.firstElementChild, close };
  }

  const tz = () => (state.status && state.status.settings.timezone) || 'Asia/Jakarta';
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz(), hour12: false }) : '—');
  const fmtDT = (iso) =>
    iso
      ? new Date(iso).toLocaleString('en-GB', { timeZone: tz(), hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
  const METHOD = { face: 'Wajah', manual: 'Manual (diverifikasi)', admin: 'Manual (admin)' };
  const STATUS_LABEL = { hadir: 'Hadir', terlambat: 'Terlambat', belum: 'Belum hadir' };
  const ROLE_LABEL = { admin: 'Admin', coadmin: 'Co-Admin', panitia: 'Panitia' };
  const REASON_LABEL = { face_not_found: 'Wajah tidak terdeteksi/dikenali', db_error: 'Data peserta error / tidak ada di database', other: 'Lainnya' };
  const statusPill = (a) => (a ? `<span class="pill ${a.status}">${STATUS_LABEL[a.status]}${a.status === 'terlambat' ? ` (+${a.late_minutes} mnt)` : ''}</span>` : '<span class="pill belum">Belum hadir</span>');

  function stopView() {
    if (state.viewTimer) clearInterval(state.viewTimer);
    state.viewTimer = null;
    if (state.cleanup) {
      try {
        state.cleanup();
      } catch (e) {
        console.error(e);
      }
    }
    state.cleanup = null;
  }
  function poll(fn, ms) {
    if (state.viewTimer) clearInterval(state.viewTimer);
    state.viewTimer = setInterval(() => {
      if (document.hidden || $('#modal-root').children.length) return;
      fn().catch(() => {});
    }, ms);
  }

  function statusBanner() {
    const st = state.status;
    if (!st) return '';
    const s = st.settings;
    const msg = {
      open: `Absensi dibuka — tepat waktu sampai ${s.late_time}`,
      late: `Absensi dibuka — peserta yang absen sekarang dihitung TERLAMBAT (batas ${s.late_time}, tutup ${s.end_time})`,
      before: `Absensi belum dibuka — buka ${s.event_date} pukul ${s.start_time}`,
      closed: `Absensi sudah ditutup (${s.event_date} pukul ${s.end_time})`,
    }[st.state];
    return `<div class="banner ${st.state === 'open' ? 'open' : st.state}">${esc(msg)}</div>`;
  }

  async function refreshStatus() {
    const st = await api('/api/status');
    state.status = st;
    const ev = $('#ev-name');
    if (ev) ev.textContent = st.settings.event_name;
    setBadge('#nav-verify', st.stats.pending_requests);
    setBadge('#nav-errors', st.stats.open_errors);
    return st;
  }
  function setBadge(sel, n) {
    const b = $(sel);
    if (!b) return;
    let el = $('.badge', b);
    if (n > 0) {
      if (!el) {
        el = document.createElement('span');
        el.className = 'badge';
        b.appendChild(el);
      }
      el.textContent = n;
    } else if (el) el.remove();
  }

  // ------------------------------------------------------------ login & kerangka
  function renderLogin(msg = '') {
    stopView();
    clearInterval(state.globalTimer);
    $('#app').innerHTML = `
      <div class="login-wrap"><form class="card login-card" id="login-form" autocomplete="on">
        <h1>Absensi Wajah</h1><p class="muted" style="margin-top:0">Masuk sebagai Admin, Co-Admin, atau Panitia</p>
        <label class="f">Username<input name="username" autocomplete="username" required autofocus></label>
        <label class="f">Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" style="width:100%">Masuk</button>
        <p class="err" id="login-err">${esc(msg)}</p>
      </form></div>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('/api/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
        state.me = r.user;
        await renderShell();
      } catch (err) {
        $('#login-err').textContent = err.message;
      }
    });
  }

  const TABS = {
    admin: [
      ['overview', 'Ringkasan'],
      ['participants', 'Peserta'],
      ['verify', 'Verifikasi'],
      ['errors', 'Error'],
      ['scan', 'Scan Wajah'],
      ['users', 'Pengguna'],
      ['settings', 'Pengaturan'],
    ],
    coadmin: [
      ['overview', 'Ringkasan'],
      ['participants', 'Peserta'],
      ['verify', 'Verifikasi'],
      ['errors', 'Error'],
      ['scan', 'Scan Wajah'],
    ],
    panitia: [
      ['scan', 'Scan Wajah'],
      ['mine', 'Pengajuan Saya'],
    ],
  };

  async function renderShell() {
    const me = state.me;
    await refreshStatus().catch(() => {});
    $('#app').innerHTML = `
      <header class="topbar">
        <div class="brand"><span id="ev-name">${esc(state.status ? state.status.settings.event_name : 'Absensi')}</span><small>Sistem Absensi Wajah</small></div>
        <div class="userbox"><span>${esc(me.name)}</span><span class="role">${ROLE_LABEL[me.role]}</span>
          <button class="btn sm" id="btn-pw">Ganti Password</button><button class="btn sm" id="btn-logout">Keluar</button></div>
      </header>
      <nav class="nav" id="nav">${TABS[me.role].map(([k, l]) => `<button data-tab="${k}" id="nav-${k}">${l}</button>`).join('')}</nav>
      <main id="view"></main>`;
    $('#btn-logout').onclick = async () => {
      stopView();
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      state.me = null;
      renderLogin();
    };
    $('#btn-pw').onclick = changePassword;
    $('#nav').onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) switchTab(b.dataset.tab);
    };
    clearInterval(state.globalTimer);
    state.globalTimer = setInterval(() => !document.hidden && refreshStatus().catch(() => {}), 10000);
    refreshStatus().catch(() => {});
    switchTab(TABS[me.role][0][0]);
  }

  async function switchTab(tab) {
    stopView();
    state.tab = tab;
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const v = $('#view');
    v.onclick = null;
    v.innerHTML = '<p class="muted">Memuat…</p>';
    try {
      await views[tab](v);
    } catch (e) {
      v.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`;
    }
  }

  function changePassword() {
    const m = openModal(`<h2>Ganti Password</h2>
      <form id="pw-form"><label class="f">Password lama<input type="password" name="o" required autocomplete="current-password"></label>
      <label class="f">Password baru<span class="hint">Minimal 8 karakter</span><input type="password" name="n" required minlength="8" autocomplete="new-password"></label>
      <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Simpan</button></div></form>`);
    $('[data-x]', m.el).onclick = m.close;
    $('#pw-form', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/password', { method: 'POST', body: { old_password: fd.get('o'), new_password: fd.get('n') } });
        toast('Password diubah', 'ok');
        m.close();
      } catch (err) {
        fail(err);
      }
    };
  }

  // ------------------------------------------------------------ RINGKASAN
  views.overview = async (v) => {
    v.innerHTML = `<div id="ov-banner"></div><div class="grid stats" id="ov-stats"></div>
      <div class="card" style="margin-top:14px">
        <div class="row between" style="margin-bottom:10px">
          <div class="row"><input id="ov-q" placeholder="Cari nama / kode seri…" style="width:240px">
            <select id="ov-f" style="width:auto"><option value="all">Semua</option><option value="hadir">Hadir tepat waktu</option><option value="terlambat">Terlambat</option><option value="belum">Belum hadir</option></select></div>
          <div class="row"><span class="muted small">● Pembaruan otomatis tiap 5 detik</span><a class="btn primary" href="/api/export.xlsx">Export Excel</a></div>
        </div><div class="tablewrap" id="ov-table"></div></div>`;
    let data = [];
    const paint = () => {
      const q = $('#ov-q').value.trim().toLowerCase(),
        f = $('#ov-f').value;
      const n = (fn) => data.filter(fn).length;
      $('#ov-banner').innerHTML = statusBanner();
      $('#ov-stats').innerHTML = [
        ['', data.length, 'Total peserta'],
        ['ok', n((p) => p.attendance && p.attendance.status === 'hadir'), 'Hadir tepat waktu'],
        ['warn', n((p) => p.attendance && p.attendance.status === 'terlambat'), 'Terlambat'],
        ['bad', n((p) => !p.attendance), 'Belum hadir'],
      ]
        .map(([c, num, l]) => `<div class="card stat ${c}"><div class="n">${num}</div><div class="l">${l}</div></div>`)
        .join('');
      let rows = data.filter((p) => {
        if (q && !(p.name.toLowerCase().includes(q) || p.serial_code.toLowerCase().includes(q) || p.institution.toLowerCase().includes(q))) return false;
        if (f === 'belum') return !p.attendance;
        if (f === 'hadir' || f === 'terlambat') return p.attendance && p.attendance.status === f;
        return true;
      });
      rows.sort((a, b) => {
        if (a.attendance && b.attendance) return b.attendance.scanned_at.localeCompare(a.attendance.scanned_at);
        if (a.attendance) return -1;
        if (b.attendance) return 1;
        return a.name.localeCompare(b.name);
      });
      $('#ov-table').innerHTML = rows.length
        ? `<table><thead><tr><th>Nama</th><th>Kode seri</th><th>Instansi</th><th>Status</th><th>Jam absen</th><th>Metode</th></tr></thead><tbody>${rows
            .map(
              (p) => `<tr><td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.serial_code)}</td><td>${esc(p.institution) || '<span class="muted">—</span>'}</td>
              <td>${statusPill(p.attendance)}</td><td>${p.attendance ? fmtTime(p.attendance.scanned_at) : '—'}</td><td>${p.attendance ? METHOD[p.attendance.method] : '—'}</td></tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="empty">Tidak ada data yang cocok.</div>';
    };
    const load = async () => {
      const [pr] = await Promise.all([api('/api/participants'), refreshStatus()]);
      data = pr.participants;
      paint();
    };
    $('#ov-q').oninput = paint;
    $('#ov-f').onchange = paint;
    await load();
    poll(load, 5000);
  };

  // ------------------------------------------------------------ PESERTA
  views.participants = async (v) => {
    const isAdmin = state.me.role === 'admin';
    v.innerHTML = `<div class="card">
      <div class="row between" style="margin-bottom:10px"><div class="row"><h2>Data Peserta</h2><span class="muted" id="pt-count"></span></div>
        <div class="row"><input id="pt-q" placeholder="Cari…" style="width:200px">
          ${isAdmin ? '<button class="btn primary" id="pt-add">+ Tambah</button><button class="btn" id="pt-import">Impor daftar</button>' : ''}
          <button class="btn" id="pt-print">Cetak kode seri</button></div></div>
      <div id="pt-warn"></div><div class="tablewrap" id="pt-table"></div></div>`;
    let data = [];
    const paint = () => {
      const q = $('#pt-q').value.trim().toLowerCase();
      const rows = data.filter((p) => !q || p.name.toLowerCase().includes(q) || p.serial_code.toLowerCase().includes(q) || p.institution.toLowerCase().includes(q));
      const noFace = data.filter((p) => !p.face_count).length;
      $('#pt-count').textContent = `${data.length} peserta`;
      $('#pt-warn').innerHTML = noFace ? `<div class="banner late">${noFace} peserta belum punya data wajah — absensi wajah belum bisa dipakai untuk mereka.</div>` : '';
      $('#pt-table').innerHTML = rows.length
        ? `<table><thead><tr><th>Nama</th><th>Kode seri</th><th>Instansi</th><th>Wajah</th><th>Absensi</th>${isAdmin ? '<th></th>' : ''}</tr></thead><tbody>${rows
            .map(
              (p) => `<tr data-id="${p.id}"><td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.serial_code)}</td><td>${esc(p.institution) || '<span class="muted">—</span>'}</td>
            <td>${p.face_count ? `<span class="pill hadir">${p.face_count} sampel</span>` : '<span class="pill belum">Belum ada</span>'}</td>
            <td>${statusPill(p.attendance)}</td>
            ${
              isAdmin
                ? `<td class="actions"><button class="btn sm" data-a="face">Wajah</button><button class="btn sm" data-a="edit">Edit</button>
                  ${p.attendance ? '<button class="btn sm danger" data-a="unatt">Batalkan absen</button>' : '<button class="btn sm" data-a="att">Absen manual</button>'}
                  <button class="btn sm danger" data-a="del">Hapus</button></td>`
                : ''
            }</tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="empty">Belum ada peserta. Klik “Tambah” atau “Impor daftar”.</div>';
    };
    const load = async () => {
      data = (await api('/api/participants')).participants;
      paint();
    };
    $('#pt-q').oninput = paint;
    $('#pt-print').onclick = () => printCodes(data);
    if (isAdmin) {
      $('#pt-add').onclick = () => participantForm(null, load);
      $('#pt-import').onclick = () => importForm(load);
      v.onclick = async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const p = data.find((x) => x.id === Number(b.closest('tr').dataset.id));
        const a = b.dataset.a;
        try {
          if (a === 'edit') participantForm(p, load);
          else if (a === 'face') faceForm(p, load);
          else if (a === 'att') manualAttendForm(p, load);
          else if (a === 'unatt') {
            if (confirm(`Batalkan absensi ${p.name}?`)) {
              await api(`/api/attendance/${p.id}`, { method: 'DELETE' });
              toast('Absensi dibatalkan', 'ok');
              await load();
            }
          } else if (a === 'del') {
            if (confirm(`Hapus peserta "${p.name}" beserta data wajah & absensinya? Tindakan ini tidak bisa dibatalkan.`)) {
              await api(`/api/participants/${p.id}`, { method: 'DELETE' });
              toast('Peserta dihapus', 'ok');
              await load();
            }
          }
        } catch (err) {
          fail(err);
        }
      };
    }
    await load();
    poll(load, 10000);
  };

  function participantForm(p, done) {
    const m = openModal(`<h2>${p ? 'Edit' : 'Tambah'} Peserta</h2>
      <form id="pf"><label class="f">Nama lengkap<input name="name" required maxlength="100" value="${esc(p ? p.name : '')}"></label>
      <label class="f">Instansi / kelompok <span class="hint">Opsional</span><input name="institution" maxlength="100" value="${esc(p ? p.institution : '')}"></label>
      ${p ? `<p class="muted small">Kode seri: <b class="mono">${esc(p.serial_code)}</b> (tidak dapat diubah)</p>` : '<p class="muted small">Kode seri unik dibuat otomatis.</p>'}
      <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Simpan</button></div></form>`);
    $('[data-x]', m.el).onclick = m.close;
    $('#pf', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { name: fd.get('name'), institution: fd.get('institution') };
      try {
        if (p) await api(`/api/participants/${p.id}`, { method: 'PUT', body });
        else {
          const r = await api('/api/participants', { method: 'POST', body });
          toast(`Peserta ditambahkan. Kode seri: ${r.serial_code}`, 'ok');
        }
        m.close();
        done();
      } catch (err) {
        fail(err);
      }
    };
  }

  function importForm(done) {
    const m = openModal(`<h2>Impor Daftar Peserta</h2>
      <p class="muted small">Tempel satu peserta per baris: <b>Nama</b> lalu (opsional) <b>Instansi</b>, dipisah koma, titik koma, atau tab (bisa langsung salin dari Excel). Kode seri dibuat otomatis.</p>
      <textarea id="imp-t" rows="9" placeholder="Budi Santoso, Tim A&#10;Siti Aminah, Tim B"></textarea>
      <label class="f" style="margin-top:8px">…atau pilih berkas CSV/TXT<input type="file" id="imp-f" accept=".csv,.txt,.tsv,text/plain"></label>
      <p class="small" id="imp-c"></p>
      <div class="foot"><button class="btn" data-x>Batal</button><button class="btn primary" id="imp-go">Impor</button></div>`);
    const parse = () =>
      $('#imp-t', m.el)
        .value.split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, ...rest] = l.split(/\t|;|,/);
          return { name: (name || '').trim(), institution: rest.join(' ').trim() };
        })
        .filter((r) => r.name);
    const upd = () => ($('#imp-c', m.el).textContent = `${parse().length} baris terbaca`);
    $('#imp-t', m.el).oninput = upd;
    $('#imp-f', m.el).onchange = async (e) => {
      const f = e.target.files[0];
      if (f) {
        $('#imp-t', m.el).value = await f.text();
        upd();
      }
    };
    $('[data-x]', m.el).onclick = m.close;
    $('#imp-go', m.el).onclick = async () => {
      const rows = parse();
      if (!rows.length) return toast('Belum ada data', 'err');
      try {
        const r = await api('/api/participants/import', { method: 'POST', body: { rows } });
        toast(`${r.created.length} peserta diimpor`, 'ok');
        m.close();
        done();
      } catch (err) {
        fail(err);
      }
    };
  }

  function printCodes(list) {
    if (!list.length) return toast('Belum ada peserta', 'err');
    const ev = state.status ? state.status.settings.event_name : '';
    const w = window.open('', '_blank');
    if (!w) return toast('Pop-up diblokir browser. Izinkan pop-up lalu coba lagi.', 'err');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Kode Seri Peserta</title>
      <style>body{font-family:system-ui,sans-serif;margin:16px}h1{font-size:16px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
      .c{border:1px dashed #888;border-radius:8px;padding:10px;break-inside:avoid}.c small{color:#555}.c b{display:block;font-size:15px;margin:2px 0}
      .c code{font-size:18px;font-weight:700;letter-spacing:.05em}@media print{h1{display:none}}</style>
      <h1>Kode seri peserta — ${esc(ev)} <button onclick="print()">Cetak</button></h1><div class="g">
      ${list.map((p) => `<div class="c"><small>${esc(ev)}</small><b>${esc(p.name)}</b><small>${esc(p.institution)}</small><br><code>${esc(p.serial_code)}</code></div>`).join('')}</div>
      <script>setTimeout(()=>print(),300)<\/script>`);
    w.document.close();
  }

  function manualAttendForm(p, done) {
    const m = openModal(`<h2>Absen manual oleh admin</h2><p>Peserta: <b>${esc(p.name)}</b> <span class="mono muted">${esc(p.serial_code)}</span></p>
      <form id="ma"><label class="f">Status<select name="status"><option value="auto">Otomatis (sesuai jam sekarang)</option><option value="hadir">Hadir tepat waktu</option><option value="terlambat">Terlambat</option></select></label>
      <label class="f">Alasan (wajib, tercatat di laporan)<textarea name="note" rows="3" required maxlength="300" placeholder="Contoh: kamera peserta bermasalah, identitas sudah dicek langsung"></textarea></label>
      <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Catat hadir</button></div></form>`);
    $('[data-x]', m.el).onclick = m.close;
    $('#ma', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/attendance/admin', { method: 'POST', body: { participant_id: p.id, status: fd.get('status'), note: fd.get('note') } });
        toast('Absensi manual dicatat', 'ok');
        m.close();
        done();
      } catch (err) {
        fail(err);
      }
    };
  }

  // Cari peserta LAIN yang wajahnya cocok dengan descriptor baru (memakai ambang yang sama dengan scan)
  async function findFaceDuplicates(p, descriptor) {
    const [d, pr] = await Promise.all([api('/api/descriptors'), api('/api/participants')]);
    const info = new Map(pr.participants.map((x) => [x.id, x]));
    const out = [];
    for (const o of d.people) {
      if (o.id === p.id || !info.has(o.id)) continue;
      let best = 9;
      for (const ds of o.descriptors) best = Math.min(best, Face.distance(ds, descriptor));
      if (best < d.threshold) out.push({ ...info.get(o.id), distance: best, threshold: d.threshold });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // Dialog: wajah ini sebenarnya milik siapa? -> {action:'owner',id,name} | {action:'self'} | {action:'different'} | null
  function askDuplicate(p, dupes, photo) {
    return new Promise((resolve) => {
      let settled = false;
      const names = dupes.map((d) => esc(d.name)).join(', ');
      const me = esc(p.name);
      const onEsc = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      };
      function finish(v) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onEsc, true);
        m.close();
        resolve(v);
      }
      const m = openModal(
        `<h2>⚠ Wajah ini sudah terdaftar</h2>
        <p>Wajah yang akan didaftarkan untuk <b>${me}</b> sangat cocok dengan data wajah yang sudah ada milik <b>${names}</b>. Siapa pemilik wajah ini sebenarnya?</p>
        <div class="thumbs"><figure><img src="${photo}" alt=""><figcaption>Foto baru (untuk ${me})</figcaption></figure>
        ${dupes.map((d) => `<figure>${d.has_photo ? `<img src="/api/participants/${d.id}/photo?t=${Date.now()}" alt="">` : '<img alt="" style="visibility:hidden">'}<figcaption>${esc(d.name)}${d.has_photo ? '' : ' (tanpa foto)'}<br>jarak ${d.distance.toFixed(2)}</figcaption></figure>`).join('')}</div>
        <p class="muted small">Jarak makin kecil = makin mirip (batas pengenalan ${dupes[0].threshold.toFixed(2)}).</p>
        ${dupes.map((d, i) => `<button class="btn choice" data-a="owner" data-i="${i}"><b>Wajah ini milik ${esc(d.name)}</b><span>Data wajah ${esc(d.name)} tidak berubah. ${me} tidak didaftarkan wajah ini.</span></button>`).join('')}
        <button class="btn choice warn" data-a="self"><b>Wajah ini milik ${me}</b><span>Disimpan untuk ${me}. Data wajah ${names} akan <b>dihapus otomatis</b> (daftarkan ulang dengan foto yang benar).</span></button>
        <button class="btn choice" data-a="different"><b>Memang mirip, tetapi orang berbeda</b><span>Disimpan untuk ${me}; data wajah ${names} tetap ada. Dua orang yang sangat mirip bisa membuat scan ragu dan menolak otomatis — pakai absen manual bila perlu.</span></button>
        <div class="foot"><button class="btn" data-a="cancel">Batal</button></div>`,
        { onClose: () => finish(null) }
      );
      document.addEventListener('keydown', onEsc, true);
      m.el.onclick = (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const a = b.dataset.a;
        if (a === 'cancel') return finish(null);
        if (a === 'owner') {
          const d = dupes[Number(b.dataset.i)];
          return finish({ action: 'owner', id: d.id, name: d.name });
        }
        if (a === 'self' && !confirm(`Data wajah ${dupes.map((d) => d.name).join(', ')} akan dihapus dan diganti wajah baru milik ${p.name}. Lanjutkan?`)) return;
        finish({ action: a });
      };
    });
  }

  // Pendaftaran wajah (admin)
  function faceForm(p, done) {
    let video, stream, captured = null, saved = p.face_count;
    const m = openModal(
      `<h2>Data wajah — ${esc(p.name)}</h2>
      <div class="formgrid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
        <div>
          <div class="camera"><video id="fv" playsinline muted></video><div class="placeholder" id="fph">Kamera belum menyala</div></div>
          <div class="row" style="margin-top:8px"><button class="btn" id="f-cam">Nyalakan kamera</button><button class="btn primary" id="f-snap" disabled>Ambil foto</button></div>
          <div id="f-camsel"></div>
          <label class="f" style="margin-top:10px">…atau unggah foto<input type="file" id="f-file" accept="image/*"></label>
        </div>
        <div>
          <div class="thumbs"><figure><img id="f-prev" alt="" style="display:none"><figcaption id="f-cap">Belum ada foto diambil</figcaption></figure>
          ${p.has_photo ? `<figure><img src="/api/participants/${p.id}/photo?t=${Date.now()}" alt=""><figcaption>Foto tersimpan</figcaption></figure>` : ''}</div>
          <p class="small" id="f-res" style="min-height:2.6em"></p>
          <label class="chk"><input type="checkbox" id="f-rep"> Hapus sampel lama (ganti total)</label>
          <p class="muted small">Tersimpan: <b id="f-n">${saved}</b> sampel. Disarankan 2–3 sampel (wajah lurus, sedikit menoleh, pencahayaan berbeda) agar lebih akurat. Maksimal 5.</p>
          <button class="btn ok" id="f-save" disabled>Simpan sebagai sampel</button>
        </div>
      </div>
      <div class="foot"><button class="btn danger" id="f-clear">Hapus semua data wajah</button><button class="btn" id="f-close">Selesai</button></div>`,
      { wide: true, onClose: () => { if (video) Face.stopCamera(video); done(); } }
    );
    const el = m.el;
    video = $('#fv', el);
    const res = (t, cls = '') => ($('#f-res', el).innerHTML = cls ? `<span class="${cls}">${t}</span>` : t);
    Face.cameraPicker($('#f-camsel', el), video, (msg) => res('✖ ' + esc(msg), 'err'));
    video.addEventListener('cameralost', () => {
      Face.stopCamera(video);
      $('#fph', el).classList.remove('hidden');
      $('#fph', el).textContent = 'Kamera terputus';
      $('#f-snap', el).disabled = true;
      res('✖ Kamera terputus. Pilih kamera lain di daftar “Kamera”, lalu klik “Nyalakan kamera”.', 'err');
    });

    async function analyze(dataUrl) {
      captured = null;
      $('#f-save', el).disabled = true;
      $('#f-prev', el).src = dataUrl;
      $('#f-prev', el).style.display = '';
      $('#f-cap', el).textContent = 'Foto yang akan disimpan';
      res('Menganalisis wajah…');
      try {
        await Face.load();
        const dets = await Face.detectPhoto(dataUrl);
        if (dets.length === 0) return res('✖ Wajah tidak terdeteksi. Pastikan wajah terlihat jelas dan cukup terang.', 'err');
        if (dets.length > 1) return res('✖ Terdeteksi lebih dari satu wajah. Gunakan foto satu orang.', 'err');
        const d = dets[0];
        if (d.detection.score < 0.7 || d.detection.box.width < 80) return res('✖ Wajah terlalu kecil/kurang jelas. Dekatkan wajah dan perbaiki cahaya.', 'err');
        captured = { descriptor: Array.from(d.descriptor), photo: dataUrl };
        $('#f-save', el).disabled = false;
        res(`✔ Wajah terdeteksi (kualitas ${Math.round(d.detection.score * 100)}%). Klik “Simpan sebagai sampel”.`, 'ok');
      } catch (e) {
        res('✖ ' + esc(e.message), 'err');
      }
    }
    $('#f-cam', el).onclick = async () => {
      try {
        res('Memuat model & kamera…');
        await Face.load();
        stream = await Face.startCamera(video);
        $('#fph', el).classList.add('hidden');
        $('#f-snap', el).disabled = false;
        res('');
      } catch (e) {
        res('✖ ' + esc(e.message), 'err');
      }
    };
    $('#f-snap', el).onclick = () => analyze(Face.snapshot(video, 640, 0.88));
    $('#f-file', el).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        await analyze(await Face.fileToJpegDataUrl(f, 640));
      } catch (err) {
        res('✖ ' + esc(err.message), 'err');
      }
    };
    $('#f-save', el).onclick = async () => {
      if (!captured) return;
      const btn = $('#f-save', el);
      btn.disabled = true;
      try {
        // Cek apakah wajah ini sudah terdaftar atas nama peserta lain
        const dupes = await findFaceDuplicates(p, captured.descriptor);
        let removeIds = [];
        if (dupes.length) {
          const c = await askDuplicate(p, dupes, captured.photo);
          if (!c) {
            btn.disabled = false;
            return;
          }
          if (c.action === 'owner') {
            captured = null;
            toast(`Wajah tidak disimpan untuk ${p.name} — dikenali milik ${c.name}`, 'ok');
            res(`Wajah ini dikenali sebagai milik <b>${esc(c.name)}</b>, jadi <b>tidak</b> didaftarkan untuk ${esc(p.name)}. Data wajah ${esc(c.name)} tidak berubah.`);
            return;
          }
          if (c.action === 'self') removeIds = dupes.map((d) => d.id);
        }
        const r = await api(`/api/participants/${p.id}/face`, { method: 'POST', body: { ...captured, replace: $('#f-rep', el).checked } });
        for (const id of removeIds) await api(`/api/participants/${id}/face`, { method: 'DELETE' }); // simpan dulu, baru hapus milik lama
        saved = r.face_count;
        p.face_count = saved;
        $('#f-n', el).textContent = saved;
        $('#f-rep', el).checked = false;
        captured = null;
        toast('Sampel wajah disimpan' + (removeIds.length ? ` — data wajah ${dupes.map((d) => d.name).join(', ')} dihapus` : ''), 'ok');
        res('Tersimpan. Tambah sampel lain atau klik “Selesai”.' + (removeIds.length ? ` Daftarkan ulang wajah ${esc(dupes.map((d) => d.name).join(', '))} dengan foto yang benar.` : ''));
      } catch (e) {
        btn.disabled = !captured;
        fail(e);
      }
    };
    $('#f-clear', el).onclick = async () => {
      if (!confirm('Hapus semua data wajah peserta ini?')) return;
      try {
        await api(`/api/participants/${p.id}/face`, { method: 'DELETE' });
        saved = 0;
        $('#f-n', el).textContent = 0;
        toast('Data wajah dihapus', 'ok');
      } catch (e) {
        fail(e);
      }
    };
    $('#f-close', el).onclick = m.close;
  }

  // ------------------------------------------------------------ VERIFIKASI
  function requestCard(r, { review = false } = {}) {
    const name = r.participant ? r.participant.name : r.claimed_name;
    return `<div class="card" data-id="${r.id}">
      <div class="row between"><div><b style="font-size:16px">${esc(name)}</b> <span class="pill ${r.status}">${{ pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' }[r.status]}</span>
        ${r.participant ? '' : '<span class="pill gray">Belum terhubung ke data peserta</span>'}</div>
        <span class="muted small">${fmtDT(r.created_at)} · diajukan ${esc(r.requested_by)}</span></div>
      <div class="small" style="margin-top:6px"><b>Alasan:</b> ${esc(REASON_LABEL[r.reason] || r.reason)}${r.note ? ` — ${esc(r.note)}` : ''}</div>
      <div class="small">Kode seri diketik: <span class="mono">${esc(r.claimed_serial)}</span> ${r.serial_match ? '<span class="pill hadir">cocok</span>' : '<span class="pill belum">tidak cocok / tidak ditemukan</span>'}</div>
      ${r.status !== 'pending' ? `<div class="small muted" style="margin-top:4px">Diproses ${esc(r.reviewed_by || '-')} · ${fmtDT(r.reviewed_at)}${r.review_note ? ` — “${esc(r.review_note)}”` : ''}</div>` : ''}
      ${review && r.status === 'pending' ? '<div style="margin-top:10px"><button class="btn primary sm" data-a="review">Tinjau & verifikasi</button></div>' : ''}</div>`;
  }

  views.verify = async (v) => {
    v.innerHTML = `<div class="row between" style="margin-bottom:12px"><h2>Verifikasi Absen Manual</h2>
      <select id="vf-s" style="width:auto"><option value="pending">Menunggu</option><option value="approved">Disetujui</option><option value="rejected">Ditolak</option><option value="">Semua</option></select></div>
      <div id="vf-list"></div>`;
    const load = async () => {
      const r = await api('/api/manual-requests' + ($('#vf-s').value ? `?status=${$('#vf-s').value}` : ''));
      $('#vf-list').innerHTML = r.requests.length ? r.requests.map((x) => requestCard(x, { review: true })).join('') : '<div class="card empty">Tidak ada pengajuan.</div>';
      v._reqs = r.requests;
      refreshStatus().catch(() => {});
    };
    $('#vf-s').onchange = load;
    v.onclick = (e) => {
      const b = e.target.closest('[data-a="review"]');
      if (!b) return;
      const r = v._reqs.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      reviewModal(r, load);
    };
    await load();
    poll(load, 6000);
  };

  async function reviewModal(r, done) {
    const people = r.participant ? [] : (await api('/api/participants')).participants.filter((p) => !p.attendance);
    const m = openModal(
      `<h2>Verifikasi pengajuan #${r.id}</h2>
      <div class="thumbs">
        <figure>${r.has_snapshot ? `<img src="/api/manual-requests/${r.id}/snapshot" alt="">` : '<img alt="" style="visibility:hidden">'}<figcaption>${r.has_snapshot ? 'Foto dari panitia (saat pengajuan)' : 'Panitia tidak melampirkan foto'}</figcaption></figure>
        <figure id="rv-ref">${r.participant && r.participant.has_photo ? `<img src="/api/participants/${r.participant.id}/photo" alt="">` : '<img alt="" style="visibility:hidden">'}<figcaption>${r.participant ? (r.participant.has_photo ? 'Foto terdaftar di database' : 'Peserta belum punya foto di database') : 'Pilih peserta di bawah'}</figcaption></figure>
      </div>
      <table style="margin-top:12px"><tbody>
        <tr><th>Nama diajukan</th><td>${esc(r.claimed_name)}</td></tr>
        <tr><th>Nama di database</th><td id="rv-dbname">${r.participant ? `<b>${esc(r.participant.name)}</b> <span class="muted">${esc(r.participant.institution)}</span>` : '<span class="muted">belum terhubung</span>'}</td></tr>
        <tr><th>Kode seri diketik</th><td><span class="mono">${esc(r.claimed_serial)}</span> ${r.serial_match ? '<span class="pill hadir">cocok dengan database</span>' : '<span class="pill belum">tidak cocok</span>'}</td></tr>
        <tr><th>Alasan</th><td>${esc(REASON_LABEL[r.reason])}${r.note ? ` — ${esc(r.note)}` : ''}<br><span class="muted small">oleh ${esc(r.requested_by)}, ${fmtDT(r.created_at)}</span></td></tr></tbody></table>
      ${
        r.participant
          ? ''
          : `<label class="f" style="margin-top:12px">Hubungkan ke peserta di database<select id="rv-link"><option value="">— pilih peserta —</option>${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.institution ? ' · ' + esc(p.institution) : ''}</option>`).join('')}</select></label>`
      }
      ${r.participant && !r.participant.has_photo ? '<div class="banner late" style="margin-top:12px">Belum ada foto referensi: pastikan identitas diverifikasi lewat nama dan kode seri (mis. minta peserta menunjukkan kartu identitas).</div>' : ''}
      <div style="margin-top:14px"><label class="chk"><input type="checkbox" id="rv-face"> Wajah orang di depan panitia sama dengan data wajah peserta di database</label>
      <label class="chk"><input type="checkbox" id="rv-name"> Nama peserta sesuai dengan data di database</label></div>
      <label class="f">Catatan / alasan (wajib bila menolak)<textarea id="rv-note" rows="2" maxlength="300"></textarea></label>
      <div class="foot"><button class="btn" data-x>Tutup</button><button class="btn danger" id="rv-rej">Tolak</button><button class="btn ok" id="rv-ok" disabled>Setujui absen manual</button></div>`,
      { wide: true }
    );
    const el = m.el;
    let linked = r.participant ? r.participant.id : null;
    const sync = () => ($('#rv-ok', el).disabled = !($('#rv-face', el).checked && $('#rv-name', el).checked && linked));
    $('#rv-face', el).onchange = $('#rv-name', el).onchange = sync;
    const link = $('#rv-link', el);
    if (link)
      link.onchange = () => {
        linked = Number(link.value) || null;
        const p = people.find((x) => x.id === linked);
        $('#rv-dbname', el).innerHTML = p ? `<b>${esc(p.name)}</b> <span class="muted">${esc(p.institution)}</span>` : '<span class="muted">belum terhubung</span>';
        $('#rv-ref', el).innerHTML = p && p.has_photo ? `<img src="/api/participants/${p.id}/photo" alt=""><figcaption>Foto terdaftar di database</figcaption>` : `<img alt="" style="visibility:hidden"><figcaption>${p ? 'Peserta belum punya foto' : 'Pilih peserta di bawah'}</figcaption>`;
        sync();
      };
    $('[data-x]', el).onclick = m.close;
    $('#rv-ok', el).onclick = async () => {
      try {
        const out = await api(`/api/manual-requests/${r.id}/approve`, {
          method: 'POST',
          body: { face_match: $('#rv-face', el).checked, name_match: $('#rv-name', el).checked, participant_id: linked, note: $('#rv-note', el).value },
        });
        toast(out.duplicate ? 'Peserta ternyata sudah hadir — pengajuan ditutup otomatis' : 'Absen manual disetujui', 'ok');
        m.close();
        done();
      } catch (e) {
        fail(e);
      }
    };
    $('#rv-rej', el).onclick = async () => {
      const note = $('#rv-note', el).value.trim();
      if (!note) return toast('Isi alasan penolakan pada kolom catatan', 'err');
      try {
        await api(`/api/manual-requests/${r.id}/reject`, { method: 'POST', body: { note } });
        toast('Pengajuan ditolak', 'ok');
        m.close();
        done();
      } catch (e) {
        fail(e);
      }
    };
  }

  views.mine = async (v) => {
    v.innerHTML = '<h2 style="margin-bottom:12px">Pengajuan Absen Manual Saya</h2><div id="mi-list"></div>';
    const load = async () => {
      const r = await api('/api/manual-requests');
      $('#mi-list').innerHTML = r.requests.length ? r.requests.map((x) => requestCard(x)).join('') : '<div class="card empty">Belum ada pengajuan.</div>';
    };
    await load();
    poll(load, 8000);
  };

  // ------------------------------------------------------------ ERROR
  const ERR_LABEL = { face_unrecognized: 'Wajah tidak dikenali', face_error: 'Error scan', db_error: 'Error database', camera: 'Kamera', manual_request: 'Pengajuan manual', server: 'Server', other: 'Lainnya' };
  views.errors = async (v) => {
    v.innerHTML = `<div class="card"><div class="row between" style="margin-bottom:10px"><h2>Log Error</h2>
      <div class="row"><select id="er-s" style="width:auto"><option value="">Belum selesai</option><option value="1">Semua</option></select><button class="btn" id="er-all">Tandai semua selesai</button></div></div>
      <div class="tablewrap" id="er-t"></div></div>`;
    const load = async () => {
      const r = await api('/api/errors' + ($('#er-s').value ? '?all=1' : ''));
      $('#er-t').innerHTML = r.errors.length
        ? `<table><thead><tr><th>Waktu</th><th>Jenis</th><th>Pesan</th><th>Status</th><th></th></tr></thead><tbody>${r.errors
            .map(
              (e) => `<tr data-id="${e.id}"><td class="small">${fmtDT(e.created_at)}</td><td><span class="pill ${e.type === 'manual_request' ? 'pending' : 'info'}">${esc(ERR_LABEL[e.type] || e.type)}</span></td><td>${esc(e.message)}</td>
              <td>${e.resolved ? `<span class="pill hadir">Selesai</span><div class="muted small">${esc(e.resolved_by_name || '')}</div>` : '<span class="pill belum">Terbuka</span>'}</td>
              <td class="actions">${e.resolved ? '' : e.type === 'manual_request' ? '<button class="btn sm" data-a="goto">Buka verifikasi</button>' : '<button class="btn sm" data-a="res">Tandai selesai</button>'}</td></tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="empty">Tidak ada error. 🎉</div>';
      refreshStatus().catch(() => {});
    };
    $('#er-s').onchange = load;
    $('#er-all').onclick = async () => {
      await api('/api/errors/resolve-all', { method: 'POST' }).catch(fail);
      load();
    };
    v.onclick = async (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'goto') return switchTab('verify');
      await api(`/api/errors/${b.closest('tr').dataset.id}/resolve`, { method: 'POST' }).catch(fail);
      load();
    };
    await load();
    poll(load, 8000);
  };

  // ------------------------------------------------------------ PENGGUNA
  views.users = async (v) => {
    v.innerHTML = `<div class="card"><div class="row between" style="margin-bottom:10px"><h2>Pengguna</h2><button class="btn primary" id="us-add">+ Tambah pengguna</button></div>
      <p class="muted small"><b>Admin</b>: semua fitur. <b>Co-Admin</b>: memantau absensi, memverifikasi absen manual, melihat error &amp; data peserta. <b>Panitia</b>: scan wajah &amp; mengajukan absen manual.</p>
      <div class="tablewrap" id="us-t"></div></div>`;
    let users = [];
    const load = async () => {
      users = (await api('/api/users')).users;
      $('#us-t').innerHTML = `<table><thead><tr><th>Nama</th><th>Username</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>${users
        .map(
          (u) => `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.username)}</td><td><span class="role">${ROLE_LABEL[u.role]}</span></td>
          <td>${u.active ? '<span class="pill hadir">Aktif</span>' : '<span class="pill belum">Nonaktif</span>'}</td><td class="actions"><button class="btn sm" data-a="edit">Edit</button></td></tr>`
        )
        .join('')}</tbody></table>`;
    };
    const form = (u) => {
      const m = openModal(`<h2>${u ? 'Edit' : 'Tambah'} Pengguna</h2><form id="uf">
        <div class="formgrid"><label class="f">Nama<input name="name" required maxlength="80" value="${esc(u ? u.name : '')}"></label>
        <label class="f">Username<input name="username" required pattern="[A-Za-z0-9_.\\-]{3,40}" ${u ? 'disabled' : ''} value="${esc(u ? u.username : '')}"></label>
        <label class="f">Peran<select name="role">${['admin', 'coadmin', 'panitia'].map((r) => `<option value="${r}" ${u && u.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></label>
        <label class="f">${u ? 'Password baru (kosongkan bila tidak diubah)' : 'Password'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label></div>
        ${u ? `<label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Akun aktif</label>` : ''}
        <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Simpan</button></div></form>`);
      $('[data-x]', m.el).onclick = m.close;
      $('#uf', m.el).onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = { name: fd.get('name'), role: fd.get('role') };
        if (fd.get('password')) body.password = fd.get('password');
        try {
          if (u) {
            body.active = fd.get('active') === 'on';
            await api(`/api/users/${u.id}`, { method: 'PUT', body });
          } else await api('/api/users', { method: 'POST', body: { ...body, username: fd.get('username'), password: fd.get('password') } });
          toast('Tersimpan', 'ok');
          m.close();
          load();
        } catch (err) {
          fail(err);
        }
      };
    };
    $('#us-add').onclick = () => form(null);
    v.onclick = (e) => {
      const b = e.target.closest('[data-a="edit"]');
      if (b) form(users.find((x) => x.id === Number(b.closest('tr').dataset.id)));
    };
    await load();
  };

  // ------------------------------------------------------------ PENGATURAN
  views.settings = async (v) => {
    const { settings: s } = await refreshStatus();
    v.innerHTML = `<div class="card" style="max-width:720px"><h2 style="margin-bottom:12px">Pengaturan Acara</h2><form id="sf">
      <label class="f">Nama acara<input name="event_name" required maxlength="100" value="${esc(s.event_name)}"></label>
      <div class="formgrid"><label class="f">Tanggal acara<input type="date" name="event_date" required value="${esc(s.event_date)}"></label>
      <label class="f">Zona waktu<span class="hint">Asia/Jakarta (WIB), Asia/Makassar (WITA), Asia/Jayapura (WIT)</span><input name="timezone" required value="${esc(s.timezone)}"></label></div>
      <div class="formgrid"><label class="f">Jam absensi dibuka<input type="time" name="start_time" required value="${esc(s.start_time)}"></label>
      <label class="f">Batas tepat waktu<span class="hint">Setelah jam ini peserta dihitung terlambat</span><input type="time" name="late_time" required value="${esc(s.late_time)}"></label>
      <label class="f">Jam absensi ditutup<input type="time" name="end_time" required value="${esc(s.end_time)}"></label></div>
      <label class="f">Ketelitian pencocokan wajah: <b id="th-v">${s.match_threshold.toFixed(2)}</b>
        <span class="hint">Lebih kecil = lebih ketat (lebih sedikit salah orang, tapi lebih sering gagal dikenali). Disarankan 0.45–0.55.</span>
        <input type="range" name="match_threshold" min="0.35" max="0.65" step="0.01" value="${s.match_threshold}"></label>
      <label class="chk"><input type="checkbox" name="require_serial" ${s.require_serial ? 'checked' : ''}> Wajib konfirmasi kode seri saat scan wajah <span class="muted small">(panitia mengetik kode seri yang ditunjukkan peserta — verifikasi ganda)</span></label>
      <label class="f">Awalan kode seri<span class="hint">Hanya untuk peserta baru. 2–6 huruf/angka.</span><input name="serial_prefix" required maxlength="6" value="${esc(s.serial_prefix)}"></label>
      <button class="btn primary">Simpan pengaturan</button></form></div>`;
    $('[name=match_threshold]', v).oninput = (e) => ($('#th-v').textContent = Number(e.target.value).toFixed(2));
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());
      body.require_serial = fd.get('require_serial') === 'on';
      try {
        state.status = await api('/api/settings', { method: 'PUT', body });
        $('#ev-name').textContent = state.status.settings.event_name;
        toast('Pengaturan disimpan', 'ok');
      } catch (err) {
        fail(err);
      }
    };
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      const r = await api('/api/me');
      if (r.user) {
        state.me = r.user;
        await renderShell();
      } else renderLogin();
    } catch (e) {
      $('#app').innerHTML = `<p class="boot">Tidak dapat terhubung ke server: ${esc(e.message)}</p>`;
    }
  }
  window.addEventListener('load', boot);

  return { $, $$, esc, api, toast, fail, openModal, state, views, fmtTime, fmtDT, statusBanner, refreshStatus, poll, stopView, REASON_LABEL, METHOD, switchTab };
})();
