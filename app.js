// ─── InfinityPaste v5.0.0 — app.js ──────────────────────────────────────────────
// Phase 5: hOCR Table OCR, QR Code Reader, Multi-page Table Stitcher, Code Block Extractor, Receipt Parser
const STATE_VERSION = 4;
const DB_NAME = 'infinitypaste-db';
const DB_VERSION = 3;
let db = null;

// ─── IndexedDB Setup ──────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('recordings')) d.createObjectStore('recordings', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

function idbGet(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    const req = tx.objectStore('recordings').put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    const req = tx.objectStore('recordings').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbFilePut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const req = tx.objectStore('files').put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbFileGet(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbFileDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const req = tx.objectStore('files').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbFileGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── State ────────────────────────────────────────────────────────────────────
let queue = [];
let recordings = [];
let files = [];
let activeTab = 'queue';
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingTimer = null;
let recordingSeconds = 0;
let currentlyPlaying = null;
let settings = {
  openaiKey: '',
  openaiModel: 'gpt-4o',
  theme: 'auto',
  fontSize: 'medium',
  autoSave: true,
  showTimestamps: true,
  maxQueueItems: 100
};

function loadSettings() {
  try {
    const s = localStorage.getItem('infinitypaste-settings');
    if (s) settings = { ...settings, ...JSON.parse(s) };
  } catch {}
}

function saveSettings() {
  try { localStorage.setItem('infinitypaste-settings', JSON.stringify(settings)); } catch {}
}

function loadQueue() {
  try {
    const q = localStorage.getItem('infinitypaste-queue');
    if (q) queue = JSON.parse(q);
  } catch { queue = []; }
}

function saveQueue() {
  try { localStorage.setItem('infinitypaste-queue', JSON.stringify(queue)); } catch {}
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
}

// ─── Escape HTML ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Queue ────────────────────────────────────────────────────────────────────
function addToQueue(content, label = '', source = '') {
  const item = {
    id: Date.now() + Math.random(),
    content,
    label,
    source,
    timestamp: new Date().toISOString()
  };
  queue.unshift(item);
  if (queue.length > settings.maxQueueItems) queue = queue.slice(0, settings.maxQueueItems);
  saveQueue();
  renderQueue();
  return item;
}

function removeItem(id) {
  queue = queue.filter(i => i.id !== id);
  saveQueue();
  renderQueue();
}

function clearQueue() {
  if (!queue.length) return;
  if (!confirm('Clear all queue items?')) return;
  queue = [];
  saveQueue();
  renderQueue();
}

function copyItem(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  navigator.clipboard.writeText(item.content).then(() => showToast('Copied!')).catch(() => showToast('Copy failed', 'error'));
}

function renderQueue() {
  const el = document.getElementById('queue-list');
  if (!el) return;
  if (!queue.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>Queue is empty</p></div>';
    return;
  }
  el.innerHTML = queue.map(item => {
    const preview = item.content.length > 120 ? item.content.slice(0, 120) + '…' : item.content;
    const wordCount = item.content.trim().split(/\s+/).filter(Boolean).length;
    return `<div class="card" id="queue-item-${item.id}">
      <div class="card-meta">
        ${item.label ? `<span class="card-label">${escapeHtml(item.label)}</span>` : ''}
        ${item.source ? `<span class="card-source">${escapeHtml(item.source)}</span>` : ''}
        <span class="card-count">${wordCount}w</span>
        ${settings.showTimestamps ? `<span class="card-time">${new Date(item.timestamp).toLocaleTimeString()}</span>` : ''}
      </div>
      <div class="card-preview">${escapeHtml(preview)}</div>
      <div class="card-actions">
        <button class="card-btn card-btn--copy" onclick="copyItem(${item.id})" title="Copy">📋</button>
        <button class="card-btn" onclick="extractKeywordsFromQueueItem(${item.id})" title="Extract TF-IDF keywords">🔑</button>
        ${ item.content.trim().split(/\s+/).length >= 80 ? `<button class="card-btn" id="summarize-btn-${item.id}" onclick="localSummarizeQueueItem(${item.id})" title="Summarize locally">📋</button>` : '' }
        <button class="card-btn" id="cleanup-btn-${item.id}" onclick="cleanupQueueItem(${item.id})" title="Clean up text">✨</button>
        <button class="card-btn" id="lang-btn-${item.id}" onclick="detectLanguageOfItem(${item.id})" title="Detect language">🌐</button>
        <button class="card-btn card-btn--delete" onclick="removeItem(${item.id})">✕</button>
      </div>
      <div id="summarize-progress-${item.id}" style="display:none;font-size:0.75rem;color:var(--color-text-muted);padding:4px 0 0 0;"></div>
    </div>`;
  }).join('');
}

// ─── Clipboard Paste ──────────────────────────────────────────────────────────
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { showToast('Clipboard is empty', 'error'); return; }
    addToQueue(text, '', 'clipboard');
    switchTab('queue');
    showToast('Pasted from clipboard');
  } catch {
    showToast('Clipboard access denied', 'error');
  }
}

document.addEventListener('paste', e => {
  const text = e.clipboardData?.getData('text');
  if (text?.trim()) {
    addToQueue(text, '', 'paste');
    switchTab('queue');
    showToast('Pasted!');
  }
});

