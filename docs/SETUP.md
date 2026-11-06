# Mengaktifkan DriveBridge

Panduan untuk menjalankan dan menerbitkan DriveBridge. Google API dan Supabase sudah tersedia sebagai konfigurasi server. Publikasi dilakukan atas instruksi pengguna; jangan push main sebelum siap, karena repository production melakukan deploy otomatis.

## Menjalankan lokal

Pasang Node.js 22.9+ di komputer pengembang modern (Node server tidak dijalankan di Windows 7). Tidak perlu install dependency.

1. Isi `.env` yang tersedia, atau salin `.env.example` menjadi `.env` jika belum ada.
2. Isi environment berikut sesuai petunjuk di bawah.
3. Jalankan `node --env-file-if-exists=.env server.mjs` (atau `npm run dev`).
4. Buka http://127.0.0.1:3000.
5. Jalankan `node --test` untuk pemeriksaan otomatis.

Tanpa API key, UI, contoh file lokal, FAQ, serta validasi dasar tetap berjalan. Pemeriksaan file Drive menampilkan error konfigurasi yang jelas. Mode contoh ditandai, tidak menyimulasikan hasil dari Google.

## Google Drive API key

1. Buka [Google Cloud Console](https://console.cloud.google.com/) dan buat/pilih proyek.
2. Di **APIs & Services → Library**, aktifkan **Google Drive API**.
3. Di **Credentials → Create credentials → API key**, buat key.
4. Batasi **API restrictions** hanya ke **Google Drive API**. Key ini dipakai server, bukan JavaScript browser. Pembatasan HTTP referrer tidak sesuai untuk pemanggilan server; pembatasan IP memerlukan IP keluar server yang tetap.
5. Simpan key sebagai `GOOGLE_DRIVE_API_KEY` di `.env` dan Vercel Environment Variables. Jangan commit key.
6. Untuk uji, buat file PDF/ZIP kecil milik Anda dan atur **Bagikan → Akses umum → Siapa saja yang memiliki link → Pelihat**. Pastikan pemilik mengizinkan unduhan.
7. Salin tautan file ke DriveBridge. Uji nama/ukuran, unduh, lalu bandingkan hash file asli dengan file hasil unduh.

Hanya file yang dapat diakses tanpa OAuth/cookie dan memiliki izin unduh yang terkonfirmasi. Folder, shortcut, file privat, dan file yang diblokir pemilik tidak didukung. Docs/Sheets/Slides diekspor sebagai PDF melalui tautan ekspor atau `files.export` resmi. Resource key dipertahankan pada metadata dan URL browser. Ketersediaan API tanpa login belum membuktikan tautan browser dapat diunduh: aplikasi memeriksa tautan resmi dengan HEAD anonim sebelum memilih redirect.

## Supabase: pilih pemisahan yang tepat

Satu proyek Supabase menyediakan satu database Postgres utama. Untuk isolasi database, kapasitas, dan siklus proyek, buat proyek baru **drivebridge**. Proyek baru dapat memiliki batas paket atau biaya; periksa dashboard sebelum membuatnya.

Alternatif hemat: gunakan database proyek homecare dengan tabel berawalan `drivebridge_`. Ini memisahkan objek aplikasi, bukan database fisik. Status pause, kapasitas, dan administrasi masih berbagi. Proyek homecare yang ditemukan saat pengerjaan berstatus INACTIVE; tidak diubah atau diaktifkan otomatis.

1. Buka [Supabase Dashboard](https://supabase.com/dashboard) dan buat/pilih proyek yang Anda putuskan.
2. Untuk proyek baru, jalankan isi `supabase/setup.sql` **sekali** di SQL Editor. Proyek DriveBridge yang sudah disetup tidak memerlukan schema baru atau pengulangan setup untuk pembaruan ini.
3. Salin **Project URL** ke `SUPABASE_URL`.
4. Ambil server **secret key** (`sb_secret_...`) di pengaturan API dan simpan sebagai `SUPABASE_SECRET_KEY`. Jangan gunakan publishable key. Jangan masukkan secret ke frontend.
5. Pastikan schema `public` tersedia dalam Data API. Fungsi RPC hanya dapat dijalankan role server. Tabel mengaktifkan RLS dan tidak memberikan akses `anon`/`authenticated`.
6. Setelah aplikasi aktif, kirim 21 pemeriksaan tautan dalam satu menit dari jaringan yang sama: permintaan ke-21 harus memperoleh HTTP 429. Pengunduhan dibatasi 10 permintaan per menit per jaringan.
7. Di SQL Editor, pastikan `select count(*) from public.drivebridge_request_limits;` memperlihatkan penghitung. Uji tambahan: `select has_function_privilege('anon', 'public.drivebridge_consume_request(text,text,integer)', 'execute');` harus `false`; lakukan pemeriksaan yang sama untuk `authenticated`.
8. Jalankan Security Advisor Supabase setelah setup.

Supabase menyimpan hash jaringan yang berubah setiap menit, jenis aksi, penghitung, dan waktu kedaluwarsa. Pembaruan ini memakai RPC yang sama untuk penghitung global fallback (6 awal transfer per menit), tanpa tabel/kolom baru. Tautan Drive, nama file, isi file, dan IP mentah tidak ditulis ke tabel. Baris kedaluwarsa dibersihkan saat permintaan berikutnya; jika aplikasi tidak menerima permintaan lagi, baris terakhir tetap tersimpan sampai pembersihan berikutnya.

Lokal tanpa Supabase memakai pembatasan di memori. Di Vercel/production, layanan menolak berjalan jika Supabase atau secret belum dikonfigurasi; pembatasan tidak diam-diam dilewati.

## Secret tanda tangan

Jalankan di komputer pengembang:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Simpan hasil sebagai `DOWNLOAD_TOKEN_SECRET`. Gunakan secret berbeda untuk production dan pengembangan. Tautan unduhan berlaku 10 menit, dapat dipakai ulang selama masa itu, dan tidak mengandung API key. Secret ini juga mengacak identitas jaringan untuk pembatasan permintaan.

## GitHub dan Vercel

1. Buat repository GitHub untuk DriveBridge. Hindari memasukkan `.env` atau secret apa pun. `.gitignore` dan `.vercelignore` sudah mengecualikan file environment.
2. Dari folder proyek, jalankan `git init`, `git add .`, dan `git commit -m "Build DriveBridge downloader"`.
3. Tambahkan remote repository Anda, lalu push branch `main`.
4. Di Vercel pilih **Add New → Project → Import Git Repository**.
5. Gunakan preset **Other**, **Output Directory: public**, tanpa install/build command. Pengaturan ini sudah eksplisit di `vercel.json`; Node.js 22.x ditentukan di `package.json`. Vercel menjalankan `api/inspect.mjs` dan `api/download.mjs` sebagai Functions, bukan menjalankan `server.mjs` atau `npm start`.
6. Di **Project → Settings → Environment Variables**, isi `GOOGLE_DRIVE_API_KEY`, `DOWNLOAD_TOKEN_SECRET`, `SUPABASE_URL`, dan `SUPABASE_SECRET_KEY` untuk environment Production (serta Preview bila digunakan), lalu deploy. Gunakan nilai dari `.env`, tetapi jangan upload file `.env` itu sendiri. Perubahan variable memerlukan redeploy. Supabase beserta SQL setup wajib dikonfigurasi agar endpoint production aktif.
7. Sebelum production, uji pada Preview terkonfigurasi: file binary kecil/besar, file privat, resource key, kuota, ekspor PDF, dan Range/resume fallback. Network browser harus menunjukkan redirect ke host Google dan transfer file dari Google, tanpa media GET dari Vercel untuk jalur direct. Jangan menganggap tes mock lokal membuktikan kompatibilitas Google/browser/hosting sesungguhnya.
8. Aktifkan aturan rate limit/WAF Vercel untuk `/api/*` sebagai perlindungan tambahan terhadap serangan volume tinggi. Tetapkan budget/usage alert hosting dan Google API sesuai kebutuhan.

## Batas transfer dan Windows 7

Utamakan unduhan langsung melalui `webContentLink` (binary) atau `exportLinks[application/pdf]` (Docs/Sheets/Slides) yang disuplai metadata Google. HEAD tanpa cookie, OAuth, atau API key harus berakhir pada respons attachment yang bukan halaman HTML. Probe dibatasi 5 detik dan empat hop, hanya pada host Google yang diizinkan. Tautan yang meminta login, mengarah ke interstitial, tidak mendukung HEAD, atau tidak lolos validasi tidak dipaksakan menjadi redirect. Hasil probe hanya bukti sesaat; Google memeriksa izin lagi saat browser mengunduh dan tetap dapat menampilkan pemeriksaan keamanan.

Endpoint unduh tetap memvalidasi tiket 10 menit, rate limit, serta metadata/izin terbaru sebelum redirect. Browser tidak menerima API key server atau URL API Google berisi key. Direct tidak memindahkan isi file melalui Vercel. Sesudah redirect, koneksi dan batas transfer Google/browser berlaku, bukan timeout proxy aplikasi.

Mode kompatibel tersedia untuk binary sampai 25 MiB dan ekspor PDF sampai 10 MiB, melalui API resmi. Timeout aplikasi 60 detik sejak request dimulai (termasuk pemeriksaan metadata), maksimal 2 transfer per proses, dan 6 awal transfer fallback per menit secara global memakai Supabase. Fungsi Vercel disetel 75 detik untuk memberi margin cleanup. Batas byte diperiksa dari Content-Length dan penghitung chunk; stream dibatalkan saat klien putus, timeout, atau batas terlampaui. Jika terputus setelah header dikirim, browser menandai unduhan gagal; aplikasi tidak dapat mengganti respons itu menjadi halaman error.

Kuota 6 awal transfer/menit adalah bucket menit tetap, bukan antrean atau semaphore global. Hingga dua bucket dapat tumpang tindih dekat pergantian menit; batas dua transfer berlaku per proses. Batas per file, deadline, dan kuota bersama tetap membatasi penggunaan fallback, tetapi bukan jaminan tagihan bulanan. Terapkan WAF dan usage/budget alerts sesuai trafik.

HTTP Range satu rentang didukung hanya untuk fallback binary yang total ukuran filenya masih di bawah batas. Ekspor tidak mendukung Range. Tautan aplikasi kedaluwarsa setelah 10 menit; Google punya aturan URL dan resume sendiri. Jangan mengklaim resume otomatis lintas timeout pada Windows 7 sebelum diuji.

File multi-GB bisa memakai direct jika URL resmi lolos pemeriksaan. Jika tidak, aplikasi memberi penjelasan; tidak ada proxy besar tanpa batas. Untuk kebutuhan proxy besar khusus browser lama, diperlukan layanan relay lain dengan batas dan budget yang sesuai. Supabase Storage tidak dipakai sebagai cache file.

Target frontend: Chrome 109 / Firefox 115 ESR pada Windows 7. JavaScript browser ditulis dalam sintaks ES5 dengan XMLHttpRequest, unduhan native browser, font sistem, dan fallback tempel Ctrl+V. Internet Explorer tidak didukung. OS Windows 7 dan browser lamanya dapat memiliki sertifikat/TLS yang tidak kompatibel dengan hosting saat ini; tidak dapat diperbaiki hanya dengan JavaScript. Pengujian hardware/VM Windows 7 belum dilakukan.

## Referensi

- [Google Drive download API](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Vercel streaming dan batas body](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase database functions](https://supabase.com/docs/guides/database/functions)

## Status plugin

Skill 21st dipakai untuk aturan UI dan review lokal. Pencarian katalog CLI dicoba tetapi meminta login; tidak ada komponen katalog yang diklaim sudah diambil. Setelah login, pencarian bisa diulang. Lokasi preview konsep visual dicatat di `.21st/DESIGN.md`; bukan aset runtime. Windows menolak penyalinan PNG ke folder OneDrive, sehingga gambar preview tetap di lokasi keluaran aslinya. Sites dipakai sebagai panduan pengembangan lokal; hosting Sites tidak dibuat karena tujuan hosting Anda adalah Vercel. Supabase dipakai untuk penemuan proyek dan perancangan integrasi, tanpa mengubah homecare. Plugin lain tidak dipaksakan jika tidak membantu alur ini.
