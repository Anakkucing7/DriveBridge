# DriveBridge

Pengunduh file publik Google Drive melalui server, dengan UI responsif berbahasa Indonesia untuk browser komputer lama.

Frontend HTML/CSS + JavaScript ES5 tanpa dependency. Backend Node.js, siap Vercel Functions. Supabase menangani pembatasan permintaan lintas instance; file tidak disimpan.

```powershell
node --env-file-if-exists=.env server.mjs
node --test
```

Buka http://127.0.0.1:3000. Isi `.env` (atau salin `.env.example` ke `.env` jika belum ada) dan ikuti [panduan konfigurasi](docs/SETUP.md) untuk Google Drive API, Supabase, GitHub, dan Vercel.

Untuk deployment, Vercel melayani `public/` dan menjalankan handler `api/*.mjs` sebagai Node.js Functions. `server.mjs` hanya untuk menjalankan server di komputer pengembang. Isi empat variable yang sama di **Vercel Project → Settings → Environment Variables**, lalu deploy/redeploy. File `.env` tidak dikirim ke GitHub atau Vercel; sudah dikecualikan lewat `.gitignore` dan `.vercelignore`.

**Status:** source tersedia di [GitHub](https://github.com/Anakkucing7/DriveBridge) dan website aktif di [Vercel](https://drivebridge-one.vercel.app). Google Drive API serta Supabase sudah dikonfigurasi sebagai secret production. SQL setup, RLS, pembatasan permintaan, koneksi REST, dan pipeline production menuju Google telah diuji. Error konfigurasi 503 sudah teratasi. Pengujian production menggunakan ID file yang sengaja tidak ada (404 sesuai harapan); unduhan file Google Drive sungguhan masih perlu diuji.

**Batas:** file publik biasa saja, tanpa folder/Google Docs asli. Target Chrome 109/Firefox 115 ESR, bukan Internet Explorer. Transfer dibatasi durasi server sekitar 285 detik. Halaman, aset, endpoint API, dan penolakan akses `.env` sudah diperiksa pada Vercel. Unduhan Google Drive production dan perangkat Windows 7 sungguhan belum diuji.