// ─── Text Input ───────────────────────────────────────────────────────────────
function submitText() {
  const el = document.getElementById('text-input');
  if (!el) return;
  const text = el.value.trim();
  if (!text) { showToast('Nothing to add', 'error'); return; }
  addToQueue(text, '', 'manual');
  el.value = '';
  switchTab('queue');
  showToast('Added to queue');
}

// ─── Recording ────────────────────────────────────────────────────────────────
async function startRecording() {
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.start(100);
    isRecording = true;
    recordingSeconds = 0;
    updateRecordingTimer();
    recordingTimer = setInterval(updateRecordingTimer, 1000);
    document.getElementById('rec-btn-start')?.setAttribute('disabled', '');
    document.getElementById('rec-btn-stop')?.removeAttribute('disabled');
    showToast('Recording started');
  } catch (e) {
    showToast('Microphone access denied', 'error');
  }
}

function updateRecordingTimer() {
  recordingSeconds++;
  const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
  const s = String(recordingSeconds % 60).padStart(2, '0');
  const el = document.getElementById('rec-timer');
  if (el) el.textContent = `${m}:${s}`;
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());
  isRecording = false;
  clearInterval(recordingTimer);
  document.getElementById('rec-btn-start')?.removeAttribute('disabled');
  document.getElementById('rec-btn-stop')?.setAttribute('disabled', '');
}

async function saveRecording() {
  const mimeType = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  const name = `Recording ${new Date().toLocaleString()}`;
  const id = Date.now();
  await idbPut({ id, name, blob, timestamp: new Date().toISOString(), duration: recordingSeconds });
  recordings = await idbGetAll();
  renderRecordings();
  showToast('Recording saved');
}

async function deleteRecording(id) {
  await idbDelete(id);
  recordings = await idbGetAll();
  renderRecordings();
  showToast('Recording deleted');
}

function playRecording(id) {
  const rec = recordings.find(r => r.id === id);
  if (!rec?.blob) return;
  if (currentlyPlaying) {
    currentlyPlaying.pause();
    currentlyPlaying = null;
  }
  const url = URL.createObjectURL(rec.blob);
  const audio = document.getElementById(`audio-${id}`);
  if (audio) {
    audio.src = url;
    audio.style.display = 'block';
    audio.play();
    currentlyPlaying = audio;
  }
}

async function transcribeRecording(id) {
  const btn = document.getElementById(`transcribe-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  showToast('Transcribing…');
  try {
    const rec = await idbGet(id);
    if (!rec?.blob) throw new Error('Recording not found');
    if (!settings.openaiKey) throw new Error('OpenAI API key required in Settings');
    const form = new FormData();
    form.append('file', rec.blob, 'audio.webm');
    form.append('model', 'whisper-1');
    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.openaiKey}` },
      body: form
    });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    const data = await resp.json();
    const text = data.text?.trim();
    if (!text) throw new Error('Empty transcript');
    addToQueue(text, 'transcript', rec.name);
    switchTab('queue');
    showToast('✓ Transcription complete');
  } catch (e) {
    showToast(e.message || 'Transcription failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📝'; }
  }
}

function renderRecordings() {
  const el = document.getElementById('recordings-list');
  if (!el) return;
  if (!recordings.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎙</div><p>No recordings yet</p></div>';
    return;
  }
  el.innerHTML = recordings.slice().reverse().map(rec => {
    const dur = rec.duration ? `${Math.floor(rec.duration/60)}:${String(rec.duration%60).padStart(2,'0')}` : '--:--';
    return `<div class="card">
      <div class="card-meta">
        <span class="card-label">${escapeHtml(rec.name)}</span>
        <span class="card-time">${dur}</span>
      </div>
      <div class="card-actions">
        <button class="card-btn" onclick="playRecording(${rec.id})" title="Play">▶️</button>
        <button class="card-btn card-btn--transcribe" onclick="transcribeRecording(${rec.id})" id="transcribe-btn-${rec.id}" title="Transcribe via OpenAI Whisper API">📝</button>
        <button class="card-btn card-btn--local" onclick="localTranscribeRecording(${rec.id})" id="local-transcribe-btn-${rec.id}" title="Transcribe locally (Whisper-tiny, ~75MB, no API key needed)">🧠</button>
        <button class="card-btn card-btn--delete" onclick="deleteRecording(${rec.id})">✕</button>
      </div>
      <div id="local-progress-${rec.id}" style="display:none;font-size:0.75rem;color:var(--color-text-muted);padding:4px 0 0 0;"></div>
      <audio id="audio-${rec.id}" style="display:none" controls></audio>`;
  }).join('');
}

// ─── Files ────────────────────────────────────────────────────────────────────
function isImageFile(file) {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(file.name) || (file.type && file.type.startsWith('image/'));
}

