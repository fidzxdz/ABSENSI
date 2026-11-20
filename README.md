# Absensi Wajah

Sistem absensi dengan pengenalan wajah untuk acara (±100 peserta), dengan tiga peran:

| Peran | Bisa apa |
|---|---|
| **Admin** | Semua: isi data peserta & daftarkan wajah, kode seri, pantau absensi real-time, lihat error, absen manual langsung, verifikasi pengajuan, kelola pengguna, atur jam, export Excel |
| **Co-Admin** | Pembantu verifikasi: menyetujui/menolak absen manual, memantau absensi, melihat error & data peserta, export Excel |
| **Panitia** | Scan wajah peserta; bila gagal (wajah tidak dikenali / data error) mengajukan absen manual yang menunggu verifikasi |

## Persyaratan
- **Node.js 22.13 atau lebih baru** (memakai `node:sqlite` bawaan — tanpa `npm install`, tanpa dependensi).
- Internet **sekali saja** untuk mengunduh library & model wajah.

## Menjalankan
```bash
npm run setup     # unduh face-api.js + model ke public/vendor (sekali saja)
npm start         # jalankan server di http://127.0.0.1:3000
```
Saat pertama jalan, terminal menampilkan **password admin awal** (username `admin`). Segera login dan ganti password.
Lupa password: `npm run reset-password -- admin PasswordBaru123`

> Bila `npm run setup` tidak dijalankan, aplikasi mencoba memuat library dari CDN (butuh internet di setiap perangkat). Untuk acara, sebaiknya jalankan `setup`.

## Hosting lewat Tailscale
Kamera browser **hanya berfungsi lewat HTTPS** (atau `localhost`). `tailscale serve` memberi HTTPS otomatis di dalam tailnet-mu, jadi cocok:

1. Di Tailscale admin console → **DNS** → aktifkan **MagicDNS** dan **HTTPS Certificates**.
2. Jalankan aplikasi: `npm start` (server hanya mendengarkan `127.0.0.1`, jadi tidak terbuka ke jaringan lain).
3. Di komputer yang sama: `tailscale serve --bg 3000`
   (versi Tailscale lama: `tailscale serve https / http://127.0.0.1:3000`; cek `tailscale serve --help`).
4. Buka alamat yang ditampilkan, mis. `https://nama-pc.tailnet-xxxx.ts.net`.
5. **Semua perangkat panitia/admin harus tergabung di tailnet** yang sama (pasang aplikasi Tailscale lalu login, atau undang lewat *node sharing*). Jangan memakai `tailscale funnel` — itu membuka aplikasi ke internet publik.

Komputer server harus menyala dan terhubung selama acara.

## Alur penggunaan
**Sebelum acara (Admin)**
1. **Pengaturan**: nama acara, tanggal, *jam dibuka*, *batas tepat waktu* (lewat dari ini = **terlambat**), *jam ditutup*, zona waktu (default `Asia/Jakarta`).
2. **Pengguna**: buat akun Co-Admin dan Panitia.
3. **Peserta**: tambah satu per satu atau **Impor daftar** (tempel dari Excel: `Nama, Instansi`). Setiap peserta otomatis mendapat **kode seri unik** (mis. `PST-7K3M-Q9XD`). Tombol **Cetak kode seri** membuat kartu untuk dibagikan.
4. Klik **Wajah** pada tiap peserta → foto lewat kamera atau unggah foto → **Simpan sebagai sampel**. Ambil 2–3 sampel (lurus, sedikit menoleh, cahaya berbeda) supaya akurat.

**Hari-H**
- Panitia buka **Scan Wajah** → *Nyalakan kamera* → peserta menghadap kamera. Setelah beberapa deteksi cocok berturut-turut, absen tercatat dan nama + kode seri tampil. Status otomatis **Hadir** atau **Terlambat** sesuai jam.
- Bila *Wajib konfirmasi kode seri* diaktifkan (Pengaturan), panitia juga mengetik kode seri yang ditunjukkan peserta — verifikasi ganda wajah + kode seri.
- **Wajah tidak dikenali / data error** → tombol **Ajukan absen manual**: pilih nama, ketik **kode seri** peserta (harus cocok dengan nama di database), pilih alasan, foto wajah terlampir otomatis.
- **Admin/Co-Admin** → tab **Verifikasi**: membandingkan foto pengajuan dengan foto terdaftar, memastikan nama & kode seri cocok, mencentang kedua konfirmasi, lalu **Setujui** (atau **Tolak** dengan alasan). Jam absen yang dicatat = jam pengajuan dibuat, bukan jam disetujui.
- Pengajuan untuk peserta yang **tidak ada di database** bisa disetujui setelah admin menautkannya ke peserta yang benar.
- Admin juga bisa mencatat **absen manual langsung** (alasan wajib) dan **membatalkan** absensi dari tab Peserta.
- Tab **Error** mencatat: wajah tidak dikenali, kamera/model gagal, data tidak ditemukan, kode seri salah, dan error server.

**Setelah acara**: tombol **Export Excel** (Ringkasan / Semua Peserta / Hadir / Terlambat / Tidak Hadir; lengkap dengan jam, menit keterlambatan, metode, dan nama verifikator).

## Catatan penting
- **Akurasi** bisa diatur di Pengaturan (*ketelitian pencocokan*, default 0.50). Naikkan sedikit bila banyak peserta gagal dikenali; turunkan bila ada salah-kenal. Sistem juga menolak kecocokan ambigu (wajah mirip ≥2 peserta).
- **Tidak ada deteksi “liveness”**: foto di layar HP berpotensi mengelabui kamera. Aktifkan *konfirmasi kode seri* dan pastikan panitia mengawasi pemindaian.
- Pencocokan wajah dilakukan di browser perangkat panitia (perangkat panitia menerima data vektor wajah, **bukan** foto dan **bukan** kode seri). Gunakan hanya perangkat panitia yang tepercaya.
- Data wajah adalah data biometrik/pribadi: dapatkan persetujuan peserta dan hapus data setelah acara bila tidak diperlukan (tombol hapus peserta / *Hapus semua data wajah*).
- **Backup**: salin folder `data/` (berisi `absensi.db`, foto referensi, foto pengajuan).
- Jangan jalankan beberapa instance server pada folder `data/` yang sama.

## Struktur
```
server.js            backend (HTTP + SQLite + auth + API + export)
lib/xlsx.js          penulis file .xlsx tanpa dependensi
lib/timeutil.js      utilitas zona waktu
public/              antarmuka web (index.html, app.js, scan.js, face.js, style.css)
scripts/             download-vendor.js, reset-password.js, test-api.js
data/                database & foto (dibuat otomatis)
```
Tes backend: `npm test` (memakai database sementara).
