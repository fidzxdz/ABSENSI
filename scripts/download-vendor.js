'use strict';
// Mengunduh face-api.js dan model pengenalan wajah ke public/vendor/ (sekali saja, perlu internet).
// Setelah itu aplikasi berjalan tanpa internet (cocok untuk jaringan Tailscale/lokal).
const fs = require('node:fs');
const path = require('node:path');

const BASES = ['https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15', 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api'];
const OUT = path.join(__dirname, '..', 'public', 'vendor');
const FILES = [
  ['dist/face-api.js', 'face-api.js'],
  ...[
    'tiny_face_detector_model',
    'ssd_mobilenetv1_model',
    'face_landmark_68_model',
    'face_recognition_model',
  ].flatMap((m) => [
    [`model/${m}.json`, `models/${m}.json`],
    [`model/${m}.bin`, `models/${m}.bin`],
  ]),
];

(async () => {
  fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
  for (const [remote, local] of FILES) {
    const dest = path.join(OUT, local);
    process.stdout.write(`Mengunduh ${remote} ... `);
    let r = null;
    for (const base of BASES) {
      try {
        r = await fetch(`${base}/${remote}`);
        if (r.ok) break;
      } catch (e) {
        r = null;
      }
    }
    if (!r || !r.ok) {
      console.log(`GAGAL (${r ? r.status : 'tidak ada koneksi'})`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  }
  console.log(process.exitCode ? '\nAda berkas yang gagal. Cek koneksi internet lalu ulangi.' : '\nSelesai. Jalankan: npm start');
})().catch((e) => {
  console.error('Gagal:', e.message);
  process.exit(1);
});
