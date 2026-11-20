/* Modul pengenalan wajah di browser (membungkus face-api.js). */
const Face = (() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api';
  let loadPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Gagal memuat ' + src));
      document.head.appendChild(s);
    });
  }
  async function exists(url) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      return r.ok;
    } catch {
      return false;
    }
  }

  // Memuat library + model (lokal di /vendor bila sudah `npm run setup`, jika tidak dari CDN).
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!window.faceapi) {
        try {
          await loadScript('/vendor/face-api.js');
        } catch {
          await loadScript(CDN + '/dist/face-api.js');
        }
      }
      if (!window.faceapi) throw new Error('Library face-api tidak termuat');
      const local = await exists('/vendor/models/tiny_face_detector_model.json');
      const base = local ? '/vendor/models' : CDN + '/model';
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.ssdMobilenetv1.loadFromUri(base),
        faceapi.nets.faceLandmark68Net.loadFromUri(base),
        faceapi.nets.faceRecognitionNet.loadFromUri(base),
      ]);
    })();
    loadPromise.catch(() => {
      loadPromise = null;
    });
    return loadPromise;
  }

  // ------------------------------------------------------------ kamera
  const PREF_KEY = 'absensi.camera';
  const REAR_RE = /back|rear|environment|belakang/i;
  function loadPref() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    } catch {
      return {};
    }
  }
  function savePref(p) {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch {}
  }
  function camError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return new Error('Izin kamera ditolak. Klik ikon gembok di address bar, izinkan kamera, lalu coba lagi.');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return new Error('Kamera tidak terdeteksi. Colokkan webcam lain atau pilih kamera lain di daftar “Kamera”, lalu klik tombol ↻.');
    if (n === 'NotReadableError' || n === 'AbortError') return new Error('Kamera sedang dipakai aplikasi lain atau tidak bisa dibuka. Tutup aplikasi lain (Zoom/Meet/tab lain) atau pilih kamera lain.');
    return e instanceof Error ? e : new Error(String(e));
  }

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  // sel = { deviceId } ; tanpa argumen memakai kamera terakhir yang dipilih
  async function startCamera(video, sel) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera hanya bisa dipakai lewat HTTPS atau localhost. Buka aplikasi lewat alamat HTTPS (lihat README: tailscale serve).');
    }
    stopCamera(video); // lepaskan kamera lama dulu (sebagian webcam tidak bisa dibuka dua kali)
    sel = sel || loadPref();
    const size = { width: { ideal: 960 }, height: { ideal: 720 } };
    const attempts = [];
    if (sel.deviceId) attempts.push({ video: { deviceId: { exact: sel.deviceId }, ...size } });
    attempts.push({ video: { facingMode: 'user', ...size } });
    attempts.push({ video: true });
    let stream = null,
      lastErr = null;
    for (const a of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ ...a, audio: false });
        break;
      } catch (e) {
        lastErr = e;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
      }
    }
    if (!stream) throw camError(lastErr);
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      stopCamera(video);
      throw camError(e);
    }
    const track = stream.getVideoTracks()[0];
    const st = (track && track.getSettings && track.getSettings()) || {};
    // kamera belakang tidak di-mirror; kamera depan/webcam di-mirror
    const rear = st.facingMode === 'environment' || (!st.facingMode && track && REAR_RE.test(track.label || ''));
    if (video.parentElement) video.parentElement.classList.toggle('rear', !!rear);
    if (st.deviceId) savePref({ deviceId: st.deviceId });
    if (track) track.addEventListener('ended', () => video.srcObject === stream && video.dispatchEvent(new Event('cameralost')));
    video.dispatchEvent(new Event('camerastarted'));
    return stream;
  }
  function stopCamera(video) {
    const s = video && video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  }

  // Kontrol pilih kamera: daftar kamera, tombol depan/belakang, dan muat-ulang daftar.
  // root = elemen kosong tempat kontrol dipasang. onError(pesan) dipanggil bila ganti kamera gagal.
  function cameraPicker(root, video, onError = () => {}) {
    root.className = 'camctl';
    root.innerHTML = `<label class="small muted" style="display:flex;gap:6px;align-items:center;flex:1;min-width:160px">Kamera
      <select data-cam style="flex:1;min-width:0"></select></label>
      <button type="button" class="btn sm hidden" data-flip title="Pindah kamera depan / belakang">🔄 Depan/Belakang</button>
      <button type="button" class="btn sm" data-reload title="Cari ulang kamera yang terpasang" aria-label="Cari ulang kamera">↻</button>`;
    const sel = root.querySelector('[data-cam]');
    const flip = root.querySelector('[data-flip]');
    let cams = [];

    const activeId = () => {
      const t = video.srcObject && video.srcObject.getVideoTracks()[0];
      return (t && t.getSettings && t.getSettings().deviceId) || loadPref().deviceId || '';
    };
    async function refresh() {
      cams = await listCameras();
      const cur = activeId();
      sel.innerHTML =
        `<option value="">Otomatis (kamera depan)</option>` +
        cams.map((c, i) => `<option value="${c.deviceId}">${(c.label || `Kamera ${i + 1}`).replace(/[<>&"]/g, '')}</option>`).join('');
      sel.value = cams.some((c) => c.deviceId === cur) ? cur : '';
      flip.classList.toggle('hidden', cams.length < 2);
      if (!cams.length) sel.innerHTML = '<option value="">Tidak ada kamera terdeteksi</option>';
    }
    async function switchTo(deviceId) {
      savePref(deviceId ? { deviceId } : {});
      if (!video.srcObject) return; // belum menyala: pilihan dipakai saat “Nyalakan kamera”
      try {
        await startCamera(video, deviceId ? { deviceId } : {});
      } catch (e) {
        onError(e.message);
      }
      refresh();
    }
    sel.onchange = () => switchTo(sel.value);
    flip.onclick = () => {
      const cur = activeId();
      const i = cams.findIndex((c) => c.deviceId === cur);
      const curCam = cams[i];
      const wantRear = !(curCam && REAR_RE.test(curCam.label || ''));
      let target = cams.find((c, k) => k !== i && (wantRear ? REAR_RE.test(c.label || '') : !REAR_RE.test(c.label || '')));
      if (!target) target = cams[(i + 1) % cams.length]; // label belum tersedia: putar ke kamera berikutnya
      if (target) switchTo(target.deviceId);
    };
    root.querySelector('[data-reload]').onclick = refresh;
    video.addEventListener('camerastarted', refresh);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      const onDev = () => root.isConnected && refresh();
      navigator.mediaDevices.addEventListener('devicechange', onDev);
    }
    refresh();
    return { refresh };
  }

  // JPEG dataURL dari <video>/<img>/<canvas>, lebar maks maxW
  function snapshot(el, maxW = 640, quality = 0.85) {
    const w = el.videoWidth || el.naturalWidth || el.width;
    const h = el.videoHeight || el.naturalHeight || el.height;
    const k = Math.min(1, maxW / w);
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }

  function imageFromDataUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Gambar tidak bisa dibaca'));
      img.src = url;
    });
  }
  // File gambar -> dataURL JPEG yang sudah diperkecil (menghormati orientasi EXIF)
  async function fileToJpegDataUrl(file, maxW = 640) {
    let src;
    if (window.createImageBitmap) {
      try {
        src = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        src = null;
      }
    }
    if (!src) {
      const url = URL.createObjectURL(file);
      try {
        src = await imageFromDataUrl(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return snapshot(src, maxW, 0.88);
  }

  // Deteksi cepat untuk video langsung
  async function detectLive(video) {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    return faceapi.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors();
  }
  // Deteksi lebih akurat untuk foto pendaftaran
  async function detectPhoto(dataUrl) {
    const img = await imageFromDataUrl(dataUrl);
    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 });
    return faceapi.detectAllFaces(img, opts).withFaceLandmarks().withFaceDescriptors();
  }

  function distance(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      s += d * d;
    }
    return Math.sqrt(s);
  }

  return { load, startCamera, stopCamera, listCameras, cameraPicker, snapshot, fileToJpegDataUrl, detectLive, detectPhoto, distance };
})();
