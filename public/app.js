const state = {
  pairId: '',
  files: [],
  selectedFiles: [],
  maxFileMb: 20,
  largeFileThresholdMb: 25,
  r2RetentionHours: 24,
  hasR2Storage: false,
  refreshInterval: null,
  pairInputTimer: null,
};

const els = {
  pairIdInput: document.getElementById('pairIdInput'),
  shareLinkInput: document.getElementById('shareLinkInput'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  generatePairBtn: document.getElementById('generatePairBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  fileInput: document.getElementById('fileInput'),
  dropZone: document.getElementById('dropZone'),
  uploadBtn: document.getElementById('uploadBtn'),
  clearFilesBtn: document.getElementById('clearFilesBtn'),
  selectedFilesList: document.getElementById('selectedFilesList'),
  selectedCount: document.getElementById('selectedCount'),
  filesList: document.getElementById('filesList'),
  statusBanner: document.getElementById('statusBanner'),
  fileCountPill: document.getElementById('fileCountPill'),
  pairPill: document.getElementById('pairPill'),
  configHint: document.getElementById('configHint'),
  currentPairText: document.getElementById('currentPairText'),
  visibleFileCount: document.getElementById('visibleFileCount'),
};

init().catch((error) => {
  console.error(error);
  setStatus('Khong the khoi dong ung dung.', 'error');
});

async function init() {
  bindEvents();
  await loadConfig();

  const initialPair =
    sanitizePairId(new URLSearchParams(window.location.search).get('pair') || '') ||
    sanitizePairId(localStorage.getItem('pairshare:lastPairId') || '') ||
    'TOAN-9A';

  setPairId(initialPair, { refresh: false, replaceHistory: true });
  renderSelectedFiles();
  await refreshFiles();
  startAutoRefresh();
}

function bindEvents() {
  els.pairIdInput.addEventListener('input', () => {
    const value = sanitizePairId(els.pairIdInput.value);
    els.pairIdInput.value = value;

    window.clearTimeout(state.pairInputTimer);
    state.pairInputTimer = window.setTimeout(() => {
      setPairId(value, { refresh: true });
    }, 280);
  });

  els.pairIdInput.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const value = sanitizePairId(els.pairIdInput.value);
      setPairId(value, { refresh: false });
      await refreshFiles(true);
    }
  });

  els.copyLinkBtn.addEventListener('click', async () => {
    if (!state.pairId) {
      setStatus('Hay nhap Pair ID truoc khi copy link.', 'error');
      return;
    }
    await copyText(getShareLink(state.pairId), 'Da copy link chia se.');
  });

  els.generatePairBtn.addEventListener('click', async () => {
    const nextPair = generatePairId();
    setPairId(nextPair, { refresh: false });
    setStatus(`Da tao ma moi: ${nextPair}`, 'success');
    await refreshFiles();
  });

  els.refreshBtn.addEventListener('click', async () => {
    await refreshFiles(true);
  });

  document.querySelectorAll('[data-pair]').forEach((button) => {
    button.addEventListener('click', async () => {
      setPairId(button.dataset.pair || '', { refresh: false });
      await refreshFiles();
    });
  });

  els.fileInput.addEventListener('change', () => {
    handleSelectedFiles(Array.from(els.fileInput.files || []));
    els.fileInput.value = '';
  });

  els.clearFilesBtn.addEventListener('click', () => {
    state.selectedFiles = [];
    renderSelectedFiles();
    setStatus('Da bo chon cac file.', 'info');
  });

  els.uploadBtn.addEventListener('click', uploadSelectedFiles);

  ['dragenter', 'dragover'].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (eventName !== 'drop') {
        els.dropZone.classList.remove('is-dragover');
      }
    });
  });

  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('is-dragover');
    const droppedFiles = Array.from(event.dataTransfer?.files || []);
    handleSelectedFiles(droppedFiles);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.pairId) {
      refreshFiles();
    }
  });
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || 'Khong doc duoc cau hinh.');
    }
    state.maxFileMb = Number(data.maxFileMb || 20);
    state.largeFileThresholdMb = Number(data.largeFileThresholdMb || 25);
    state.r2RetentionHours = Number(data.r2RetentionHours || 24);
    state.hasR2Storage = Boolean(data.hasR2Storage);
    document.title = data.appName || document.title;
    els.configHint.textContent = `<= ${state.largeFileThresholdMb} MB luu GitHub, > ${state.largeFileThresholdMb} MB luu R2 (${state.r2RetentionHours}h). Gioi han toi da: ${state.maxFileMb} MB`;
  } catch (error) {
    console.error(error);
    els.configHint.textContent = 'Khong tai duoc cau hinh, tam dung gioi han mac dinh 20 MB';
  }
}