function isPdfFile(file) {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

async function handleFileUpload(input) {
  const fileList = input.files;
  if (!fileList?.length) return;
  for (const f of fileList) {
    const id = Date.now() + Math.random();
    const meta = { id, name: f.name, type: f.type, size: f.size, timestamp: new Date().toISOString() };
    await idbFilePut({ id, blob: f });
    files.push(meta);
  }
  renderFiles();
  showToast(`${fileList.length} file${fileList.length > 1 ? 's' : ''} uploaded`);
  input.value = '';
}

async function deleteFile(id) {
  await idbFileDelete(id);
  files = files.filter(f => f.id !== id);
  renderFiles();
  showToast('File deleted');
}

function renderFiles() {
  const el = document.getElementById('files-list');
  if (!el) return;
  if (!files.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📁</div><p>No files yet</p></div>';
    return;
  }
  el.innerHTML = files.map(file => {
    const canOcr = isImageFile(file);
    const isPdf = isPdfFile(file);
    const sizeKb = (file.size / 1024).toFixed(1);
    return `<div class="card" id="file-card-${file.id}">
      <div class="card-meta">
        <span class="card-label">${escapeHtml(file.name)}</span>
        <span class="card-source">${sizeKb}KB</span>
        ${settings.showTimestamps ? `<span class="card-time">${new Date(file.timestamp).toLocaleTimeString()}</span>` : ''}
      </div>
      <div class="card-actions">
        ${canOcr ? `<button class="card-btn" id="ocr-btn-${file.id}" onclick="ocrFile(${file.id})" title="OCR to text">🔍</button>` : ''}
        ${canOcr ? `<button class="card-btn" id="ocr-table-btn-${file.id}" onclick="ocrTableFromFile(${file.id})" title="Extract table (hOCR)">📊</button>` : ''}
        ${canOcr ? `<button class="card-btn" id="qr-btn-${file.id}" onclick="readQRFromFile(${file.id})" title="Read QR code">📷</button>` : ''}
        ${isPdf  ? `<button class="card-btn" id="pdf-btn-${file.id}" onclick="extractPdfToQueue(${file.id})" title="Extract PDF text">📄</button>` : ''}
        <button class="card-btn" id="code-btn-${file.id}" onclick="extractCodeFromFile(${file.id})" title="Extract code blocks">⌨️</button>
        <button class="card-btn" id="receipt-btn-${file.id}" onclick="parseReceiptFromFile(${file.id})" title="Parse receipt/invoice">🧾</button>
        <button class="card-btn" id="analyze-btn-${file.id}" onclick="analyzeFile(${file.id})" title="AI Analyze">🤖</button>
        <button class="card-btn" id="stitch-add-btn-${file.id}" onclick="addToStitchQueue(${file.id})" title="Add to table stitch queue">🧵</button>
        <button class="card-btn" onclick="ocrTableFromFile('${file.id}')" title="Extract table">📊</button>
        <button class="card-btn" onclick="readQRFromFile('${file.id}')" title="Read QR">📷</button>
        <button class="card-btn" onclick="extractCodeFromFile('${file.id}')" title="Extract code">⌨️</button>
        <button class="card-btn" onclick="parseReceiptFromFile('${file.id}')" title="Parse receipt">🧾</button>
        <button class="card-btn" onclick="addToStitchQueue('${file.id}')" title="Stitch queue">🧵</button>
        <button class="card-btn card-btn--delete" onclick="deleteFile(${file.id})">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ─── OCR ──────────────────────────────────────────────────────────────────────
let _tesseractWorker = null;

async function _getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  if (typeof Tesseract === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  _tesseractWorker = await Tesseract.createWorker('eng');
  return _tesseractWorker;
}

async function ocrFile(id) {
  const file = files.find(f => f.id == id);
  if (!file) return;
  const btn = document.getElementById(`ocr-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  showToast('Running OCR…');
  try {
    const stored = await idbFileGet(id);
    if (!stored?.blob) throw new Error('File data missing');
    const url = URL.createObjectURL(stored.blob);
    const worker = await _getTesseractWorker();
    const result = await worker.recognize(url);
    URL.revokeObjectURL(url);
    const text = result.data.text?.trim();
    if (!text) throw new Error('No text found');
    addToQueue(text, `ocr · ${file.name}`, 'Tesseract');
    switchTab('queue');
    showToast('✓ OCR complete');
  } catch (e) {
    showToast(e.message || 'OCR failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍'; }
  }
}

// ─── PDF ──────────────────────────────────────────────────────────────────────
async function extractPdfText(blob) {
  if (typeof pdfjsLib === 'undefined') {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs';
      s.type = 'module'; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const arrayBuffer = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text.trim();
}

async function extractPdfToQueue(id) {
  const file = files.find(f => f.id == id);
  if (!file) return;
  const btn = document.getElementById(`pdf-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  showToast('Extracting PDF…');
  try {
    const stored = await idbFileGet(id);
    if (!stored?.blob) throw new Error('File missing');
    const text = await extractPdfText(stored.blob);
    if (!text) throw new Error('No text found in PDF');
    addToQueue(text, `pdf · ${file.name}`, 'pdfjs');
    switchTab('queue');
    showToast('✓ PDF text extracted');
  } catch (e) {
    showToast(e.message || 'PDF extraction failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄'; }
  }
}

// ─── AI Analyze ───────────────────────────────────────────────────────────────
async function analyzeFile(id) {
  const file = files.find(f => f.id == id);
  if (!file) return;
  if (!settings.openaiKey) { showToast('OpenAI API key required in Settings', 'error'); return; }
  const btn = document.getElementById(`analyze-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  showToast('Analyzing…');
  try {
    const stored = await idbFileGet(id);
    if (!stored?.blob) throw new Error('File missing');
    let content = '';
    if (isImageFile(file)) {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(stored.blob);
      });
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiKey}` },
        body: JSON.stringify({
          model: settings.openaiModel,
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${stored.blob.type};base64,${base64}` } }, { type: 'text', text: 'Describe this image in detail.' }] }]
        })
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      const data = await resp.json();
      content = data.choices?.[0]?.message?.content?.trim();
    } else {
      const text = await stored.blob.text();
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiKey}` },
        body: JSON.stringify({
          model: settings.openaiModel,
          messages: [{ role: 'user', content: `Analyze this text:\n\n${text.slice(0, 4000)}` }]
        })
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      const data = await resp.json();
      content = data.choices?.[0]?.message?.content?.trim();
    }
    if (!content) throw new Error('Empty response');
    addToQueue(content, `analysis · ${file.name}`, 'GPT');
    switchTab('queue');
    showToast('✓ Analysis complete');
  } catch (e) {
    showToast(e.message || 'Analysis failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🤖'; }
  }
}

// ─── File Viewer ──────────────────────────────────────────────────────────────
async function viewFile(id) {
  const file = files.find(f => f.id == id);
  if (!file) return;
  const viewer = document.getElementById('file-viewer');
  const viewerContent = document.getElementById('file-viewer-content');
  const viewerTitle = document.getElementById('file-viewer-title');
  if (!viewer || !viewerContent) return;
  const stored = await idbFileGet(id);
  if (!stored?.blob) return;
  viewerTitle && (viewerTitle.textContent = file.name);
  if (isImageFile(file)) {
    const url = URL.createObjectURL(stored.blob);
    viewerContent.innerHTML = `<img src="${url}" alt="${escapeHtml(file.name)}" style="max-width:100%;border-radius:8px">`;
  } else {
    const text = await stored.blob.text();
    viewerContent.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-all;font-size:0.85rem">${escapeHtml(text.slice(0, 10000))}</pre>`;
  }
  viewer.style.display = 'block';
}

