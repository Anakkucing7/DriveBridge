# DriveBridge

Pengunduh file publik Google Drive dengan pemeriksaan metadata di server dan unduhan langsung dari Google bila dapat diverifikasi, dengan UI responsif berbahasa Indonesia untuk browser komputer lama.

Frontend HTML/CSS + JavaScript ES5 tanpa dependency. Backend Node.js, siap Vercel Functions. Supabase menangani pembatasan permintaan lintas instance; file tidak disimpan.

```powershell
node --env-file-if-exists=.env server.mjs
node --test
```

Buka http://127.0.0.1:3000. Isi `.env` (atau salin `.env.example` ke `.env` jika belum ada) dan ikuti [panduan konfigurasi](docs/SETUP.md) untuk Google Drive API, Supabase, GitHub, dan Vercel.

Untuk deployment, Vercel melayani `public/` dan menjalankan handler `api/*.mjs` sebagai Node.js Functions. `server.mjs` hanya untuk menjalankan server di komputer pengembang. Isi empat variable yang sama di **Vercel Project → Settings → Environment Variables**, lalu deploy/redeploy. File `.env` tidak dikirim ke GitHub atau Vercel; sudah dikecualikan lewat `.gitignore` dan `.vercelignore`.

**Status:** source direct download tersedia untuk [GitHub](https://github.com/Anakkucing7/DriveBridge) dan deployment [Vercel](https://drivebridge-one.vercel.app), dengan Google API dan Supabase sebagai konfigurasi server. Lihat [audit dan hasil verifikasi](docs/DOWNLOAD-OPTIMIZATION.md) untuk cakupan pengujian serta batas kompatibilitas. Push main memicu deployment production.

**Alur:** tautan → metadata tanpa OAuth/cookie → pemeriksaan HEAD anonim atas URL resmi → tiket aplikasi → periksa ulang izin dan rate limit → HTTP 302 ke Google. Isi file tidak melewati Vercel pada jalur langsung. Docs/Sheets/Slides diekspor sebagai PDF. Bila direct tidak dapat diverifikasi, mode kompatibel memakai streaming API resmi yang dibatasi 25 MiB (binary), 10 MiB (PDF), dan 60 detik. File besar tanpa direct yang terverifikasi ditolak dengan penjelasan.

**Batas:** fallback maksimal 2 transfer per proses dan 6 awal transfer per menit lintas instance melalui RPC Supabase yang sudah ada. Tidak ada perubahan schema atau secret. Folder, shortcut, login wajib, dan bypass pemeriksaan Google tidak didukung. Target sintaks browser Chrome 109/Firefox 115 ESR; perangkat Windows 7 sungguhan belum diuji.
