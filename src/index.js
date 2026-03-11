const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const B2_API = 'https://api.backblazeb2.com';
const DEFAULT_MAX_FILE_MB = 20;
const DEFAULT_GITHUB_MAX_FILE_MB = 25;
const DEFAULT_APP_NAME = 'PairShare cho giao vien';

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
        const githubMaxFileMb = getGithubMaxFileMb(env);
        return apiJson({
          ok: true,
          appName: env.APP_NAME || DEFAULT_APP_NAME,
          maxFileMb: getMaxFileMb(env),
          githubMaxFileMb,
          hasBackblaze: hasBackblazeConfig(env),
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
        ensureAtLeastOneStorage(env);
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
        const githubMaxFileMb = getGithubMaxFileMb(env);
        const maxBytes = maxFileMb * 1024 * 1024;
        const githubMaxBytes = githubMaxFileMb * 1024 * 1024;
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
          const arrayBuffer = await file.arrayBuffer();

          let source = 'github';
          if (file.size > githubMaxBytes) {
            if (!hasBackblazeConfig(env)) {
              return apiJson(
                {
                  ok: false,
                  error: `Tep ${file.name} vuot gioi han GitHub ${githubMaxFileMb} MB. Hay cau hinh Backblaze B2 de tai file lon hon.`,
                },
                400,
              );
            }
            await uploadToBackblaze(env, pairId, storedName, arrayBuffer, file.type);
            source = 'b2';
          } else {
            if (!hasGithubConfig(env)) {
              return apiJson(
                {
                  ok: false,
                  error: 'File nho dang duoc luu tren GitHub, nhung chua cau hinh GitHub.',
                },
                500,
              );
            }
            const repoPath = buildRepoPath(pairId, storedName);
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
          }

          uploaded.push({
            name: decodeStoredOriginalName(storedName),
            storedName,
            path: buildRepoPath(pairId, storedName),
            size: file.size,
            uploadedAt: extractDateFromStoredName(storedName),
            source,
          });
        }

        return apiJson({ ok: true, pairId, uploaded });
      }

      if (url.pathname === '/api/download' && request.method === 'GET') {
        const pairId = sanitizePairId(url.searchParams.get('pairId') || '');
        const storedName = url.searchParams.get('file') || '';
        const source = (url.searchParams.get('source') || '').toLowerCase();
        ensurePairId(pairId);
        ensureStoredName(storedName);

        const response = await downloadBySource(env, pairId, storedName, source);

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
};

function getMaxFileMb(env) {
  const raw = Number.parseInt(env.MAX_FILE_MB || String(DEFAULT_MAX_FILE_MB), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_MB;
}

function getGithubMaxFileMb(env) {
  const raw = Number.parseInt(env.GITHUB_MAX_FILE_MB || String(DEFAULT_GITHUB_MAX_FILE_MB), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GITHUB_MAX_FILE_MB;
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
  ensureAtLeastOneStorage(env);

  const files = [];
  if (hasGithubConfig(env)) {
    files.push(...(await listFilesFromGithub(env, pairId)));
  }

  if (hasBackblazeConfig(env)) {
    files.push(...(await listFilesFromBackblaze(env, pairId)));
  }

  return files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
}

async function listFilesFromGithub(env, pairId) {

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
    }))
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
}

async function listFilesFromBackblaze(env, pairId) {
  const prefix = `${buildRepoFolder(pairId)}/`;
  const b2 = await b2Client(env);
  const response = await fetch(`${b2.apiUrl}/b2api/v3/b2_list_file_names`, {
    method: 'POST',
    headers: {
      Authorization: b2.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: env.B2_BUCKET_ID,
      prefix,
      maxFileCount: 1000,
    }),
  });

  if (!response.ok) {
    throw await b2Error(response, 'Khong lay duoc danh sach tep tu Backblaze.');
  }

  const payload = await response.json();
  const entries = Array.isArray(payload.files) ? payload.files : [];
  return entries
    .filter((item) => item && item.action === 'upload' && item.fileName)
    .map((item) => {
      const storedName = String(item.fileName).slice(prefix.length);
      return {
        name: decodeStoredOriginalName(storedName),
        storedName,
        path: item.fileName,
        size: item.size,
        uploadedAt: extractDateFromStoredName(storedName),
        ext: fileExtension(decodeStoredOriginalName(storedName)),
        source: 'b2',
      };
    });
}

function hasGithubConfig(env) {
  return Boolean(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO);
}

