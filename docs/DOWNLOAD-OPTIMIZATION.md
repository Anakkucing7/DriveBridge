# Audit dan optimasi download DriveBridge

6 November 2026. Audit, implementasi, dan tes dalam laporan ini dilakukan lokal, sebelum publikasi yang disetujui secara terpisah oleh pengguna. Secret dan database schema tidak diubah. Angka pengujian di bawah tidak menyatakan bahwa seluruh skenario sudah diverifikasi pada production.

## 1. Arsitektur sebelumnya dan bukti

Baseline repository: commit `e5d0bcb`. `lib/drive.mjs` hanya meminta metadata `id,name,mimeType,size,capabilities(canDownload)`. `api/inspect.mjs` menerbitkan tiket HMAC 10 menit. Setiap GET `api/download.mjs` memeriksa ulang metadata, memanggil `files.get?alt=media`, lalu menjalankan `pipeline(Readable.fromWeb(response.body), res)`. Artinya seluruh isi file melewati Vercel; tidak ada jalur browser-direct. Timeout aplikasi 285 detik dengan maxDuration Vercel 300 detik.

Baseline sudah menangani ID/host tautan, resource key melalui header Google, nama file aman, rate limit Supabase, dan Range satu rentang. Tidak ada OAuth/service account atau akun wajib: API key server digunakan untuk akses publik. Dokumen Workspace ditolak. Rate limit awal: 20 inspect dan 10 download per menit per jaringan. Logging operasional yang ada hanya counter di Supabase, bukan isi file/tautan/nama file/IP mentah.

Keterbatasan nyata: tidak ada batas ukuran atau byte stream, tidak ada pembatasan concurrency/budget bersama untuk transfer, dan status error 403/429 masih terlalu umum. Munculnya file di pengelola unduhan belum membuktikan transfer selesai. Resume memerlukan browser, Range yang didukung upstream, dan tiket yang masih berlaku; refresh halaman tidak otomatis melanjutkan transfer.

## 2. File yang berubah

- `lib/drive.mjs`: metadata link resmi, PDF Workspace, validasi tujuan, probe anonim, pemilihan jalur, pesan error Google.
- `lib/rate-limit.mjs`: pemakaian ulang RPC lama dan batas fallback bersama/per proses.
- `api/inspect.mjs`: rencana download dan opsi kompatibel tanpa membocorkan URL API berisi key.
- `api/download.mjs`: redirect terverifikasi, revalidasi izin/rate limit, streaming terbatas, Range, timeout/cancellation.
- `public/app.js`, `public/index.html`, `public/styles.css`: label direct/export/proxy dan opsi fallback yang ringan; desain utama dipertahankan.
- `vercel.json`: maxDuration 75 detik.
- `test/drive.test.mjs`, `test/download.test.mjs`: regresi lama dan cakupan baru.
- `README.md`, `docs/SETUP.md`, dokumen ini: arsitektur, status lokal, batas, konfigurasi, dan hasil tes yang akurat.

Tidak ada dependency baru atau perubahan pada `supabase/setup.sql` dan secret.

## 3. Arsitektur baru

1. Browser mengirim tautan ke inspect. Validasi host/ID dan rate limit tetap berjalan.
2. Server mengambil metadata dengan API key, tanpa cookie atau OAuth pengguna. `canDownload` harus benar; izin yang tidak tersedia tidak dianggap izin unduh.
3. Binary menggunakan kandidat `webContentLink`; Docs/Sheets/Slides memilih PDF dari `exportLinks`. URL harus cocok dengan ID, host/path/parameter yang diizinkan. Resource key dipertahankan.
4. Kandidat diprobe memakai HEAD anonim: tidak mengirim API key, cookie, Authorization, atau permintaan sebagian isi file. Hanya HTTPS ke host Google yang diizinkan, maksimal empat hop dan lima detik. Respons harus sukses, berupa attachment, dan bukan halaman HTML.
5. Inspect mengembalikan tiket aplikasi. Saat tombol unduh diklik, server memeriksa lagi tiket, rate limit, metadata, izin, dan jalur. Jika lolos, respons HTTP 302 kosong mengarah ke URL resmi awal Google. Transfer berikutnya adalah Google → browser, bukan Google → Vercel → browser.
6. Jika direct tidak dapat diverifikasi, binary kecil atau PDF Workspace dapat memakai API resmi melalui streaming terbatas. Opsi kompatibel juga tersedia secara eksplisit untuk file yang memenuhi batas jika browser lama gagal pada jalur langsung.

Metadata yang dapat dibaca server saja bukan bukti browser bisa mengunduh. HEAD ini membuktikan akses anonim pada saat probe, bukan menjamin TLS, izin, kuota, atau pemeriksaan keamanan tidak akan berubah ketika browser membuka URL.

