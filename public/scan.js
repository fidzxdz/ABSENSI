/* Tampilan Scan Wajah (Panitia/Admin/Co-Admin) + form pengajuan absen manual. */
(() => {
  const { $, esc, api, toast, fail, openModal, state, views, fmtTime, statusBanner, refreshStatus, REASON_LABEL } = App;

  const MATCH_STREAK = 3; // jumlah deteksi berturut-turut yang sama sebelum absen dicatat
  const UNKNOWN_FRAMES = 14; // ~3 detik wajah terdeteksi tapi tidak cocok -> tawarkan absen manual
  const MARGIN = 0.03; // selisih minimal antara kandidat terbaik & kedua (hindari ambigu)

  views.scan = async (v) => {
    v.innerHTML = `
      <div id="sc-banner"></div>
      <div class="scan-layout">
        <div>
          <div class="camera"><video id="sc-video" playsinline muted></video><canvas id="sc-overlay"></canvas>
            <div class="placeholder" id="sc-ph">Tekan “Nyalakan kamera” untuk mulai memindai wajah peserta</div>
            <div class="hint hidden" id="sc-hint"></div></div>
          <div class="row" style="margin-top:10px">
            <button class="btn primary" id="sc-start">Nyalakan kamera</button>
            <button class="btn hidden" id="sc-stop">Matikan</button>
            <button class="btn" id="sc-manual">Ajukan absen manual</button>
            <span class="muted small" id="sc-info"></span>
          </div>
          <div id="sc-cam"></div>
        </div>
        <div>
          <div class="result" id="sc-result"><div class="muted">Hasil scan akan tampil di sini</div></div>
          <div class="card" style="margin-top:14px"><div class="row between"><h3>Scan terbaru</h3><span class="muted small" id="sc-count"></span></div><div id="sc-recent" style="margin-top:8px"></div></div>
        </div>
      </div>`;

    const video = $('#sc-video'),
      overlay = $('#sc-overlay');
    Face.cameraPicker($('#sc-cam'), video, (msg) => toast(msg, 'err'));
    video.addEventListener('cameralost', () => {
      if (!S.running) return;
      stop();
      toast('Kamera terputus. Pilih kamera lain di daftar “Kamera”, lalu nyalakan lagi.', 'err');
      logClientError('camera', 'Kamera terputus saat memindai');
    });
    const S = { running: false, timer: null, people: [], threshold: 0.5, requireSerial: false, cand: null, streak: 0, unk: 0, unkShown: false, pauseUntil: 0, last: {}, snapshot: null, lastUnkLog: 0 };

    const hint = (t) => {
      const h = $('#sc-hint');
      h.textContent = t;
      h.classList.toggle('hidden', !t);
    };
    const result = (cls, html) => {
      const r = $('#sc-result');
      r.className = 'result ' + cls;
      r.innerHTML = html;
    };
    const paintBanner = () => ($('#sc-banner').innerHTML = statusBanner());

    async function loadRecent() {
      const [att, st] = await Promise.all([api('/api/attendance'), refreshStatus()]);
      paintBanner();
      $('#sc-count').textContent = `Hadir ${st.stats.hadir + st.stats.terlambat} / ${st.stats.total}`;
      const rows = att.attendance.slice(0, 12);
      $('#sc-recent').innerHTML = rows.length
        ? rows
            .map(
              (a) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><b>${esc(a.name)}</b><div class="muted small mono">${esc(a.serial_code)}</div></div>
              <div class="right"><span class="pill ${a.status}">${a.status === 'hadir' ? 'Hadir' : 'Terlambat'}</span><div class="muted small">${fmtTime(a.scanned_at)} · ${a.method === 'face' ? 'Wajah' : 'Manual'}</div></div></div>`
            )
            .join('')
        : '<div class="muted small">Belum ada.</div>';
    }

    async function loadPeople() {
      const d = await api('/api/descriptors');
      S.threshold = d.threshold;
      S.requireSerial = d.require_serial;
      S.people = d.people.map((p) => ({ id: p.id, attended: p.attended, descriptors: p.descriptors.map((x) => Float32Array.from(x)) }));
      $('#sc-info').textContent = `${S.people.length} dari ${d.total_participants} peserta punya data wajah`;
      return d;
    }

    function matchFace(q) {
      let best = { id: null, d: 9 },
        second = 9;
      for (const p of S.people) {
        let m = 9;
        for (const ds of p.descriptors) m = Math.min(m, Face.distance(ds, q));
        if (m < best.d) {
          second = best.d;
          best = { id: p.id, d: m };
        } else if (m < second) second = m;
      }
      const under = best.d < S.threshold;
      return { ...best, ok: under && second - best.d >= MARGIN, ambiguous: under && second - best.d < MARGIN };
    }

    function drawBoxes(dets, color) {
      const w = video.videoWidth,
        h = video.videoHeight;
      if (overlay.width !== w) {
        overlay.width = w;
        overlay.height = h;
      }
      const c = overlay.getContext('2d');
      c.clearRect(0, 0, w, h);
      c.lineWidth = Math.max(3, w / 200);
      c.strokeStyle = color;
      for (const d of dets) {
        const b = d.detection.box;
        c.strokeRect(b.x, b.y, b.width, b.height);
      }
    }

    function logClientError(type, message) {
      if (Date.now() - S.lastUnkLog < 20000 && type === 'face_unrecognized') return;
      if (type === 'face_unrecognized') S.lastUnkLog = Date.now();
      api('/api/errors', { method: 'POST', body: { type, message } }).catch(() => {});
    }

    async function onDetections(dets) {
      if (dets.length === 0) {
        drawBoxes([], '#fff');
        S.cand = null;
        S.streak = 0;
        S.unk = 0;
        S.unkShown = false;
        return hint('Arahkan wajah peserta ke kamera');
      }
      if (dets.length > 1) {
        drawBoxes(dets, '#f0a030');
        return hint('Terdeteksi lebih dari satu wajah — scan satu per satu');
      }
      const d = dets[0];
      if (d.detection.score < 0.6 || d.detection.box.width < video.videoWidth * 0.18) {
        drawBoxes(dets, '#f0a030');
        return hint('Dekatkan wajah ke kamera');
      }
      const mt = matchFace(d.descriptor);
      if (mt.ok) {
        drawBoxes(dets, '#2ecc71');
        S.unk = 0;
        S.unkShown = false;
        if (S.cand === mt.id) S.streak++;
        else {
          S.cand = mt.id;
          S.streak = 1;
        }
        hint('Memverifikasi…');
        if (S.streak >= MATCH_STREAK) {
          S.streak = 0;
          await submit(mt);
        }
      } else {
        drawBoxes(dets, '#e74c3c');
        S.cand = null;
        S.streak = 0;
        S.unk++;
        hint(mt.ambiguous ? 'Wajah mirip beberapa peserta — coba lagi dari depan' : 'Wajah belum dikenali…');
        if (S.unk >= UNKNOWN_FRAMES && !S.unkShown) showUnrecognized(mt.ambiguous);
      }
    }

    function showUnrecognized(ambiguous) {
      S.unkShown = true;
      S.snapshot = Face.snapshot(video, 480, 0.8);
      logClientError('face_unrecognized', ambiguous ? 'Wajah cocok dengan lebih dari satu peserta (ambigu)' : 'Wajah terdeteksi tetapi tidak ada yang cocok di database');
      result(
        'error',
        `<div class="big">Wajah tidak dikenali</div><div class="sub">${ambiguous ? 'Wajah mirip dengan beberapa data.' : 'Tidak ada data yang cocok di database.'} Coba lagi dengan pencahayaan lebih baik, atau ajukan absen manual untuk diverifikasi admin.</div>
        <div class="row" style="justify-content:center;margin-top:8px"><button class="btn" data-a="retry">Coba lagi</button><button class="btn primary" data-a="manual">Ajukan absen manual</button></div>`
      );
    }

    async function submit(mt) {
      if (Date.now() - (S.last[mt.id] || 0) < 8000) return hint('Sudah diproses barusan');
      S.pauseUntil = Infinity;
      let serial;
      if (S.requireSerial) {
        serial = await askSerial();
        if (serial === null) {
          S.pauseUntil = Date.now() + 1500;
          return;
        }
      }
      try {
        const r = await api('/api/attendance/face', { method: 'POST', body: { participant_id: mt.id, distance: Math.round(mt.d * 1000) / 1000, serial } });
        S.last[mt.id] = Date.now();
        const p = r.participant;
        const late = r.status === 'terlambat' ? ` (terlambat ${r.late_minutes} menit)` : '';
        result(
          r.already ? 'already' : r.status,
          `<div class="big">${r.already ? 'Sudah absen sebelumnya' : r.status === 'hadir' ? '✔ HADIR' : '⚠ TERLAMBAT'}</div>
           <div style="font-size:20px;font-weight:700">${esc(p.name)}</div>
           <div class="sub mono">Kode seri: ${esc(p.serial_code)}</div>${p.institution ? `<div class="sub">${esc(p.institution)}</div>` : ''}
           <div class="sub">${r.already ? 'Tercatat' : 'Jam'} ${fmtTime(r.scanned_at)}${r.already ? '' : late}</div>`
        );
        const pp = S.people.find((x) => x.id === mt.id);
        if (pp) pp.attended = true;
        loadRecent().catch(() => {});
      } catch (e) {
        if (e.status === 404 || (e.data && e.data.code === 'serial_mismatch')) logClientError(e.status === 404 ? 'db_error' : 'face_error', e.message);
        S.last[mt.id] = Date.now();
        result(
          'error',
          `<div class="big">Gagal mencatat absen</div><div class="sub">${esc(e.message)}</div>
           ${e.data && (e.data.code === 'serial_mismatch' || e.status === 404) ? '<div class="row" style="justify-content:center;margin-top:8px"><button class="btn primary" data-a="manual">Ajukan absen manual</button></div>' : ''}`
        );
      } finally {
        S.pauseUntil = Date.now() + 3000;
      }
    }

    function askSerial() {
      return new Promise((resolve) => {
        let done = false;
        const m = openModal(
          `<h2>Konfirmasi kode seri</h2><p class="muted">Wajah dikenali. Minta peserta menyebutkan/menunjukkan <b>kode seri</b>, lalu ketik di sini.</p>
          <form id="ss"><label class="f">Kode seri peserta<input name="s" class="mono" required autocomplete="off" placeholder="PST-XXXX-XXXX" style="text-transform:uppercase"></label>
          <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Konfirmasi</button></div></form>`,
          { onClose: () => !done && resolve(null) }
        );
        $('[data-x]', m.el).onclick = m.close;
        $('#ss', m.el).onsubmit = (e) => {
          e.preventDefault();
          done = true;
          const val = new FormData(e.target).get('s');
          m.close();
          resolve(val);
        };
      });
    }

    async function loop() {
      if (!S.running) return;
      const t0 = performance.now();
      try {
        if (Date.now() >= S.pauseUntil && video.readyState >= 2) await onDetections(await Face.detectLive(video));
      } catch (e) {
        console.error(e);
      }
      if (S.running) S.timer = setTimeout(loop, Math.max(60, 180 - (performance.now() - t0)));
    }

    async function start() {
      $('#sc-start').disabled = true;
      $('#sc-ph').textContent = 'Memuat model pengenalan wajah…';
      try {
        await Face.load();
      } catch (e) {
        $('#sc-start').disabled = false;
        $('#sc-ph').textContent = 'Gagal memuat model wajah.';
        logClientError('face_error', 'Model pengenalan wajah gagal dimuat: ' + e.message);
        return fail(e);
      }
      try {
        await loadPeople();
      } catch (e) {
        $('#sc-start').disabled = false;
        logClientError('db_error', 'Gagal memuat data wajah dari database: ' + e.message);
        return fail(e);
      }
      try {
        await Face.startCamera(video);
      } catch (e) {
        $('#sc-start').disabled = false;
        $('#sc-ph').textContent = 'Kamera tidak dapat diakses.';
        logClientError('camera', 'Kamera gagal: ' + e.message);
        return fail(e);
      }
      $('#sc-ph').classList.add('hidden');
      $('#sc-start').classList.add('hidden');
      $('#sc-stop').classList.remove('hidden');
      if (!S.people.length) toast('Belum ada peserta dengan data wajah. Minta admin mendaftarkan wajah peserta.', 'err');
      S.running = true;
      S.pauseUntil = 0;
      result('', '<div class="muted">Arahkan wajah peserta ke kamera</div>');
      loop();
    }
    function stop() {
      S.running = false;
      clearTimeout(S.timer);
      Face.stopCamera(video);
      overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
      $('#sc-ph').textContent = 'Kamera dimatikan';
      $('#sc-ph').classList.remove('hidden');
      $('#sc-start').classList.remove('hidden');
      $('#sc-start').disabled = false;
      $('#sc-stop').classList.add('hidden');
      hint('');
    }

    $('#sc-start').onclick = start;
    $('#sc-stop').onclick = stop;
    $('#sc-manual').onclick = () => openManualRequest({ video: S.running ? video : null, snapshot: S.running ? Face.snapshot(video, 480, 0.8) : null, onDone: () => (S.unkShown = false) });
    $('#sc-result').onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'retry') {
        S.unk = 0;
        S.unkShown = false;
        result('', '<div class="muted">Arahkan wajah peserta ke kamera</div>');
      } else openManualRequest({ video: S.running ? video : null, snapshot: S.snapshot || (S.running ? Face.snapshot(video, 480, 0.8) : null), onDone: () => (S.unkShown = false) });
    };

    state.cleanup = () => {
      S.running = false;
      clearTimeout(S.timer);
      Face.stopCamera(video);
    };
    paintBanner();
    await loadRecent();
    App.poll(loadRecent, 15000);
  };

  // ---------------------------------------------------------------- pengajuan absen manual
  function openManualRequest({ video, snapshot, onDone }) {
    let chosen = null,
      snap = snapshot || null,
      timer = null;
    const m = openModal(`<h2>Ajukan absen manual</h2>
      <p class="muted small">Pengajuan harus disetujui Admin/Co-Admin. Mereka akan mencocokkan wajah dan nama peserta dengan data di database.</p>
      <form id="mr">
        <label class="f">Nama peserta<input id="mr-q" autocomplete="off" placeholder="Ketik minimal 2 huruf nama…"><div class="pick hidden" id="mr-pick"></div></label>
        <div id="mr-chosen" class="small" style="margin:-6px 0 10px"></div>
        <label class="chk"><input type="checkbox" id="mr-nolist"> Nama tidak ada di daftar / data peserta error</label>
        <div id="mr-claim" class="hidden"><label class="f">Nama peserta (sesuai kartu/identitas)<input name="claimed_name" maxlength="100"></label></div>
        <label class="f">Kode seri peserta<span class="hint">Minta peserta menunjukkan kode seri miliknya. Harus cocok dengan nama di database.</span><input name="serial" class="mono" required autocomplete="off" maxlength="40" placeholder="PST-XXXX-XXXX" style="text-transform:uppercase"></label>
        <label class="f">Alasan<select name="reason"><option value="face_not_found">${esc(REASON_LABEL.face_not_found)}</option><option value="db_error">${esc(REASON_LABEL.db_error)}</option><option value="other">${esc(REASON_LABEL.other)}</option></select></label>
        <label class="f">Catatan <span class="hint">Opsional — mis. “wajah tertutup masker”, “kamera error”</span><textarea name="note" rows="2" maxlength="400"></textarea></label>
        <div class="thumbs"><figure><img id="mr-img" alt="" style="${snap ? '' : 'visibility:hidden'}" ${snap ? `src="${snap}"` : ''}><figcaption>Foto wajah untuk diverifikasi admin</figcaption></figure>
          <div style="flex:1;min-width:180px">${video ? '<button type="button" class="btn sm" id="mr-cap">Ambil ulang dari kamera</button><br><br>' : ''}
          <label class="small">Atau unggah foto<input type="file" id="mr-file" accept="image/*"></label></div></div>
        <div class="foot"><button type="button" class="btn" data-x>Batal</button><button class="btn primary">Kirim pengajuan</button></div>
      </form>`);
    const el = m.el;
    const setSnap = (d) => {
      snap = d;
      $('#mr-img', el).src = d;
      $('#mr-img', el).style.visibility = 'visible';
    };
    $('[data-x]', el).onclick = m.close;
    $('#mr-nolist', el).onchange = (e) => {
      $('#mr-claim', el).classList.toggle('hidden', !e.target.checked);
      if (e.target.checked) {
        chosen = null;
        $('#mr-chosen', el).textContent = '';
        $('select[name=reason]', el).value = 'db_error';
      }
    };
    $('#mr-q', el).oninput = (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      const pick = $('#mr-pick', el);
      if (q.length < 2) return pick.classList.add('hidden');
      timer = setTimeout(async () => {
        try {
          const r = await api('/api/search?q=' + encodeURIComponent(q));
          pick.innerHTML = r.results.length
            ? r.results.map((p) => `<button type="button" data-id="${p.id}" data-n="${esc(p.name)}">${esc(p.name)}${p.institution ? ` <span class="muted">· ${esc(p.institution)}</span>` : ''}</button>`).join('')
            : '<div class="muted small" style="padding:8px">Tidak ditemukan. Jika data peserta error, centang “Nama tidak ada di daftar”.</div>';
          pick.classList.remove('hidden');
        } catch {}
      }, 250);
    };
    $('#mr-pick', el).onclick = (e) => {
      const b = e.target.closest('button[data-id]');
      if (!b) return;
      chosen = { id: Number(b.dataset.id), name: b.dataset.n };
      $('#mr-q', el).value = chosen.name;
      $('#mr-chosen', el).innerHTML = `Dipilih: <b>${esc(chosen.name)}</b>`;
      $('#mr-pick', el).classList.add('hidden');
      $('#mr-nolist', el).checked = false;
      $('#mr-claim', el).classList.add('hidden');
    };
    if (video) $('#mr-cap', el).onclick = () => setSnap(Face.snapshot(video, 480, 0.8));
    $('#mr-file', el).onchange = async (e) => {
      const f = e.target.files[0];
      if (f) setSnap(await Face.fileToJpegDataUrl(f, 480));
    };
    $('#mr', el).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const nolist = $('#mr-nolist', el).checked;
      if (!nolist && !chosen) return toast('Pilih nama peserta dari daftar, atau centang “Nama tidak ada di daftar”', 'err');
      if (nolist && !String(fd.get('claimed_name') || '').trim()) return toast('Isi nama peserta', 'err');
      try {
        const r = await api('/api/manual-requests', {
          method: 'POST',
          body: {
            participant_id: nolist ? null : chosen.id,
            claimed_name: nolist ? fd.get('claimed_name') : '',
            serial: fd.get('serial'),
            reason: fd.get('reason'),
            note: fd.get('note'),
            snapshot: snap,
          },
        });
        toast(r.linked ? 'Pengajuan terkirim — menunggu verifikasi admin' : 'Pengajuan terkirim (data belum terhubung; admin akan menautkan)', 'ok');
        m.close();
        if (onDone) onDone();
      } catch (err) {
        fail(err);
      }
    };
  }
})();