function hasBackblazeConfig(env) {
  return Boolean(env.B2_KEY_ID && env.B2_APPLICATION_KEY && env.B2_BUCKET_ID && env.B2_BUCKET_NAME);
}

function ensureAtLeastOneStorage(env) {
  if (!hasGithubConfig(env) && !hasBackblazeConfig(env)) {
    throw httpError(500, 'Chua cau hinh storage. Hay cau hinh GitHub hoac Backblaze B2.');
  }
}

function ensureGithubConfig(env) {
  const missing = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'].filter((key) => !env[key]);
  if (missing.length) {
    throw httpError(500, `Thieu cau hinh: ${missing.join(', ')}`);
  }
}

async function downloadBySource(env, pairId, storedName, source) {
  if (source === 'b2') {
    return downloadFromBackblaze(env, pairId, storedName);
  }

  if (source === 'github') {
    return downloadFromGithub(env, pairId, storedName);
  }

  if (hasGithubConfig(env)) {
    try {
      return await downloadFromGithub(env, pairId, storedName);
    } catch (error) {
      if (error.status !== 404 || !hasBackblazeConfig(env)) {
        throw error;
      }
    }
  }

  if (hasBackblazeConfig(env)) {
    return downloadFromBackblaze(env, pairId, storedName);
  }

  throw httpError(500, 'Khong tim thay storage phu hop de tai tep.');
}

async function downloadFromGithub(env, pairId, storedName) {
  ensureGithubConfig(env);
  const repoPath = buildRepoPath(pairId, storedName);
  return githubRawRequest(
    env,
    `/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${encodeGithubPath(repoPath)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`,
  );
}

async function downloadFromBackblaze(env, pairId, storedName) {
  if (!hasBackblazeConfig(env)) {
    throw httpError(500, 'Backblaze B2 chua duoc cau hinh.');
  }

  const b2 = await b2Client(env);
  const fileName = buildRepoPath(pairId, storedName);
  const response = await fetch(`${b2.downloadUrl}/file/${encodeURIComponent(env.B2_BUCKET_NAME)}/${encodeB2FileName(fileName)}`, {
    headers: {
      Authorization: b2.authorizationToken,
    },
  });
  if (!response.ok) {
    throw await b2Error(response, `Khong the tai tep tu Backblaze (${response.status}).`);
  }
  return response;
}

async function uploadToBackblaze(env, pairId, storedName, arrayBuffer, contentType) {
  if (!hasBackblazeConfig(env)) {
    throw httpError(500, 'Backblaze B2 chua duoc cau hinh.');
  }

  const b2 = await b2Client(env);
  const uploadUrlRes = await fetch(`${b2.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: {
      Authorization: b2.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID }),
  });

  if (!uploadUrlRes.ok) {
    throw await b2Error(uploadUrlRes, 'Khong lay duoc upload URL tu Backblaze.');
  }

  const uploadConfig = await uploadUrlRes.json();
  const fileName = buildRepoPath(pairId, storedName);
  const sha1 = await sha1Hex(arrayBuffer);
  const uploadRes = await fetch(uploadConfig.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: uploadConfig.authorizationToken,
      'X-Bz-File-Name': encodeB2FileName(fileName),
      'Content-Type': contentType || 'b2/x-auto',
      'Content-Length': String(arrayBuffer.byteLength),
      'X-Bz-Content-Sha1': sha1,
    },
    body: arrayBuffer,
  });

  if (!uploadRes.ok) {
    throw await b2Error(uploadRes, 'Upload Backblaze that bai.');
  }
}

function buildRepoFolder(pairId) {
  return `uploads/${pairId}`;
}

async function b2Client(env) {
  const basic = btoa(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`);
  const response = await fetch(`${B2_API}/b2api/v3/b2_authorize_account`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${basic}`,
    },
  });

  if (!response.ok) {
    throw await b2Error(response, 'Khong xac thuc duoc Backblaze B2.');
  }

  const payload = await response.json();
  return {
    authorizationToken: payload.authorizationToken,
    apiUrl: payload.apiInfo?.storageApi?.apiUrl || payload.apiUrl,
    downloadUrl: payload.apiInfo?.storageApi?.downloadUrl || payload.downloadUrl,
  };
}

async function b2Error(response, fallbackMessage) {
  let message = fallbackMessage;
  try {
    const data = await response.json();
    if (data && data.message) {
      message = data.message;
    }
  } catch {
    // ignore json parse errors
  }
  return httpError(response.status, message);
}

function encodeB2FileName(value) {
  return String(value)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

async function sha1Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-1', arrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
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
  return `${buildRepoFolder(pairId)}/${storedName}`;
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
