# DriveBridge

Pengunduh file publik Google Drive melalui server, dengan UI responsif berbahasa Indonesia untuk browser komputer lama.

Frontend HTML/CSS + JavaScript ES5 tanpa dependency. Backend Node.js, siap Vercel Functions. Supabase menangani pembatasan permintaan lintas instance; file tidak disimpan.

```powershell
node --env-file-if-exists=.env server.mjs
node --test
```

Buka http://127.0.0.1:3000. Isi `.env` (atau salin `.env.example` ke `.env` jika belum ada) dan ikuti [panduan konfigurasi](docs/SETUP.md) untuk Google Drive API, Supabase, GitHub, dan Vercel.

Untuk deployment, Vercel melayani `public/` dan menjalankan handler `api/*.mjs` sebagai Node.js Functions. `server.mjs` hanya untuk menjalankan server di komputer pengembang. Isi empat variable yang sama di **Vercel Project → Settings → Environment Variables**, lalu deploy/redeploy. File `.env` tidak dikirim ke GitHub atau Vercel; sudah dikecualikan lewat `.gitignore` dan `.vercelignore`.

**Status:** implementasi lokal; API key Google dan proyek Supabase untuk aplikasi ini belum dikonfigurasi. File contoh lokal bisa dicoba tanpa key. Belum push ke GitHub atau deploy Vercel.

**Batas:** file publik biasa saja, tanpa folder/Google Docs asli. Target Chrome 109/Firefox 115 ESR, bukan Internet Explorer. Transfer dibatasi durasi server sekitar 285 detik. Belum diuji pada Windows 7 sungguhan atau deployment Vercel.