function setPairId(rawPairId, options = {}) {
  const { refresh = false, replaceHistory = false } = options;
  const pairId = sanitizePairId(rawPairId);
  state.pairId = pairId;
  els.pairIdInput.value = pairId;
  els.shareLinkInput.value = pairId ? getShareLink(pairId) : '';
  els.pairPill.textContent = pairId || 'Chua co ma';
  els.currentPairText.textContent = pairId || 'Chua chon';

  if (pairId) {
    localStorage.setItem('pairshare:lastPairId', pairId);
  } else {
    localStorage.removeItem('pairshare:lastPairId');
  }

  const url = new URL(window.location.href);
  if (pairId) {
    url.searchParams.set('pair', pairId);
  } else {
    url.searchParams.delete('pair');
  }

  if (replaceHistory) {
    window.history.replaceState({}, '', url);
  } else {
    window.history.replaceState({}, '', url);
  }

  if (refresh) {
    refreshFiles();
  }
}

function startAutoRefresh() {
  window.clearInterval(state.refreshInterval);
  state.refreshInterval = window.setInterval(() => {
    if (document.visibilityState === 'visible' && state.pairId) {
      refreshFiles();
    }
  }, 10000);
}

function handleSelectedFiles(files) {
  if (!files.length) {
    return;
  }

  const oversized = files.filter((file) => file.size > state.maxFileMb * 1024 * 1024);
  if (oversized.length) {
    setStatus(
      `Co ${oversized.length} file vuot gioi han ${state.maxFileMb} MB. Hay tach nho hoac doi gioi han server.`,
      'error',
    );
  }

  const accepted = files.filter((file) => file.size <= state.maxFileMb * 1024 * 1024);
  state.selectedFiles = [...state.selectedFiles, ...accepted];
  renderSelectedFiles();

  if (accepted.length) {
    setStatus(`Da chon ${accepted.length} file de tai len.`, 'info');
  }
}

function renderSelectedFiles() {
  els.selectedCount.textContent = `${state.selectedFiles.length} file`;

  if (!state.selectedFiles.length) {
    els.selectedFilesList.className = 'file-pill-list empty-state-inline';
    els.selectedFilesList.textContent = 'Chua co file nao duoc chon.';
    return;
  }

  els.selectedFilesList.className = 'file-pill-list';
  els.selectedFilesList.innerHTML = state.selectedFiles
    .map(
      (file) =>
        `<span class="file-pill">${escapeHtml(file.name)} · ${formatBytes(file.size)}</span>`,
    )
    .join('');
}

async function uploadSelectedFiles() {
  if (!state.pairId) {
    setStatus('Hay nhap Pair ID truoc khi tai file len.', 'error');
    els.pairIdInput.focus();
    return;
  }

  if (!state.selectedFiles.length) {
    setStatus('Hay chon file truoc khi bam Tai len ngay.', 'error');
    return;
  }

  setUploadBusy(true, 'Dang tai len...');
  setStatus(`Dang tai ${state.selectedFiles.length} file len ma ${state.pairId}...`, 'info');

  const formData = new FormData();
  formData.append('pairId', state.pairId);
  state.selectedFiles.forEach((file) => formData.append('files', file));

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Tai file that bai.');
    }

    const uploadedCount = Array.isArray(data.uploaded) ? data.uploaded.length : state.selectedFiles.length;
    state.selectedFiles = [];
    renderSelectedFiles();
    setStatus(`Tai len thanh cong ${uploadedCount} file cho ma ${state.pairId}.`, 'success');
    await refreshFiles();
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Tai file that bai.', 'error');
  } finally {
    setUploadBusy(false, 'Tai len ngay');
  }
}

