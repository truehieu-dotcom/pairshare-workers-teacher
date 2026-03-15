const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_MAX_FILE_MB = 20;
const DEFAULT_LARGE_FILE_THRESHOLD_MB = 25;
const DEFAULT_R2_RETENTION_HOURS = 24;
const DEFAULT_APP_NAME = 'PairShare cho giao vien';
const R2_UPLOAD_PREFIX = 'uploads-r2';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === '/api/health') {
        return apiJson({ ok: true, now: new Date().toISOString() });
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return apiJson({
          ok: true,
          appName: env.APP_NAME || DEFAULT_APP_NAME,
          maxFileMb: getMaxFileMb(env),
          largeFileThresholdMb: getLargeFileThresholdMb(env),
          r2RetentionHours: getR2RetentionHours(env),
          hasR2Storage: hasR2Storage(env),
          samplePairIds: ['TOAN-9A', 'VAN-12B', 'HOP-GV'],
        });
      }

      if (url.pathname.startsWith('/api/files/') && request.method === 'GET') {
        const pairId = sanitizePairId(decodeURIComponent(url.pathname.replace('/api/files/', '')));
        ensurePairId(pairId);
        const files = await listFilesForPair(env, pairId);
        return apiJson({ ok: true, pairId, files });
      }

      if (url.pathname === '/api/upload' && request.method === 'POST') {
        ensureGithubConfig(env);
        const formData = await request.formData();
        const pairId = sanitizePairId(String(formData.get('pairId') || ''));
        ensurePairId(pairId);

        const fileEntries = formData
          .getAll('files')
          .filter((entry) => entry && typeof entry.arrayBuffer === 'function');

        if (!fileEntries.length) {
          return apiJson({ ok: false, error: 'Vui long chon it nhat 1 tep.' }, 400);
        }

        const maxFileMb = getMaxFileMb(env);
        const largeFileThresholdMb = getLargeFileThresholdMb(env);
        const largeFileThresholdBytes = largeFileThresholdMb * 1024 * 1024;
        const maxBytes = maxFileMb * 1024 * 1024;
        const uploaded = [];

        for (const file of fileEntries) {
          if (file.size > maxBytes) {
            return apiJson(
              {
                ok: false,
                error: `Tep ${file.name} vuot gioi han ${maxFileMb} MB.`,
              },
              400,
            );
          }

          const storedName = buildStoredFileName(file.name);
          const uploadedAt = extractDateFromStoredName(storedName);

          if (file.size > largeFileThresholdBytes) {
            ensureR2Storage(env);
            const key = buildR2ObjectKey(pairId, storedName);
            await env.R2_UPLOADS.put(key, file.stream(), {
              httpMetadata: {
                contentType: file.type || 'application/octet-stream',
                contentDisposition: contentDispositionFor(decodeStoredOriginalName(storedName)),
              },
              customMetadata: {
                pairId,
                originalName: decodeStoredOriginalName(storedName),
                uploadedAt,
              },
            });

            uploaded.push({
              name: decodeStoredOriginalName(storedName),
              storedName,
              path: key,
              size: file.size,
              uploadedAt,
              source: 'r2',
              expiresAt: calculateExpiresAt(uploadedAt, getR2RetentionHours(env)),
            });
            continue;
          }

          const repoPath = buildRepoPath(pairId, storedName);
          const arrayBuffer = await file.arrayBuffer();
          const content = arrayBufferToBase64(arrayBuffer);
          const message = `Upload ${decodeStoredOriginalName(storedName)} to ${pairId}`;

          await githubRequest(
            env,
            `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodeGithubPath(repoPath)}`,
            {
              method: 'PUT',
              body: JSON.stringify({
                message,
                content,
                branch: env.GITHUB_BRANCH || 'main',
              }),
            },
          );

          uploaded.push({
            name: decodeStoredOriginalName(storedName),
            storedName,
            path: repoPath,
            size: file.size,
            uploadedAt,
            source: 'github',
          });
        }

        return apiJson({ ok: true, pairId, uploaded });
      }

      if (url.pathname === '/api/download' && request.method === 'GET') {
        ensureGithubConfig(env);
        const pairId = sanitizePairId(url.searchParams.get('pairId') || '');
        const storedName = url.searchParams.get('file') || '';
        const source = url.searchParams.get('source') || 'github';
        ensurePairId(pairId);
        ensureStoredName(storedName);
        ensureStorageSource(source);

        if (source === 'r2') {
          ensureR2Storage(env);
          const r2Key = buildR2ObjectKey(pairId, storedName);
          const object = await env.R2_UPLOADS.get(r2Key);
          if (!object) {
            throw httpError(404, 'File khong ton tai hoac da het han tren R2.');
          }

          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set('Content-Disposition', contentDispositionFor(decodeStoredOriginalName(storedName)));
          headers.set('Cache-Control', 'no-store');

          return withCors(
            new Response(object.body, {
              status: 200,
              headers,
            }),
          );
        }

        const repoPath = buildRepoPath(pairId, storedName);
        const response = await githubRawRequest(
          env,
          `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodeGithubPath(repoPath)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`,
        );

        const headers = new Headers(response.headers);
        headers.set('Content-Disposition', contentDispositionFor(decodeStoredOriginalName(storedName)));
        headers.set('Cache-Control', 'no-store');

        return withCors(
          new Response(response.body, {
            status: 200,
            headers,
          }),
        );
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(fallbackHtml(env), {
        headers: {
          'content-type': 'text/html; charset=UTF-8',
        },
      });
    } catch (error) {
      console.error(error);
      const status = error && Number.isInteger(error.status) ? error.status : 500;
      const message = error && error.message ? error.message : 'Da xay ra loi khong mong muon.';
      return apiJson({ ok: false, error: message }, status);
    }
  },

  async scheduled(_controller, env) {
    if (!hasR2Storage(env)) {
      return;
    }
    await deleteExpiredR2Objects(env);
  },
};

