import { createHmac, timingSafeEqual } from 'node:crypto';

export const PROXY_MAX_BYTES = 25 * 1024 * 1024;
export const EXPORT_MAX_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60000;
const PDF = 'application/pdf';
const workspaceTypes = new Set(['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.presentation']);

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseDriveLink(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new AppError(400, 'Masukkan tautan Google Drive yang valid.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new AppError(400, 'Tautan belum lengkap. Salin tautan dari menu Bagikan di Google Drive.'); }
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new AppError(400, 'Gunakan tautan HTTPS dari drive.google.com atau docs.google.com.');
  }
  if (/\/folders(?:\/|$)/.test(url.pathname)) throw new AppError(400, 'Folder belum didukung. Tempel tautan satu file di dalam folder.');
  const match = url.pathname.match(/^\/(?:file|document|spreadsheets|presentation)\/d\/([\w-]+)(?:\/|$)/);
  const id = match ? match[1] : ['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null;
  const resourceKey = url.searchParams.get('resourcekey') || '';
  if (!id || !/^[\w-]{10,200}$/.test(id) || !/^[\w-]{0,200}$/.test(resourceKey)) throw new AppError(400, 'ID file tidak ditemukan. Gunakan tautan Bagikan untuk satu file Google Drive.');
  return { id, resourceKey };
}

function secret() {
  const value = process.env.DOWNLOAD_TOKEN_SECRET;
  if (!value || value.length < 32) throw new AppError(503, 'Layanan belum dikonfigurasi. Hubungi pengelola untuk mengaktifkan unduhan.');
  return value;
}
export function signTicket(file, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ id: file.id, resourceKey: file.resourceKey, expires: now + 10 * 60 * 1000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret()).update(payload).digest('base64url');
}
export function verifyTicket(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1500) throw new AppError(400, 'Tautan unduhan tidak valid. Periksa file kembali.');
  const [payload, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret()).update(payload || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new AppError(403, 'Tautan unduhan tidak valid. Periksa file kembali.');
  let file;
  try { file = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new AppError(400, 'Tautan unduhan tidak valid.'); }
  if (!Number.isFinite(file.expires) || file.expires <= now) throw new AppError(410, 'Tautan unduhan sudah kedaluwarsa. Periksa file kembali.');
  if (!/^[\w-]{10,200}$/.test(file.id) || typeof file.resourceKey !== 'string' || !/^[\w-]{0,200}$/.test(file.resourceKey)) throw new AppError(400, 'Tautan unduhan tidak valid.');
  return file;
}

export function driveRequest(file, { media = false, range, signal } = {}) {
  if (!process.env.GOOGLE_DRIVE_API_KEY) throw new AppError(503, 'Google Drive belum terhubung. Pengelola perlu mengisi API key di server.');
  const url = new URL('https://www.googleapis.com/drive/v3/files/' + file.id);
  url.searchParams.set('key', process.env.GOOGLE_DRIVE_API_KEY);
  if (media && file.exportMimeType) {
    url.pathname += '/export';
    url.searchParams.set('mimeType', file.exportMimeType);
  } else if (media) url.searchParams.set('alt', 'media');
  else url.searchParams.set('fields', 'id,name,mimeType,size,resourceKey,webContentLink,exportLinks,capabilities(canDownload)');
  const headers = {};
  if (file.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = file.id + '/' + file.resourceKey;
  if (range) headers.Range = range;
  // Never fetch a user-controlled URL or follow an upstream redirect.
  return fetch(url, { headers, redirect: 'error', signal: signal || AbortSignal.timeout(15000) });
}

export async function checkGoogleResponse(response) {
  if (response.ok) return;
  let reason;
  try { reason = (await response.json()).error?.errors?.[0]?.reason; } catch { /* Non-JSON upstream errors use the HTTP status below. */ }
  if (['downloadQuotaExceeded', 'userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded'].includes(reason) || response.status === 429) throw new AppError(429, 'Kuota Google Drive sedang dibatasi. Tunggu dan coba lagi; mode kompatibel tidak melewati kuota Google.');
  if (reason === 'exportSizeLimitExceeded') throw new AppError(413, 'Hasil ekspor Google melebihi batas 10 MB. Ekspor file dari Google atau pilih dokumen yang lebih kecil.');
  if (['cannotDownloadAbusiveFile', 'abusiveFile'].includes(reason)) throw new AppError(403, 'Google menandai file ini berbahaya atau memerlukan pemeriksaan keamanan. DriveBridge tidak melewati pemeriksaan tersebut.');
  if (response.status === 401 || ['keyInvalid', 'accessNotConfigured'].includes(reason)) throw new AppError(503, 'Konfigurasi Google Drive perlu diperiksa oleh pengelola.');
  if (response.status === 404) throw new AppError(404, 'File tidak ditemukan atau belum dibagikan ke Siapa saja yang memiliki link.');
  if (response.status === 403) throw new AppError(403, 'Izin unduhan ditolak atau sudah berubah. Pastikan file publik dan pemilik mengizinkan unduhan.');
  if (response.status === 416) throw new AppError(416, 'Posisi unduhan tidak valid. Mulai ulang unduhan.');
  throw new AppError(502, 'Google Drive belum dapat dihubungi. Coba beberapa saat lagi.');
}

export async function getFile(file, signal) {
  const response = await driveRequest(file, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : undefined });
  await checkGoogleResponse(response);
  const data = await response.json();
  if (data.capabilities?.canDownload === false) throw new AppError(403, 'Pemilik file tidak mengizinkan unduhan.');
  if (data.capabilities?.canDownload !== true) throw new AppError(403, 'Izin unduh tanpa login belum dapat diverifikasi. Pastikan file publik dan pemilik mengizinkan unduhan.');
  const workspace = workspaceTypes.has(data.mimeType);
  if (String(data.mimeType).startsWith('application/vnd.google-apps.') && !workspace) throw new AppError(400, 'Folder, shortcut, dan format Google ini belum didukung. Docs, Sheets, dan Slides dapat diekspor sebagai PDF.');
  if (data.id !== file.id || typeof data.name !== 'string' || !data.name || typeof data.mimeType !== 'string') throw new AppError(502, 'Informasi file dari Google belum lengkap.');
  const size = workspace ? null : Number(data.size);
  if (!workspace && (!/^\d+$/.test(String(data.size)) || !Number.isSafeInteger(size))) throw new AppError(502, 'Ukuran file dari Google tidak valid.');
  const resourceKey = data.resourceKey || file.resourceKey;
  if (typeof resourceKey !== 'string' || !/^[\w-]{0,200}$/.test(resourceKey)) throw new AppError(502, 'Resource key file tidak valid.');
  const result = { id: file.id, resourceKey, name: workspace && !data.name.toLowerCase().endsWith('.pdf') ? data.name + '.pdf' : data.name, size, mimeType: workspace ? PDF : data.mimeType, exportMimeType: workspace ? PDF : undefined };
  result.contentLink = contentLink(workspace ? data.exportLinks?.[PDF] : data.webContentLink, result);
  return result;
}