async function refreshFiles(showFreshMessage = false) {
  if (!state.pairId) {
    state.files = [];
    renderFiles();
    return;
  }

  try {
    const response = await fetch(`/api/files/${encodeURIComponent(state.pairId)}`, {
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Khong tai duoc danh sach file.');
    }

    state.files = Array.isArray(data.files) ? data.files : [];
    renderFiles();

    if (showFreshMessage) {
      setStatus(`Da lam moi danh sach cho ma ${state.pairId}.`, 'info');
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Khong tai duoc danh sach file.', 'error');
  }
}

function renderFiles() {
  const count = state.files.length;
  els.fileCountPill.textContent = `${count} file`;
  els.visibleFileCount.textContent = String(count);

  if (!state.pairId) {
    els.filesList.className = 'files-list empty-list';
    els.filesList.textContent = 'Hay nhap Pair ID de xem tai lieu da chia se.';
    return;
  }

  if (!count) {
    els.filesList.className = 'files-list empty-list';
    els.filesList.textContent = `Chua co tai lieu nao trong ma ${state.pairId}.`;
    return;
  }

  els.filesList.className = 'files-list';
  els.filesList.innerHTML = state.files
    .map((file) => {
      const downloadUrl = getDownloadUrl(file.storedName);
      const icon = iconForFile(file.ext || '');
      return `
        <article class="file-card">
          <div class="file-icon">${icon}</div>
          <div class="file-main">
            <div class="file-name">${escapeHtml(file.name)}</div>
            <div class="file-meta">
              ${formatBytes(file.size)} · ${file.source === 'r2' ? 'R2' : 'GitHub'} · Tai len luc ${formatDateTime(file.uploadedAt)}${file.expiresAt ? ` · Het han ${formatDateTime(file.expiresAt)}` : ''}
            </div>
          </div>
          <div class="file-actions">
            <a class="file-action primary" href="${downloadUrl}">Tai xuong</a>
            <button class="file-action" type="button" data-copy-file="${encodeURIComponent(downloadUrl)}">Copy link file</button>
          </div>
        </article>
      `;
    })
    .join('');

  els.filesList.querySelectorAll('[data-copy-file]').forEach((button) => {
    button.addEventListener('click', async () => {
      const downloadUrl = decodeURIComponent(button.dataset.copyFile || '');
      await copyText(downloadUrl, 'Da copy link tai file.');
    });
  });
}

function getShareLink(pairId) {
  return `${window.location.origin}/?pair=${encodeURIComponent(pairId)}`;
}

function getDownloadUrl(storedName) {
  const url = new URL('/api/download', window.location.origin);
  url.searchParams.set('pairId', state.pairId);
  url.searchParams.set('file', storedName);
  const matchedFile = state.files.find((item) => item.storedName === storedName);
  if (matchedFile && matchedFile.source) {
    url.searchParams.set('source', matchedFile.source);
  }
  return url.toString();
}

function generatePairId() {
  const labels = ['LOP', 'GV', 'HOP', 'TOAN', 'VAN', 'ANH', 'KHTN'];
  const left = labels[Math.floor(Math.random() * labels.length)];
  const right = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${left}-${right}`;
}

function sanitizePairId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'khong ro';
  }
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function iconForFile(ext) {
  const map = {
    pdf: 'PDF',
    doc: 'DOC',
    docx: 'DOC',
    ppt: 'PPT',
    pptx: 'PPT',
    xls: 'XLS',
    xlsx: 'XLS',
    jpg: 'IMG',
    jpeg: 'IMG',
    png: 'IMG',
    zip: 'ZIP',
    rar: 'ZIP',
  };
  return map[ext] || 'FILE';
}

function setUploadBusy(isBusy, label) {
  els.uploadBtn.disabled = isBusy;
  els.uploadBtn.textContent = label;
}

function setStatus(message, type = 'info') {
  els.statusBanner.className = `status-banner ${type}`;
  els.statusBanner.textContent = message;
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(successMessage, 'success');
  } catch {
    const input = document.createElement('input');
    input.value = text;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    setStatus(successMessage, 'success');
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
