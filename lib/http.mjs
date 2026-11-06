import { AppError } from './drive.mjs';

export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
export function errorResponse(res, error, html = false) {
  const status = error instanceof AppError ? error.status : 502;
  const message = error instanceof AppError ? error.message : 'Koneksi ke layanan terputus. Silakan coba kembali.';
  if (status === 429) res.setHeader('Retry-After', '60');
  if (!html) return json(res, status, { error: message });
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unduhan belum tersedia — DriveBridge</title><link rel="stylesheet" href="/styles.css"><main class="error-page"><a class="brand" href="/">DriveBridge</a><h1>Unduhan belum tersedia</h1><p>' + message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '</p><a class="primary" href="/">Kembali dan periksa file</a></main></html>');
}

