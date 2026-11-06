(function () {
  'use strict';
  var form = document.getElementById('download-form');
  var input = document.getElementById('drive-url');
  var button = document.getElementById('inspect-button');
  var label = document.getElementById('inspect-label');
  var status = document.getElementById('status');
  var result = document.getElementById('file-result');
  var link = document.getElementById('download-link');
  var fallback = document.getElementById('fallback-link');
  var help = document.getElementById('download-help');
  var request = null;
  var demo = false;
  var expiryTimer = null;

  function message(text, isError) {
    status.textContent = text;
    status.className = 'status' + (isError ? ' error' : '');
    status.hidden = !text;
  }
  function busy(value) {
    button.disabled = value;
    label.textContent = value ? 'Memeriksa file...' : 'Periksa file';
    form.setAttribute('aria-busy', value ? 'true' : 'false');
  }
  function reset() {
    clearTimeout(expiryTimer);
    if (request) { var previous = request; request = null; previous.abort(); }
    busy(false);
    result.hidden = true;
    link.removeAttribute('href');
    link.removeAttribute('download');
    fallback.hidden = true;
    fallback.removeAttribute('href');
    input.removeAttribute('aria-invalid');
    message('', false);
    demo = false;
  }
  function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }
  function showFile(data) {
    document.getElementById('file-name').textContent = data.name;
    document.getElementById('file-meta').textContent = (data.size === null ? 'Ukuran ekspor ditentukan Google' : size(data.size)) + ' · ' + data.mimeType;
    link.href = data.downloadUrl;
    if (demo) help.textContent = 'Contoh file lokal. Progres unduhan tampil di browser Anda.';
    else if (data.downloadMode === 'proxy') help.textContent = 'Mode kompatibel: maks. ' + (data.proxyLimitBytes === 10485760 ? '10' : '25') + ' MiB dan 60 detik. Tautan berlaku 10 menit; progres tampil di browser.';
    else help.textContent = (data.downloadMode === 'export' ? 'Ekspor PDF langsung dari Google. ' : 'Unduh langsung dari Google. ') + 'Google memeriksa ulang izin dan keamanan. Tautan aplikasi berlaku 10 menit.';
    if (data.fallbackUrl) {
      fallback.href = data.fallbackUrl;
      fallback.textContent = 'Jika unduhan langsung gagal: mode kompatibel (maks. ' + (data.proxyLimitBytes === 10485760 ? '10' : '25') + ' MiB / 60 detik)';
      fallback.hidden = false;
    }
    result.hidden = false;
  }
  input.addEventListener('input', reset);
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    reset();
    var value = input.value.replace(/^\s+|\s+$/g, '');
    if (!value) { input.setAttribute('aria-invalid', 'true'); message('Tempel tautan Google Drive terlebih dahulu.', true); input.focus(); return; }
    if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(value)) { input.setAttribute('aria-invalid', 'true'); message('Gunakan tautan HTTPS dari drive.google.com atau docs.google.com.', true); input.focus(); return; }
    busy(true);
    message('Menghubungi server dan memeriksa akses file...', false);
    var xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open('POST', '/api/inspect', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 25000;
    xhr.onload = function () {
      if (request !== xhr) return;
      request = null;
      busy(false);
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (error) { message('Respons server tidak terbaca. Coba lagi sebentar.', true); return; }
      if (xhr.status !== 200) { message(data.error || 'File belum bisa diperiksa. Coba lagi nanti.', true); status.focus(); return; }
      message('File ditemukan. Siap disimpan ke perangkat Anda.', false);
      showFile(data);
      link.focus();
      expiryTimer = setTimeout(function () { result.hidden = true; link.removeAttribute('href'); message('Tautan unduhan sudah kedaluwarsa. Klik Periksa file untuk membuat tautan baru.', true); }, data.expiresIn * 1000);
    };
    xhr.onerror = function () { if (request === xhr) { request = null; busy(false); message('Koneksi terputus. Periksa jaringan Anda lalu coba lagi.', true); } };
    xhr.ontimeout = function () { if (request === xhr) { request = null; busy(false); message('Server terlalu lama merespons. Silakan coba kembali.', true); } };
    xhr.send(JSON.stringify({ url: value }));
  });
  document.getElementById('paste-button').addEventListener('click', function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) { reset(); input.value = text; input.focus(); }, function () { input.focus(); message('Tekan Ctrl+V atau tahan kolom tautan untuk menempel.', false); });
    } else { input.focus(); message('Tekan Ctrl+V atau tahan kolom tautan untuk menempel.', false); }
  });
  document.getElementById('demo-button').addEventListener('click', function () {
    reset();
    demo = true;
    message('Mode contoh: file lokal untuk mencoba alur. Tidak mengakses Google Drive.', false);
    showFile({ name: 'Contoh-DriveBridge.svg', size: 779, mimeType: 'image/svg+xml', downloadUrl: '/sample.svg' });
    link.setAttribute('download', 'Contoh-DriveBridge.svg');
    link.focus();
  });
  link.addEventListener('click', function () { message(demo ? 'File contoh dikirim. Lihat pengelola unduhan browser Anda.' : 'Permintaan unduhan dikirim. Lihat pengelola unduhan browser; status selesai ditampilkan di sana.', false); });
  fallback.addEventListener('click', function () { message('Mode kompatibel diproses lewat server dan dibatasi ukuran serta 60 detik. Cek status selesai di pengelola unduhan browser.', false); });
  var faqs = document.querySelectorAll('.faq button');
  for (var i = 0; i < faqs.length; i++) {
    faqs[i].addEventListener('click', function () {
      var open = this.getAttribute('aria-expanded') === 'true';
      this.setAttribute('aria-expanded', open ? 'false' : 'true');
      document.getElementById(this.getAttribute('aria-controls')).hidden = open;
      this.querySelector('span').textContent = open ? '+' : '−';
    });
  }
}());