Google mendokumentasikan `webContentLink` untuk unduhan browser, `exportLinks` untuk ekspor browser, dan `files.export` untuk isi ekspor Workspace; ekspor API dibatasi 10 MB. [Download/export resmi](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [metadata Files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files). Google juga menyertakan resource key pada URL browser yang dikembalikan metadata. [Resource keys](https://developers.google.com/workspace/drive/api/guides/resource-keys).

## 4. Kondisi direct versus fallback

| Kondisi | Hasil |
| --- | --- |
| Binary publik, izin unduh benar, URL resmi dan HEAD anonim lolos | Redirect langsung, termasuk file besar |
| Docs/Sheets/Slides, link PDF resmi dan HEAD lolos | Ekspor PDF langsung |
| HEAD ditolak/tidak didukung, interstitial HTML, redirect tidak aman, atau kandidat link tidak tersedia | Fallback terbatas jika memenuhi syarat |
| Binary >25 MiB tanpa direct yang terverifikasi | Error dengan penjelasan; tidak dipaksakan menjadi redirect/proxy besar |
| Pemilik melarang, file privat, izin tidak terkonfirmasi, atau kuota Google habis | Error yang sesuai; tidak dicoba bypass |
| Folder, shortcut, atau Workspace lain | Pesan format belum didukung |

PDF adalah satu format default yang tersedia untuk ketiga tipe Workspace; tidak ditambahkan pemilih format yang belum diminta. Export API untuk file publik tetap dapat ditolak oleh Google; penolakannya ditampilkan, bukan disiasati.

Fallback dibatasi **25 MiB** per binary / **10 MiB** per ekspor, **60 detik total request**, **2 transfer aktif per proses**, dan **6 awal transfer per menit lintas instance**. Ukuran total file binary harus memenuhi batas meskipun memakai Range. Ukuran PDF ekspor tidak disamakan dengan ukuran dokumen sumber.

Limit byte diperiksa sebelum header dari Content-Length, lalu pada setiap chunk untuk respons yang ukuran sebenarnya tidak diketahui. Server tidak menampung seluruh file. Timeout, klien putus, dan pelanggaran byte cap membatalkan upstream. Setelah header terkirim, batas yang terlampaui menyebabkan koneksi transfer ditutup; browser harus menampilkan unduhan gagal, bukan status selesai palsu.

Counter global memakai bucket menit tetap, bukan semaphore/antrean global. Dua bucket dapat tumpang tindih di batas menit; batas dua transfer berlaku per proses, bukan seluruh fleet. Dengan asumsi jam instance sinkron dan deadline dipatuhi, dua bucket dapat memulai hingga 12 transfer yang waktunya beririsan. Ini budget transfer yang terbatas, bukan jaminan concurrency global dua atau biaya bulanan nol. Batas steady-state payload fallback maksimum teoretis 6 × 25 MiB = 150 MiB per menit, dengan burst sekitar pergantian menit dan sedikit prefetch upstream/overhead protokol.

## 5. Keamanan dan abuse

- HMAC dan kedaluwarsa tiket dipertahankan. Client tidak dapat menaruh target URL di tiket atau memaksa proxy file besar.
- Izin diperiksa ulang sebelum redirect/stream. Google tetap otoritas akses terakhir setelah redirect.
- API media/ekspor hanya menggunakan endpoint Google yang dibentuk server dari ID tervalidasi, dengan redirect error. Probe browser menggunakan allowlist HTTPS dan redirect manual; host internal/non-Google, port, userinfo, parameter kredensial, dan parameter tidak dikenal ditolak.
- Tidak ada `acknowledgeAbuse`, token OAuth, cookie pengguna, bypass malware, atau perubahan izin. Halaman konfirmasi Google tidak diparse untuk membuat link paksa.
- API key Google dan secret Supabase tidak dimasukkan ke respons browser, Location, source frontend, atau URL probe. Respons Google mentah yang bisa mengandung kredensial tidak diteruskan sebagai pesan error.
- Rate limit inspect/download lama berlaku pada kedua jalur. Fallback menggunakan counter global tambahan melalui RPC/schema lama. Sesudah pengguna menerima URL Google publik, permintaan mereka langsung ke Google di luar aplikasi tidak bisa dihitung/dibatasi aplikasi; permintaan tersebut juga tidak memakai transfer Vercel.
- `no-store`, `no-referrer`, attachment/nosniff untuk proxy, escaping pesan error, dan rendering nama file dengan textContent dipertahankan.

## 6. Hasil pengujian yang dijalankan

`node --test`: **36 lulus, 0 gagal** pada Node.js 24.22.1 lokal. Target konfigurasi tetap Node.js 22.x; tidak ada binary Node 22 terpisah yang digunakan untuk pengujian ini.

Tes otomatis meliputi binary publik/anyone-with-link, resource key, file privat/restricted, large-file direct dan penolakan proxy besar, Docs/Sheets/Slides PDF, ID salah/hilang, izin dicabut setelah inspect, kuota/malware/export-size Google, tiket rusak/kedaluwarsa, credential exposure, SSRF/redirect chains, Range, respons header besar, stream tanpa Content-Length, deadline, cancellation, slot concurrency, rate limit sebelum redirect, serta budget Supabase bersama lintas dua instance simulasi.

Tes direct HTTP memeriksa `302`, Location tervalidasi, body respons **0 byte**, dua probe HEAD dan **0 media GET**. Ini bukti alur lokal dengan upstream mock, bukan pembacaan metrik bandwidth Vercel production. Tes proxy membandingkan byte hasil, termasuk fixture lama 5 MiB dan respons Range; tes oversized memeriksa stream terputus/cancelled sebelum melewati batas payload ke client.

Pemeriksaan sintaks backend/frontend/test dan parsing konfigurasi Vercel/package JSON lulus. Tidak ada script lint, typecheck, atau production build di package.json (hanya dev/start/test); tidak ditambahkan dependency atau build palsu untuk mengklaim pemeriksaan tersebut.

Browser QA memakai CUA/in-app browser pada fixture server terisolasi `127.0.0.1:3001`, tanpa production secret, database, atau Google sungguhan. Diverifikasi: identitas/konten halaman; direct dengan opsi fallback; PDF dan ukuran belum diketahui; fallback dan unduhan browser 1 KiB; file besar tanpa fallback; error restricted yang menyembunyikan hasil sebelumnya. Console warning/error yang dicatat: kosong. Viewport desktop 1280×720, mobile 390×844 dan 320×844; tidak ditemukan overflow horizontal. Screenshot desktop/direct dan mobile/PDF diperiksa melalui tool browser. Viewport dikembalikan ke default; server fixture dihentikan setelah QA.

Review 21st tambahan **tidak dijalankan**: automatic approval review menolaknya karena potensi pengiriman source ke layanan eksternal yang belum disetujui untuk perubahan ini. Pemeriksaan lokal, tes, dan review manual digunakan sebagai alternatif; tidak ada source yang diekspor lewat langkah yang ditolak.

## 7. Batas yang belum diverifikasi

Tidak diuji pada Windows 7/Chrome 109/Firefox 115 sungguhan, Google live untuk implementasi baru, Preview/production Vercel baru, browser yang memerlukan cookie Google, file multi-GB nyata, atau resume lintas putus koneksi. Sintaks ES5 dipertahankan, tetapi sertifikat/TLS dan engine browser lama tetap dapat menghalangi direct. Jika HEAD Google tidak didukung, aplikasi sengaja memilih fallback atau penjelasan untuk file terlalu besar; ini konservatif dan dapat mengurangi jumlah file yang memenuhi direct.

HEAD menambah hingga lima detik per pemeriksaan. Akses Google yang berubah setelah probe dapat membuat unduhan tetap gagal. PDF besar dapat gagal di batas ekspor API Google. Batas proxy yang lebih ketat berarti sebagian file besar yang dahulu mungkin selesai dalam 285 detik kini memerlukan direct atau layanan relay lain; limit ini sengaja terlihat di UI dan bukan klaim mempertahankan proxy tanpa batas.

## 8. Perkiraan penghematan, bukan metrik production

Penghematan payload Vercel kira-kira jumlah ukuran file yang berhasil dialihkan ke direct. Contoh perhitungan: 100 unduhan × 100 MiB yang semuanya eligible menghindari sekitar **10.000 MiB = 9,77 GiB** transfer file keluar dari Vercel. Bila hanya 80 dari 100 file berukuran sama yang eligible, perkiraannya **7,81 GiB**, sekitar 80% payload file baseline.

Ini tidak berarti tagihan turun dengan persentase yang sama: metadata, header, redirects, counter Supabase, probe, dan fallback tetap memakai resource. Jumlah invocation normal masih dua (inspect dan download), bukan otomatis lebih sedikit; yang dihindari adalah durasi streaming/file payload pada fungsi direct. Penghematan aktual perlu diukur dari penggunaan hosting dan proporsi direct setelah deployment yang disetujui.

## 9. Konfigurasi dan langkah penerbitan

`vercel.json` lokal mengubah maxDuration 300 → 75 detik; timeout aplikasi 60 detik memberi margin 15 detik. Tidak ada env baru, rotasi secret, migrasi database, bucket Storage, atau perubahan RLS yang diperlukan. RPC `drivebridge_consume_request` yang sudah ada tetap dipakai.

Jangan otomatis push ke main: repository terhubung ke deployment production. Review perubahan terlebih dahulu, lalu uji Preview dengan environment yang sesuai, file Google publik milik sendiri, dan browser target. Validasi Network/hosting metrics untuk memastikan file direct berasal dari Google, uji hash hasil unduhan, Google interstitial, dan failure/resume nyata sebelum mempromosikan. WAF serta usage/budget alerts tetap disarankan untuk serangan volume tinggi.