// These URLs are never supplied by the client; only Drive metadata can nominate a target.
function googleBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  if (!['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(url.hostname) && !url.hostname.endsWith('.googleusercontent.com')) return null;
  for (const key of url.searchParams.keys()) if (/^(key|apikey|api_key|access_token|oauth_token|id_token|refresh_token|client_secret|authorization|credential|token|x-goog-credential|x-goog-signature|url|redirect|redirect_uri|redirect_url|continue|next)$/i.test(key)) return null;
  return url;
}

function contentLink(value, file) {
  const url = googleBrowserUrl(value);
  if (!url) return null;
  const parameters = file.exportMimeType ? ['id', 'format', 'exportFormat', 'resourcekey', 'authuser'] : ['id', 'export', 'resourcekey', 'authuser'];
  for (const key of url.searchParams.keys()) if (!parameters.includes(key)) return null;
  const pathId = url.pathname.match(/\/d\/([\w-]+)(?:\/|$)/)?.[1];
  if ((pathId || url.searchParams.get('id')) !== file.id) return null;
  if (file.exportMimeType) {
    if (url.hostname !== 'docs.google.com' || !/\/export(?:\/|$)/i.test(url.pathname)) return null;
    if (![url.searchParams.get('format'), url.searchParams.get('exportFormat'), url.pathname.split('/').pop()].includes('pdf')) return null;
  } else if (!(['drive.google.com', 'drive.usercontent.google.com'].includes(url.hostname) && ['/uc', '/download'].includes(url.pathname)) || (url.searchParams.has('export') && url.searchParams.get('export') !== 'download')) return null;
  if (file.resourceKey) url.searchParams.set('resourcekey', file.resourceKey);
  return url.href;
}

export async function directDownload(file, signal) {
  if (!file.contentLink) return null;
  let url = new URL(file.contentLink);
  const deadline = AbortSignal.timeout(5000);
  try {
    for (let hop = 0; hop < 4; hop++) {
      // HEAD only: no cookies, authorization, API key, Range probe, or file bytes.
      const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        url = location ? googleBrowserUrl(new URL(location, url).href) : null;
        if (!url) return null;
        continue;
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '') || !type || ['text/html', 'application/xhtml+xml'].includes(type)) return null;
      return file.contentLink;
    }
  } catch { /* A blocked/unsupported anonymous HEAD must not force a browser redirect. */ }
  return null;
}

export function proxyAllowed(file) { return Boolean(file.exportMimeType) || file.size <= PROXY_MAX_BYTES; }

export async function downloadPlan(file, signal) {
  const target = await directDownload(file, signal);
  if (!target && !proxyAllowed(file)) throw new AppError(422, 'Google tidak menyediakan tautan langsung yang dapat diverifikasi tanpa login. File ini melebihi batas mode kompatibel 25 MiB; gunakan unduhan resmi Google.');
  return { mode: target ? (file.exportMimeType ? 'export' : 'direct') : 'proxy', target };
}

export function disposition(name) {
  const safe = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'download';
  const ascii = safe.replace(/[^\x20-\x7e]|[";]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
}