function closeViewer() {
  const viewer = document.getElementById('file-viewer');
  if (viewer) viewer.style.display = 'none';
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-modal').style.display = 'flex';
  document.getElementById('setting-key').value = settings.openaiKey || '';
  document.getElementById('setting-model').value = settings.openaiModel || 'gpt-4o';
  document.getElementById('setting-theme').value = settings.theme || 'auto';
  document.getElementById('setting-timestamps').checked = settings.showTimestamps !== false;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function saveSettingsFromForm() {
  settings.openaiKey = document.getElementById('setting-key')?.value?.trim() || '';
  settings.openaiModel = document.getElementById('setting-model')?.value?.trim() || 'gpt-4o';
  settings.theme = document.getElementById('setting-theme')?.value || 'auto';
  settings.showTimestamps = document.getElementById('setting-timestamps')?.checked ?? true;
  saveSettings();
  applyTheme(settings.theme);
  closeSettings();
  showToast('Settings saved');
}

function exportData() {
  const data = { queue, settings, exported: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `infinitypaste-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.queue) { queue = data.queue; saveQueue(); renderQueue(); }
      if (data.settings) { settings = { ...settings, ...data.settings }; saveSettings(); }
      showToast('✓ Import complete');
    } catch { showToast('Invalid export file', 'error'); }
  };
  reader.readAsText(file);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  loadSettings();
  loadQueue();
  applyTheme(settings.theme);
  await openDB();
  recordings = await idbGetAll();
  files = await idbFileGetAll();
  renderQueue();
  renderRecordings();
  renderFiles();
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

// ─── Phase 4: Local AI Tools ───────────────────────────────────────────────────
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
let _transformersLoaded = false, _whisperPipeline = null, _whisperLoading = false;

function _loadTransformers() {
  if (_transformersLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TRANSFORMERS_CDN; s.type = 'text/javascript';
    s.onload = () => { _transformersLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load Transformers.js.'));
    document.head.appendChild(s);
  });
}

async function _getWhisperPipeline(progressCb) {
  if (_whisperPipeline) return _whisperPipeline;
  if (_whisperLoading) throw new Error('Whisper is already loading — please wait…');
  _whisperLoading = true;
  await _loadTransformers();
  const { pipeline, env } = window.transformers || {};
  if (env) env.allowLocalModels = false;
  _whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { progress_callback: progressCb || null });
  _whisperLoading = false;
  return _whisperPipeline;
}

async function localTranscribeRecording(id) {
  const btn = document.getElementById(`local-transcribe-btn-${id}`);
  const progressEl = document.getElementById(`local-progress-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = 'Loading Whisper model (~75MB, cached after first use)…'; }
  showToast('Loading local Whisper model…');
  try {
    const rec = await idbGet(id);
    if (!rec?.blob) throw new Error('Recording not found');
    const progressCb = (p) => {
      if (!progressEl) return;
      if (p.status === 'downloading') progressEl.textContent = `Downloading model: ${Math.round(p.progress||0)}%`;
      else if (p.status === 'loading') progressEl.textContent = 'Loading model into memory…';
    };
    const whisper = await _getWhisperPipeline(progressCb);
    if (progressEl) progressEl.textContent = 'Transcribing…';
    const arrayBuffer = await rec.blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const float32 = decoded.getChannelData(0);
    audioCtx.close();
    const result = await whisper(float32, { language: 'english', task: 'transcribe' });
    const text = (result?.text || '').trim();
    if (!text) throw new Error('Empty transcript');
    addToQueue(text, 'local-transcript', rec.name);
    switchTab('queue');
    showToast('✓ Local transcription complete');
  } catch (e) {
    showToast(e.message || 'Local transcription failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧠'; }
    if (progressEl) progressEl.style.display = 'none';
  }
}

function extractKeywordsFromQueueItem(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  const keywords = _tfidfKeywords(item.content, 10);
  if (!keywords.length) { showToast('No keywords found', 'error'); return; }
  const result = `Keywords from: ${item.label || 'item'}\n\n${keywords.map((k,i) => `${i+1}. ${k.word} (score: ${k.score.toFixed(3)})`).join('\n')}`;
  addToQueue(result, `keywords · ${item.label || 'item'}`, 'tfidf');
  switchTab('queue');
  showToast(`✓ ${keywords.length} keywords extracted`);
}

function _tfidfKeywords(text, count = 10) {
  const sw = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','was','are','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','this','that','these','those','i','you','he','she','it','we','they','what','which','who','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','because','as','until','while','about','into','through','during','before','after','above','below','between','out','off','over','under','again','then','once','here','there','if','can','its','your','our','their','his','her','my','one','two','three','also','get','use','used','using','said','says','like','well','back','even','want','see','know','think','make','made','time','way','new','good','first','last','long','great','little','right','big','high','different','small','large','next','early','young','important','public','private','real','best','free','able']);
  const words = text.toLowerCase().replace(/https?:\/\/\S+/g,'').replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !sw.has(w) && !/^\d+$/.test(w));
  const freq = {};
  words.forEach(w => freq[w] = (freq[w]||0)+1);
  const total = words.length||1, unique = Object.keys(freq).length||1;
  return Object.entries(freq).map(([word,c]) => ({ word, score:(c/total)*Math.log(1+unique/c) })).sort((a,b)=>b.score-a.score).slice(0,count);
}