function getMaxFileMb(env) {
  const raw = Number.parseInt(env.MAX_FILE_MB || String(DEFAULT_MAX_FILE_MB), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_MB;
}

function getLargeFileThresholdMb(env) {
  const raw = Number.parseInt(env.LARGE_FILE_THRESHOLD_MB || String(DEFAULT_LARGE_FILE_THRESHOLD_MB), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LARGE_FILE_THRESHOLD_MB;
}

function getR2RetentionHours(env) {
  const raw = Number.parseInt(env.R2_RETENTION_HOURS || String(DEFAULT_R2_RETENTION_HOURS), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_R2_RETENTION_HOURS;
}

function fallbackHtml(env) {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(env.APP_NAME || DEFAULT_APP_NAME)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #f6f8fb; color: #10233f; }
      .card { max-width: 760px; margin: 0 auto; background: white; border-radius: 20px; padding: 28px; box-shadow: 0 16px 40px rgba(16, 35, 63, 0.08); }
      h1 { margin-top: 0; }
      code { background: #eef4ff; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(env.APP_NAME || DEFAULT_APP_NAME)}</h1>
      <p>Static assets chua duoc gan vao Worker nay.</p>
      <p>Hay deploy voi <code>wrangler deploy</code> va cau hinh <code>[assets]</code> trong <code>wrangler.toml</code>.</p>
    </div>
  </body>
</html>`;
}

async function listFilesForPair(env, pairId) {
  const githubFiles = await listGithubFilesForPair(env, pairId);
  const r2Files = await listR2FilesForPair(env, pairId);

  return [...githubFiles, ...r2Files]
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
}

async function listGithubFilesForPair(env, pairId) {
  ensureGithubConfig(env);

  const folderPath = `uploads/${pairId}`;
  const response = await githubRequest(
    env,
    `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodeGithubPath(folderPath)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`,
    {
      method: 'GET',
    },
    { allow404: true },
  );

  if (response.status === 404) {
    return [];
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .filter((item) => item && item.type === 'file')
    .map((item) => ({
      name: decodeStoredOriginalName(item.name),
      storedName: item.name,
      path: item.path,
      size: item.size,
      sha: item.sha,
      uploadedAt: extractDateFromStoredName(item.name),
      ext: fileExtension(decodeStoredOriginalName(item.name)),
      source: 'github',
    }));
}

async function listR2FilesForPair(env, pairId) {
  if (!hasR2Storage(env)) {
    return [];
  }

  const objects = [];
  let cursor;

  do {
    const listing = await env.R2_UPLOADS.list({
      prefix: `${buildR2PairPrefix(pairId)}/`,
      cursor,
    });
    objects.push(...listing.objects);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const retentionHours = getR2RetentionHours(env);

  return objects
    .map((object) => {
      const storedName = object.key.split('/').pop() || object.key;
      const uploadedAt = extractDateFromStoredName(storedName);
      return {
        name: decodeStoredOriginalName(storedName),
        storedName,
        path: object.key,
        size: object.size,
        uploadedAt,
        ext: fileExtension(decodeStoredOriginalName(storedName)),
        source: 'r2',
        expiresAt: calculateExpiresAt(uploadedAt, retentionHours),
      };
    })
    .filter((file) => !isExpired(file.expiresAt));
}

function ensureGithubConfig(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'].filter((key) => !env[key]);
  if (missing.length) {
    throw httpError(500, `Thieu cau hinh: ${missing.join(', ')}`);
  }
}

function hasR2Storage(env) {
  return Boolean(env.R2_UPLOADS);
}

function ensureR2Storage(env) {
  if (!hasR2Storage(env)) {
    throw httpError(500, 'R2 chua duoc cau hinh. Hay them binding R2_UPLOADS trong wrangler.toml.');
  }
}

function ensureStorageSource(source) {
  if (!['github', 'r2'].includes(source)) {
    throw httpError(400, 'Nguon luu tru khong hop le.');
  }
}

function buildR2PairPrefix(pairId) {
  return `${R2_UPLOAD_PREFIX}/${pairId}`;
}

function buildR2ObjectKey(pairId, storedName) {
  return `${buildR2PairPrefix(pairId)}/${storedName}`;
}

function calculateExpiresAt(uploadedAt, retentionHours) {
  const createdAt = new Date(uploadedAt).getTime();
  return new Date(createdAt + retentionHours * 60 * 60 * 1000).toISOString();
}

function isExpired(expiresAt) {
  return new Date(expiresAt).getTime() <= Date.now();
}

async function deleteExpiredR2Objects(env) {
  const retentionMs = getR2RetentionHours(env) * 60 * 60 * 1000;
  let cursor;

  do {
    const listing = await env.R2_UPLOADS.list({ prefix: `${R2_UPLOAD_PREFIX}/`, cursor });
    const expiredKeys = listing.objects
      .filter((object) => Date.now() - new Date(object.uploaded).getTime() >= retentionMs)
      .map((object) => object.key);

    if (expiredKeys.length) {
      await env.R2_UPLOADS.delete(expiredKeys);
    }

    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function githubRequest(env, path, init = {}, options = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  headers.set('User-Agent', 'pairshare-teacher-worker');

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok && !(options.allow404 && response.status === 404)) {
    let message = `GitHub API loi ${response.status}`;
    try {
      const data = await response.json();
      if (data && data.message) {
        message = data.message;
      }
    } catch {
      // ignore json parse errors
    }
    throw httpError(response.status, message);
  }

  return response;
}

async function githubRawRequest(env, path) {
  const headers = new Headers();
  headers.set('Accept', 'application/vnd.github.raw+json');
  headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  headers.set('User-Agent', 'pairshare-teacher-worker');

  const response = await fetch(`${GITHUB_API}${path}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    let message = `Khong the tai tep (${response.status})`;
    try {
      const data = await response.json();
      if (data && data.message) {
        message = data.message;
      }
    } catch {
      // ignore json parse errors
    }
    throw httpError(response.status, message);
  }

  return response;
}

function sanitizePairId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function ensurePairId(pairId) {
  if (!pairId || pairId.length < 3 || pairId.length > 32) {
    throw httpError(400, 'Ma chia se can tu 3 den 32 ky tu, chi gom chu cai, so va dau gach ngang.');
  }
}

function ensureStoredName(storedName) {
  if (!storedName || storedName.includes('/') || storedName.includes('\\')) {
    throw httpError(400, 'Ten tep khong hop le.');
  }
}

function buildStoredFileName(originalName) {
  const cleaned = cleanOriginalFileName(originalName || 'tep-moi');
  const encodedOriginal = encodeURIComponent(cleaned);
  const suffix = cryptoRandomId(6);
  return `${Date.now()}__${suffix}__${encodedOriginal}`;
}

function cleanOriginalFileName(name) {
  const normalized = String(name || 'tep-moi')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 160);

  return normalized || 'tep-moi';
}

function decodeStoredOriginalName(storedName) {
  const parts = String(storedName || '').split('__');
  if (parts.length < 3) {
    return storedName;
  }
  try {
    return decodeURIComponent(parts.slice(2).join('__'));
  } catch {
    return parts.slice(2).join('__');
  }
}

function extractDateFromStoredName(storedName) {
  const raw = Number.parseInt(String(storedName || '').split('__')[0], 10);
  if (!Number.isFinite(raw)) {
    return new Date().toISOString();
  }
  return new Date(raw).toISOString();
}

function buildRepoPath(pairId, storedName) {
  return `uploads/${pairId}/${storedName}`;
}

function encodeGithubPath(path) {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function cryptoRandomId(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (const byte of bytes) {
    result += alphabet[byte % alphabet.length];
  }
  return result;
}

function fileExtension(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function contentDispositionFor(filename) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${fallback.replace(/"/g, '')}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function apiJson(data, status = 200) {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'cache-control': 'no-store',
      },
    }),
  );
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