let _summarizePipeline = null, _summarizeLoading = false;

async function localSummarizeQueueItem(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  if (item.content.trim().split(/\s+/).length < 80) { showToast('Text too short to summarize', 'error'); return; }
  const btn = document.getElementById(`summarize-btn-${id}`);
  const progressEl = document.getElementById(`summarize-progress-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = 'Loading summarization model (~250MB, cached after first use)…'; }
  showToast('Loading local summarization model…');
  try {
    if (!_summarizePipeline) {
      if (_summarizeLoading) throw new Error('Model already loading — please wait…');
      _summarizeLoading = true;
      await _loadTransformers();
      const { pipeline, env } = window.transformers || {};
      if (env) env.allowLocalModels = false;
      _summarizePipeline = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6', {
        progress_callback: (p) => { if (progressEl && p.status==='downloading') progressEl.textContent = `Downloading: ${Math.round(p.progress||0)}%`; }
      });
      _summarizeLoading = false;
    }
    if (progressEl) progressEl.textContent = 'Summarizing…';
    const result = await _summarizePipeline(item.content.slice(0,4000), { max_length:150, min_length:30 });
    const summary = result?.[0]?.summary_text?.trim();
    if (!summary) throw new Error('Empty summary');
    addToQueue(summary, `summary · ${item.label||'item'}`, 'distilBART');
    switchTab('queue');
    showToast('✓ Summary added to queue');
  } catch(e) {
    _summarizeLoading = false;
    showToast(e.message||'Summarization failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='📋'; }
    if (progressEl) progressEl.style.display='none';
  }
}

const COMPROMISE_CDN = 'https://cdn.jsdelivr.net/npm/compromise@14.14.4/builds/compromise.min.js';
let _compromiseLoaded = false;

function _loadCompromise() {
  if (_compromiseLoaded) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const s = document.createElement('script');
    s.src = COMPROMISE_CDN;
    s.onload = () => { _compromiseLoaded=true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load compromise.js'));
    document.head.appendChild(s);
  });
}

async function cleanupQueueItem(id) {
  const item = queue.find(i => i.id===id);
  if (!item) return;
  const btn = document.getElementById(`cleanup-btn-${id}`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast('Cleaning up text…');
  try {
    await _loadCompromise();
    const nlp = window.nlp;
    if (!nlp) throw new Error('compromise.js not available');
    let text = item.content.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    text = text.replace(/([a-z])([A-Z])/g,'$1 $2');
    const doc = nlp(text);
    doc.contractions().expand();
    let cleaned = doc.text();
    cleaned = cleaned.replace(/\bl\b(?=\s+[a-z])/g,'I').replace(/\s+([.,!?;:])/g,'$1').replace(/([.,!?;:])(?=[a-zA-Z])/g,'$1 ').replace(/\n[ \t]+/g,'\n').trim();
    addToQueue(cleaned, `cleaned · ${item.label||'item'}`, 'compromise');
    switchTab('queue');
    showToast('✓ Cleaned text added to queue');
  } catch(e) {
    showToast(e.message||'Cleanup failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='✨'; }
  }
}

function _detectLangInline(text) {
  const t = text.toLowerCase().slice(0, 500);
  const patterns = [
    ['ja', /[\u3040-\u30ff]/],
    ['zh', /[\u4e00-\u9fff]/],
    ['ru', /[\u0400-\u04ff]/],
    ['de', /\b(der|die|das|und|ist|nicht|mit|auf|ein)\b/],
    ['fr', /\b(le|la|les|est|une|dans|pour|avec|qui)\b/],
    ['es', /\b(el|la|los|las|es|con|para|una|por)\b/],
    ['pt', /\b(o|a|os|as|em|um|uma|para|com)\b/],
    ['it', /\b(il|la|i|le|un|una|con|per|che)\b/],
    ['nl', /\b(de|het|een|van|in|op|met|voor|niet)\b/],
    ['en', /\b(the|and|is|in|to|of|that|it|for)\b/],
  ];
  for (const [lang, re] of patterns) if (re.test(t)) return lang;
  return 'en';
}
function detectLanguageOfItem(id) {
  const item = queue.find(i => i.id === id);
  if (!item) return;
  const lang = _detectLangInline(item.content);
  item.label = (item.label ? item.label + ' · ' : '') + lang;
  saveQueue(); renderQueue();
  showToast('Detected: ' + lang);
}
function detectAllLanguages() {
  if (!queue.length) { showToast('Queue is empty', 'error'); return; }
  queue.forEach(item => {
    const lang = _detectLangInline(item.content);
    if (!item.label || !item.label.includes(lang))
      item.label = (item.label ? item.label + ' · ' : '') + lang;
  });
  saveQueue(); renderQueue();
  showToast('Tagged ' + queue.length + ' items');
}

// ─── Phase 5: Advanced Local Extraction Tools ─────────────────────────────────

// ─── Feature 14: hOCR Table OCR ───────────────────────────────────────────────
async function ocrTableFromFile(fileId) {
  const file = files.find(f => f.id == fileId);
  if (!file) return;
  const btn = document.getElementById(`ocr-table-btn-${fileId}`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast('Running hOCR table detection…');
  try {
    const stored = await idbFileGet(fileId);
    if (!stored?.blob) throw new Error('Image data missing — please re-upload the file');
    const objectUrl = URL.createObjectURL(stored.blob);
    const worker = await _getTesseractWorker();
    const result = await worker.recognize(objectUrl, {}, { hocr: true });
    URL.revokeObjectURL(objectUrl);
    const hocr = result.data.hocr;
    if (!hocr) throw new Error('No hOCR data returned');
    const table = _hocrToMarkdownTable(hocr);
    if (!table) throw new Error('No table structure detected in image');
    addToQueue(table, `table · ${file.name}`, 'hOCR');
    switchTab('queue');
    showToast('✓ Table extracted and added to queue');
  } catch(e) {
    showToast(e.message||'hOCR table extraction failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='📊'; }
  }
}

function _hocrToMarkdownTable(hocr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(hocr, 'text/html');
  const words = [];
  doc.querySelectorAll('.ocrx_word').forEach(el => {
    const bbox = el.getAttribute('title')?.match(/bbox (\d+) (\d+) (\d+) (\d+)/);
    if (!bbox) return;
    words.push({
      text: el.textContent.trim(),
      x1: parseInt(bbox[1]), y1: parseInt(bbox[2]),
      x2: parseInt(bbox[3]), y2: parseInt(bbox[4]),
      cx: (parseInt(bbox[1])+parseInt(bbox[3]))/2,
      cy: (parseInt(bbox[2])+parseInt(bbox[4]))/2,
    });
  });
  if (words.length < 4) return null;
  const ROW_THRESHOLD = 14;
  const rows = [];
  words.forEach(w => {
    const row = rows.find(r => Math.abs(r.cy - w.cy) < ROW_THRESHOLD);
    if (row) { row.words.push(w); row.cy = (row.cy + w.cy) / 2; }
    else rows.push({ cy: w.cy, words: [w] });
  });
  rows.sort((a,b) => a.cy - b.cy);
  if (rows.length < 2) return null;
  rows.forEach(r => r.words.sort((a,b) => a.cx - b.cx));
  const COL_THRESHOLD = 40;
  const allCx = rows.flatMap(r => r.words.map(w => w.cx)).sort((a,b)=>a-b);
  const cols = [];
  allCx.forEach(cx => { const col = cols.find(c => Math.abs(c-cx) < COL_THRESHOLD); if (!col) cols.push(cx); });
  cols.sort((a,b)=>a-b);
  if (cols.length < 2) return null;
  const grid = rows.map(row => {
    const cells = Array(cols.length).fill('');
    row.words.forEach(w => {
      const ci = cols.reduce((best,c,i) => Math.abs(c-w.cx) < Math.abs(cols[best]-w.cx) ? i : best, 0);
      cells[ci] = cells[ci] ? cells[ci]+' '+w.text : w.text;
    });
    return cells;
  });
  const header = `| ${grid[0].join(' | ')} |`;
  const divider = `| ${grid[0].map(()=>'---').join(' | ')} |`;
  const body = grid.slice(1).map(r => `| ${r.join(' | ')} |`).join('\n');
  return `${header}\n${divider}\n${body}`;
}

// ─── Feature 15: Multi-Page Table Stitcher ────────────────────────────────────
let _stitchFiles = [];

function addToStitchQueue(fileId) {
  const file = files.find(f => f.id == fileId);
  if (!file) return;
  if (_stitchFiles.find(f => f.id == fileId)) { showToast('Already in stitch queue','error'); return; }
  _stitchFiles.push(file);
  renderStitchQueue();
  showToast(`✓ Added to stitch queue (${_stitchFiles.length} image${_stitchFiles.length!==1?'s':''})`);
}

function removeFromStitchQueue(fileId) {
  _stitchFiles = _stitchFiles.filter(f => f.id != fileId);
  renderStitchQueue();
}

function renderStitchQueue() {
  const el = document.getElementById('stitch-queue-list');
  const area = document.getElementById('stitch-area');
  if (!el || !area) return;
  area.style.display = _stitchFiles.length ? 'block' : 'none';
  el.innerHTML = _stitchFiles.map(f =>
    `<span class="stitch-item">${escapeHtml(f.name)} <button onclick="removeFromStitchQueue(${f.id})">✕</button></span>`
  ).join('');
}

async function stitchTables() {
  if (_stitchFiles.length < 2) { showToast('Add at least 2 images to stitch','error'); return; }
  const btn = document.getElementById('stitch-btn');
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast(`Stitching ${_stitchFiles.length} tables…`);
  try {
    const worker = await _getTesseractWorker();
    const allTables = [];
    for (const file of _stitchFiles) {
      const stored = await idbFileGet(file.id);
      if (!stored?.blob) throw new Error(`Missing data for ${file.name}`);
      const url = URL.createObjectURL(stored.blob);
      const result = await worker.recognize(url, {}, { hocr: true });
      URL.revokeObjectURL(url);
      const table = _hocrToMarkdownTable(result.data.hocr);
      if (table) allTables.push({ name: file.name, table });
    }
    if (!allTables.length) throw new Error('No tables detected in any image');
    const parsed = allTables.map(t => {
      const lines = t.table.split('\n').filter(l => l.startsWith('|'));
      return { name: t.name, header: lines[0], divider: lines[1], rows: lines.slice(2), cols: lines[0].split('|').filter(c => c.trim()) };
    });
    const base = parsed[0];
    const merged = [base.header, base.divider, ...base.rows];
    for (let i = 1; i < parsed.length; i++) {
      parsed[i].rows.forEach(row => {
        const isDupe = merged.some(existing => _stringSimilarity(existing.toLowerCase(), row.toLowerCase()) > 0.85);
        if (!isDupe) merged.push(row);
      });
    }
    const label = `stitched table · ${_stitchFiles.map(f=>f.name).join(' + ')}`;
    addToQueue(merged.join('\n'), label, 'table-stitcher');
    _stitchFiles = []; renderStitchQueue(); switchTab('queue');
    showToast('✓ Tables stitched and added to queue');
  } catch(e) {
    showToast(e.message||'Stitch failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='🧵 Stitch Tables'; }
  }
}

function _stringSimilarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (!longer.length) return 1.0;
  return (longer.length - _levenshtein(longer, shorter)) / longer.length;
}

function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i===0?j:j===0?i:0));
  for (let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

// ─── Feature 16: QR Code Reader ───────────────────────────────────────────────
const JSQR_CDN = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
let _jsqrLoaded = false;

function _loadJsQR() {
  if (_jsqrLoaded) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const s = document.createElement('script');
    s.src = JSQR_CDN;
    s.onload = () => { _jsqrLoaded=true; resolve(); };
    s.onerror = () => reject(new Error('Failed to load jsQR'));
    document.head.appendChild(s);
  });
}

async function readQRFromFile(fileId) {
  const file = files.find(f => f.id==fileId);
  if (!file) return;
  const btn = document.getElementById(`qr-btn-${fileId}`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast('Scanning for QR code…');
  try {
    await _loadJsQR();
    const stored = await idbFileGet(fileId);
    if (!stored?.blob) throw new Error('Image data missing');
    const url = URL.createObjectURL(stored.blob);
    const img = await _loadImageEl(url);
    URL.revokeObjectURL(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img,0,0);
    const imageData = ctx.getImageData(0,0,canvas.width,canvas.height);
    const code = window.jsQR(imageData.data, imageData.width, imageData.height);
    if (!code) throw new Error('No QR code found in image');
    addToQueue(code.data, `QR · ${file.name}`, 'jsQR');
    switchTab('queue');
    showToast(`✓ QR decoded: ${code.data.slice(0,40)}${code.data.length>40?'…':''}`);
  } catch(e) {
    showToast(e.message||'QR scan failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='📷'; }
  }
}

function _loadImageEl(src) {
  return new Promise((resolve,reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

// ─── Feature 17: Code Block Extractor ─────────────────────────────────────────
async function extractCodeFromFile(fileId) {
  const file = files.find(f => f.id==fileId);
  if (!file) return;
  const btn = document.getElementById(`code-btn-${fileId}`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast('Extracting code blocks…');
  try {
    const stored = await idbFileGet(fileId);
    if (!stored?.blob) throw new Error('File data missing');
    let text = '';
    if (isImageFile({name:file.name,type:stored.blob.type})) {
      const worker = await _getTesseractWorker();
      const url = URL.createObjectURL(stored.blob);
      const result = await worker.recognize(url);
      URL.revokeObjectURL(url);
      text = result.data.text?.trim();
    } else {
      text = await stored.blob.text();
    }
    if (!text) throw new Error('No text content found');
    const blocks = _extractCodeBlocks(text);
    if (!blocks.length) throw new Error('No code blocks detected');
    const output = blocks.map(b => '```'+b.lang+'\n'+b.code+'\n```').join('\n\n');
    addToQueue(output, `code · ${file.name}`, 'code-extractor');
    switchTab('queue');
    showToast(`✓ ${blocks.length} code block${blocks.length!==1?'s':''} extracted`);
  } catch(e) {
    showToast(e.message||'Code extraction failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='⌨️'; }
  }
}

function _extractCodeBlocks(text) {
  const blocks = [];
  const fenced = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  if (fenced.length) { fenced.forEach(m => blocks.push({ lang: m[1]||_detectCodeLang(m[2]), code: m[2].trim() })); return blocks; }
  const lines = text.split('\n');
  let currentBlock = [], inBlock = false;
  lines.forEach(line => {
    const isCode = /^(\t| {4,})/.test(line) || /^[\s]*(function|const|let|var|if|for|while|return|import|export|def |class |public |private |<\?php|\$[A-Za-z])/.test(line);
    if (isCode) { inBlock=true; currentBlock.push(line); }
    else if (inBlock && line.trim()==='') { currentBlock.push(''); }
    else if (inBlock) {
      if (currentBlock.filter(l=>l.trim()).length >= 3) blocks.push({ lang: _detectCodeLang(currentBlock.join('\n').trim()), code: currentBlock.join('\n').trim() });
      currentBlock=[]; inBlock=false;
    }
  });
  if (inBlock && currentBlock.filter(l=>l.trim()).length >= 3) blocks.push({ lang: _detectCodeLang(currentBlock.join('\n').trim()), code: currentBlock.join('\n').trim() });
  return blocks;
}

function _detectCodeLang(code) {
  if (/import\s+\w|from\s+['"]|def\s+\w+\(|print\(/.test(code)) return 'python';
  if (/function\s+\w+\(|const\s+\w+\s*=|let\s+\w+|=>\s*{|require\(/.test(code)) return 'javascript';
  if (/<\?php|\$[A-Z]/.test(code)) return 'php';
  if (/fun\s+\w+\(|val\s+\w+/.test(code)) return 'kotlin';
  if (/func\s+\w+\(|guard\s+let/.test(code)) return 'swift';
  if (/#include|int main\(|printf\(/.test(code)) return 'c';
  if (/<[a-z]+[\s>]|<\/[a-z]+>/.test(code)) return 'html';
  if (/SELECT|INSERT|UPDATE|DELETE|FROM|WHERE/i.test(code)) return 'sql';
  return '';
}

// ─── Feature 18: Receipt & Invoice Parser ─────────────────────────────────────
async function parseReceiptFromFile(fileId) {
  const file = files.find(f => f.id==fileId);
  if (!file) return;
  const btn = document.getElementById(`receipt-btn-${fileId}`);
  if (btn) { btn.disabled=true; btn.textContent='⏳'; }
  showToast('Parsing receipt…');
  try {
    const stored = await idbFileGet(fileId);
    if (!stored?.blob) throw new Error('File data missing');
    let text = '';
    if (isImageFile({name:file.name,type:stored.blob.type})) {
      const worker = await _getTesseractWorker();
      const url = URL.createObjectURL(stored.blob);
      const result = await worker.recognize(url);
      URL.revokeObjectURL(url);
      text = result.data.text?.trim();
    } else if (isPdfFile({name:file.name,type:stored.blob.type})) {
      text = await extractPdfText(stored.blob);
    } else {
      text = await stored.blob.text();
    }
    if (!text) throw new Error('No text extracted');
    const parsed = _parseReceiptText(text);
    addToQueue(_formatReceiptRecord(parsed, file.name), `receipt · ${parsed.vendor||file.name}`, 'receipt-parser');
    switchTab('queue');
    showToast('✓ Receipt parsed and added to queue');
  } catch(e) {
    showToast(e.message||'Receipt parse failed','error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='🧾'; }
  }
}

function _parseReceiptText(text) {
  const lines = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const result = { vendor:'', date:'', total:'', subtotal:'', tax:'', items:[] };
  for (const line of lines.slice(0,5)) {
    if (!/^\d|^\$|^total|^date/i.test(line) && line.length > 2) { result.vendor=line; break; }
  }
  const dateM = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})\b/i);
  if (dateM) result.date = dateM[0];
  const totalM = text.match(/total[:\s]+\$?([\d,]+\.\d{2})/i);
  if (totalM) result.total = totalM[1];
  const subM = text.match(/sub.?total[:\s]+\$?([\d,]+\.\d{2})/i);
  if (subM) result.subtotal = subM[1];
  const taxM = text.match(/tax[:\s]+\$?([\d,]+\.\d{2})/i);
  if (taxM) result.tax = taxM[1];
  const itemRe = /^(.+?)\s+\$?([\d,]+\.\d{2})$/;
  lines.forEach(line => {
    if (/total|subtotal|tax|tip|change|cash|card|balance/i.test(line)) return;
    const m = line.match(itemRe);
    if (m && m[1].length > 1 && m[1].length < 60) result.items.push({ name:m[1].trim(), amount:m[2] });
  });
  return result;
}

function _formatReceiptRecord(r, filename) {
  const lines = [`# Receipt — ${r.vendor||filename}`, ''];
  if (r.date)     lines.push(`**Date:** ${r.date}`);
  if (r.vendor)   lines.push(`**Vendor:** ${r.vendor}`);
  if (r.subtotal) lines.push(`**Subtotal:** $${r.subtotal}`);
  if (r.tax)      lines.push(`**Tax:** $${r.tax}`);
  if (r.total)    lines.push(`**Total:** $${r.total}`);
  if (r.items.length) { lines.push('', '## Line Items', ''); r.items.forEach(item => lines.push(`- ${item.name}: $${item.amount}`)); }
  return lines.join('\n');
}
