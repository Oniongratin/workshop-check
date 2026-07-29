import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';

const ITEMS = [
  { id: 'f1_ac', name: '1층 에어컨', icon: '▱' },
  { id: 'f1_in', name: '1층 실내조명', icon: '◉' },
  { id: 'f1_out', name: '1층 실외조명', icon: '◌' },
  { id: 'f1_lock', name: '1층 문잠금', icon: '▣' },
  { id: 'f2_ac', name: '2층 에어컨', icon: '▱' },
  { id: 'f2_in', name: '2층 실내조명', icon: '◉' },
  { id: 'f2_lock', name: '2층 문잠금', icon: '▣' }
];

const KEY = 'changsinCheckMe_v13';
const LEGACY_KEYS = ['changsinCheckMe_v12', 'changsinCheckMe_v11', 'changsinCheckMe_v10'];
const DEFAULT = {
  current: null,
  history: [],
  settings: { workshop: null, radius: 10, breakMinutes: 30, breakUntil: null, historyMode: 'list', recoveryCode: '' },
  view: 'checkView'
};

let state = load();
let activeItem = null;
let coords = null;
let lastAlert = 0;
let outsideHits = 0;
let fb = null;
let photoBusy = false;
let shareBusy = false;
let calendarCursor = new Date();

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];

function newSession() {
  return { id: `s_${Date.now()}`, startedAt: new Date().toISOString(), items: {}, completedAt: '' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function load() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!parsed) {
      for (const key of LEGACY_KEYS) {
        const legacy = JSON.parse(localStorage.getItem(key) || 'null');
        if (legacy) {
          parsed = legacy;
          break;
        }
      }
    }
  } catch (error) {
    console.warn('저장 데이터 읽기 실패', error);
  }

  const merged = {
    ...clone(DEFAULT),
    ...(parsed || {}),
    settings: { ...DEFAULT.settings, ...(parsed?.settings || {}) }
  };

  if (!merged.settings.recoveryCode) merged.settings.recoveryCode = generateRecoveryCode();

  // 이전 버전의 base64 사진은 localStorage 용량을 터뜨리는 핵심 원인이므로 제거한다.
  const sessions = [merged.current, ...(merged.history || [])].filter(Boolean);
  for (const session of sessions) {
    for (const item of Object.values(session.items || {})) {
      if (item && typeof item === 'object') delete item.image;
    }
  }
  return merged;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error('상태 저장 실패', error);
    toast('저장 공간이 부족합니다. 기록을 정리해 주세요.');
    return false;
  }
}

if (!state.current) state.current = newSession();
save();

// 사진은 localStorage가 아니라 IndexedDB에 저장한다. 7번째 사진에서 멈추던 문제의 핵심 수정.
const PHOTO_DB = 'changsin-checkme-photos-v1';
const PHOTO_STORE = 'photos';
let photoDbPromise = null;

function openPhotoDb() {
  if (photoDbPromise) return photoDbPromise;
  photoDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) db.createObjectStore(PHOTO_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('사진 저장소를 열 수 없습니다.'));
  });
  return photoDbPromise;
}

function photoKey(sessionId, itemId) {
  return `${sessionId}:${itemId}`;
}

async function putPhoto(sessionId, itemId, blob) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).put(blob, photoKey(sessionId, itemId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('사진 저장 실패'));
    tx.onabort = () => reject(tx.error || new Error('사진 저장 중단'));
  });
}

async function getPhoto(sessionId, itemId) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const request = tx.objectStore(PHOTO_STORE).get(photoKey(sessionId, itemId));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('사진 불러오기 실패'));
  });
}

async function deleteSessionPhotos(sessionId) {
  const db = await openPhotoDb();
  await Promise.all(ITEMS.map(item => new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).delete(photoKey(sessionId, item.id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('사진 삭제 실패'));
  })));
}

async function renderPublic() {
  const id = new URLSearchParams(location.search).get('share');
  if (!id) return false;
  document.body.innerHTML = '<div class="loading-card">기록을 불러오는 중...</div>';
  try {
    const { db } = await services();
    const snap = await getDoc(doc(db, 'checks', id));
    if (!snap.exists()) throw new Error('기록 없음');
    const data = snap.data();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    document.body.innerHTML = `<main class="public-wrap">
      <header class="top"><div class="brand"><div class="mark"><img src="logo-original.png" alt="창신체크미 로고"></div><div class="title"><h1>창신체크미 점검 기록</h1><p>${formatDateTime(data.completedAt)} 완료</p></div></div></header>
      <section class="card"><h3>퇴실 점검 완료</h3><p>총 ${photos.length}개 항목 · 진행률 ${data.progress || 100}%</p></section>
      ${photos.map(photo => `<section class="public-photo"><h3>✓ ${escapeHtml(photo.title)}</h3>${photo.note ? `<div style="background:#fff;color:#000;border-radius:14px;padding:11px 14px;margin:10px 0;font-size:13px;font-weight:650;white-space:pre-wrap">${escapeHtml(photo.note)}</div>` : ''}<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.title)}" loading="lazy"><div class="public-meta">촬영 ${formatDateTime(photo.timestamp)}</div></section>`).join('')}
    </main>`;
  } catch (error) {
    console.error(error);
    document.body.innerHTML = '<div class="loading-card">기록을 불러오지 못했습니다.<br>공유 링크 또는 Firebase 규칙을 확인해 주세요.</div>';
  }
  return true;
}

async function start() {
  if (await renderPublic()) return;
  setup();
  render();
  watchLocation();
  handleShortcutLaunch();
  syncCloudHistory({ silent: true }).catch(error => console.warn('클라우드 기록 동기화 실패', error));
}

start().catch(error => {
  console.error(error);
  document.body.innerHTML = '<div class="loading-card">앱을 시작하지 못했습니다. 새로고침해 주세요.</div>';
});

function setup() {
  $('cameraInput').addEventListener('change', onPhoto);
  $('breakBtn').addEventListener('click', toggleBreak);
  $('shareBtn').addEventListener('click', () => shareSession(state.current, $('shareBtn')));
  $('homeResetBtn').addEventListener('click', resetCurrentSession);
  $('quickSettings').addEventListener('click', () => switchView(state.view === 'settingsView' ? 'checkView' : 'settingsView'));
  $('saveWorkshopBtn').addEventListener('click', saveWorkshop);
  $('clearWorkshopBtn').addEventListener('click', () => {
    state.settings.workshop = null;
    save();
    render();
  });
  $('radiusInput').addEventListener('change', event => {
    state.settings.radius = Math.max(10, Math.min(500, Number(event.target.value) || 10));
    save();
  });
  $('breakSelect').addEventListener('change', event => {
    state.settings.breakMinutes = Number(event.target.value);
    save();
  });
  $('copyShortcutUrlBtn').addEventListener('click', copyShortcutUrl);
  $('testFirebaseBtn').addEventListener('click', testFirebase);
  $('copyRecoveryCodeBtn').addEventListener('click', copyRecoveryCode);
  $('restoreRecoveryBtn').addEventListener('click', restoreRecoveryCode);
  $('syncCloudBtn').addEventListener('click', () => syncCloudHistory({ silent: false }));
  $('newSessionBtn').addEventListener('click', resetCurrentSession);
  $('listModeBtn').addEventListener('click', () => setHistoryMode('list'));
  $('calendarModeBtn').addEventListener('click', () => setHistoryMode('calendar'));
  $$('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('completeClose').addEventListener('click', () => {
    $('completeScreen').classList.remove('show');
    switchView('checkView');
  });
  $('completeHistory').addEventListener('click', () => {
    $('completeScreen').classList.remove('show');
    switchView('historyView');
  });
}

async function resetCurrentSession() {
  const current = state.current;
  const hasProgress = Object.keys(current?.items || {}).length > 0;
  const isCompleted = Boolean(current?.completedAt);

  // 완료된 점검은 history와 같은 session id의 사진을 함께 사용한다.
  // 따라서 새 점검을 시작할 때 완료 기록의 사진은 절대 삭제하지 않는다.
  if (!isCompleted && hasProgress) {
    const ok = confirm('현재 진행 중인 점검만 초기화할까요?\n완료된 날짜별 기록과 사진은 삭제되지 않습니다.');
    if (!ok) return;
  }

  const abandonedDraftId = !isCompleted ? current?.id : null;
  state.current = newSession();
  save();

  // 아직 완료하지 않은 임시 촬영분만 정리한다. 완료 기록 사진은 건드리지 않는다.
  if (abandonedDraftId) {
    try { await deleteSessionPhotos(abandonedDraftId); } catch (error) { console.warn('임시 사진 정리 실패', error); }
  }

  render();
  switchView('checkView');
  toast('새 점검을 시작합니다 · 기존 기록은 보존됨');
}

function switchView(id) {
  state.view = id;
  save();
  $$('.view').forEach(view => view.classList.toggle('active', view.id === id));
  $$('.tab').forEach(button => button.classList.toggle('active', button.dataset.view === id));
  $('quickSettings').setAttribute('aria-label', id === 'settingsView' ? '홈으로 돌아가기' : '설정 열기');
}

function render() {
  renderProgress();
  renderItems();
  renderHistory();
  renderHistoryMode();
  renderSettings();
  switchView(state.view || 'checkView');
}

function renderProgress() {
  const count = Object.keys(state.current.items).length;
  const progress = Math.round(count / ITEMS.length * 100);
  $('percent').textContent = progress;
  $('countText').textContent = `${count} / ${ITEMS.length} 완료`;
  $('progressFill').style.width = `${progress}%`;
  $('statusText').textContent = state.current.completedAt ? '완료' : isBreak() ? '잠시 외출 중' : '점검 중';
  $('breakBtn').textContent = isBreak() ? '외출 해제' : '잠시 외출';
  $('shareBtn').textContent = state.current.shareUrl ? '공유창 열기' : '공유하기';
}

function renderItems() {
  $('itemList').innerHTML = ITEMS.map(item => {
    const photo = state.current.items[item.id];
    return `<button class="item ${photo ? 'done' : ''}" data-id="${item.id}" ${photoBusy ? 'disabled' : ''}>
      <span class="item-icon">${item.icon}</span>
      <span class="item-main"><span class="item-name">${item.name}</span><span class="item-meta">${photo ? `${formatTime(photo.timestamp)} 촬영` : '탭하여 촬영'}</span></span>
      <span class="state">${photo ? '✓' : ''}</span>
    </button>`;
  }).join('');

  $$('[data-id]').forEach(button => button.addEventListener('click', () => {
    if (photoBusy) return;
    if (state.current.completedAt) return toast('새 점검을 시작해 주세요');
    activeItem = button.dataset.id;
    $('cameraInput').value = '';
    $('cameraInput').click();
  }));
}

async function onPhoto() {
  const file = $('cameraInput').files?.[0];
  const selectedItemId = activeItem;
  activeItem = null;
  if (!file || !selectedItemId || photoBusy) return;

  photoBusy = true;
  renderItems();
  toast('사진 처리 중…');

  try {
    const blob = await compressToBlob(file);
    const item = ITEMS.find(entry => entry.id === selectedItemId);
    if (!item) throw new Error('항목을 찾을 수 없습니다.');

    await putPhoto(state.current.id, selectedItemId, blob);
    state.current.items[selectedItemId] = {
      title: item.name,
      timestamp: new Date().toISOString(),
      size: blob.size
    };

    if (!save()) throw new Error('점검 상태 저장 실패');

    navigator.vibrate?.([70, 30, 70]);
    const count = Object.keys(state.current.items).length;
    const progress = Math.round(count / ITEMS.length * 100);

    if (count === ITEMS.length && !state.current.completedAt) complete();
    render();
    toast(`${progress}% 완료`);
  } catch (error) {
    console.error(error);
    toast(`사진 저장 실패 · ${error.message || '다시 촬영해 주세요'}`);
  } finally {
    photoBusy = false;
    renderItems();
  }
}

function complete() {
  state.current.completedAt = new Date().toISOString();
  const existing = state.history.findIndex(record => record.id === state.current.id);
  if (existing >= 0) state.history.splice(existing, 1);
  state.history.unshift(clone(state.current));
  // 날짜별 완료 기록은 핵심 자료이므로 개수 제한 없이 보존한다.
  save();
  navigator.vibrate?.([100, 50, 100, 50, 160]);
  $('completeScreen').classList.add('show');
  backupSession(state.current).then(() => toast('점검 기록이 자동 백업되었습니다')).catch(error => {
    console.warn('자동 백업 실패', error);
    toast('기록은 기기에 저장됨 · 클라우드 백업은 재시도됩니다');
  });
}

function setHistoryMode(mode) {
  state.settings.historyMode = mode === 'calendar' ? 'calendar' : 'list';
  save();
  renderHistoryMode();
}

function renderHistoryMode() {
  const mode = state.settings.historyMode === 'calendar' ? 'calendar' : 'list';
  $('historyList').classList.toggle('hidden', mode !== 'list');
  $('historyCalendar').classList.toggle('hidden', mode !== 'calendar');
  $('listModeBtn').classList.toggle('active', mode === 'list');
  $('calendarModeBtn').classList.toggle('active', mode === 'calendar');
  if (mode === 'calendar') renderCalendar();
}

function renderHistory() {
  if (!state.history.length) {
    $('historyList').innerHTML = '<div class="card"><p>아직 완료 기록이 없습니다.</p></div>';
    renderCalendar();
    return;
  }
  $('historyList').innerHTML = state.history.map(record => `<article class="card history-card">
    <button class="record-delete" type="button" data-delete-record="${record.id}" aria-label="이 기록 삭제"><svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 2L10 10M10 2L2 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    <h3>${new Date(record.completedAt).toLocaleDateString('ko-KR')}</h3>
    <p>${formatTime(record.completedAt)} · ${Object.keys(record.items || {}).length}개 완료${countNotes(record) ? ` · 메모 ${countNotes(record)}개` : ''}</p>
    <div class="card-actions"><button class="small-btn" data-view-record="${record.id}">사진 보기</button><button class="small-btn white" data-share-record="${record.id}">공유</button></div>
  </article>`).join('');

  $$('[data-view-record]').forEach(button => button.onclick = () => showRecord(button.dataset.viewRecord));
  $$('[data-share-record]').forEach(button => button.onclick = () => {
    const record = state.history.find(entry => entry.id === button.dataset.shareRecord);
    shareSession(record, button);
  });
  $$('[data-delete-record]').forEach(button => button.onclick = () => deleteHistoryRecord(button.dataset.deleteRecord, button));
  renderCalendar();
}

function countNotes(record) {
  return Object.values(record.items || {}).filter(item => item?.note?.trim()).length;
}

function dateKey(value) {
  const date = new Date(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function renderCalendar() {
  const root = $('historyCalendar');
  if (!root) return;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  const byDay = new Map();
  for (const record of state.history) {
    if (!record.completedAt) continue;
    const key = dateKey(record.completedAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(record);
  }
  const today = dateKey(new Date());
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const key = dateKey(day);
    const records = byDay.get(key) || [];
    const latest = records[0];
    const classes = ['calendar-day'];
    if (day.getMonth() !== month) classes.push('other');
    if (key === today) classes.push('today');
    if (latest) classes.push('has-record');
    cells.push(`<button class="${classes.join(' ')}" type="button" ${latest ? `data-calendar-record="${latest.id}"` : 'disabled'} aria-label="${day.toLocaleDateString('ko-KR')}${latest ? ' 점검 기록 있음' : ''}"><span>${day.getDate()}</span>${latest ? '<span class="calendar-check">✓</span>' : ''}</button>`);
  }
  const recordsThisMonth = state.history.filter(record => {
    const d = new Date(record.completedAt);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
  root.innerHTML = `<div class="calendar-wrap"><div class="calendar-head"><button id="prevMonth" class="month-nav" type="button" aria-label="이전 달">‹</button><div class="month-label">${year}년 ${month + 1}월</div><button id="nextMonth" class="month-nav" type="button" aria-label="다음 달">›</button></div><div class="week-row"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div><div class="calendar-grid">${cells.join('')}</div>${recordsThisMonth ? '' : '<div class="empty-month">이 달에는 완료 기록이 없습니다.</div>'}</div>`;
  $('prevMonth').onclick = () => { calendarCursor = new Date(year, month - 1, 1); renderCalendar(); };
  $('nextMonth').onclick = () => { calendarCursor = new Date(year, month + 1, 1); renderCalendar(); };
  $$('[data-calendar-record]').forEach(button => button.onclick = () => showRecord(button.dataset.calendarRecord));
}

async function deleteHistoryRecord(id, button) {
  const record = state.history.find(entry => entry.id === id);
  if (!record) return;

  const dateLabel = record.completedAt
    ? new Date(record.completedAt).toLocaleString('ko-KR')
    : '선택한 날짜';
  const ok = confirm(`${dateLabel} 기록을 삭제하시겠습니까?\n\n사진과 기록이 함께 삭제되며 되돌릴 수 없습니다.`);
  if (!ok) return;

  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '…';

  try {
    await deleteSessionPhotos(record.id);

    state.history = state.history.filter(entry => entry.id !== id);
    save();
    renderHistory();

    if (record.shareId && configured()) {
      try {
        const { db, storage, auth } = await services();
        await Promise.allSettled(ITEMS.map(item =>
          deleteObject(ref(storage, `checks/${record.cloudOwnerUid || auth.currentUser.uid}/${record.shareId}/${item.id}.jpg`))
        ));
        await deleteDoc(doc(db, 'checks', record.shareId));
      } catch (error) {
        console.warn('Firebase 공유본 정리 실패', error);
        toast('기록은 삭제됐지만 공유본 정리에 실패했습니다');
        return;
      }
    }

    toast('기록이 삭제되었습니다');
  } catch (error) {
    console.error('기록 삭제 실패', error);
    button.disabled = false;
    button.textContent = oldText;
    toast('삭제하지 못했습니다 · 다시 시도해 주세요');
  }
}

async function showRecord(id) {
  const record = state.history.find(entry => entry.id === id);
  if (!record) return;
  const popup = open('', '_blank');
  if (!popup) return toast('팝업 차단을 해제해 주세요');
  popup.document.write('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;padding:calc(76px + env(safe-area-inset-top)) 18px 28px}.viewer-top{position:fixed;z-index:10;top:0;left:0;right:0;height:calc(58px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 14px 0;display:flex;align-items:center;background:rgba(0,0,0,.9);backdrop-filter:blur(18px);border-bottom:1px solid #252525}.back-btn{border:0;background:transparent;color:#fff;font-size:16px;font-weight:700;padding:12px;display:flex;align-items:center;gap:7px}.back-btn span{font-size:27px;line-height:0}h1{font-size:25px;margin:0 0 22px}h3{margin:0 0 5px}small{color:#888}.loading{color:#888}</style><div class="viewer-top"><button class="back-btn" id="viewerBack" type="button"><span>‹</span>기록으로</button></div><h1>창신체크미</h1><p class="loading">사진을 불러오는 중...</p>');

  const sections = [];
  for (const item of ITEMS) {
    const meta = record.items?.[item.id] || {};
    const blob = await getPhoto(record.id, item.id).catch(() => null);
    const url = blob ? URL.createObjectURL(blob) : (meta.url || '');
    sections.push({ item, meta, url });
  }

  popup.document.head.insertAdjacentHTML('beforeend', `<style>
    .photo-section{margin:0 0 34px}.photo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.memo-btn{flex:none;border:1px solid #383838;border-radius:999px;background:#111;color:#fff;padding:8px 12px;font-size:12px;font-weight:750}.photo-frame{position:relative}.photo-frame img{display:block;width:100%;border-radius:14px}.missing{padding:30px;border:1px solid #333;border-radius:14px;color:#888}.memo-bubble{position:absolute;left:10px;right:10px;top:10px;background:rgba(255,255,255,.94);color:#000;border-radius:15px;padding:11px 14px;font-size:13px;line-height:1.45;font-weight:650;box-shadow:0 6px 20px rgba(0,0,0,.25);white-space:pre-wrap;word-break:break-word}.memo-bubble:after{content:"";position:absolute;left:18px;bottom:-7px;border-width:7px 7px 0 0;border-style:solid;border-color:rgba(255,255,255,.94) transparent transparent transparent}.memo-bubble.hidden{display:none}
  </style>`);
  popup.document.body.innerHTML = `<div class="viewer-top"><button class="back-btn" id="viewerBack" type="button"><span>‹</span>기록으로</button></div><h1>${new Date(record.completedAt).toLocaleDateString('ko-KR')} 기록</h1>${sections.map(({item,meta,url}) => `<section class="photo-section"><div class="photo-head"><div><h3>${escapeHtml(item.name)}</h3><small>${meta?.timestamp ? formatDateTime(meta.timestamp) : ''}</small></div><button class="memo-btn" type="button" data-note-item="${item.id}">${meta.note?.trim() ? '메모 수정' : '메모'}</button></div><div class="photo-frame">${url ? `<img src="${url}" alt="${escapeHtml(item.name)}">` : '<div class="missing">이 기기에서 사진을 찾지 못했습니다.</div>'}<div class="memo-bubble ${meta.note?.trim() ? '' : 'hidden'}" data-note-bubble="${item.id}">${escapeHtml(meta.note || '')}</div></div></section>`).join('')}`;
  popup.document.getElementById('viewerBack').onclick = () => popup.close();
  [...popup.document.querySelectorAll('[data-note-item]')].forEach(button => {
    button.onclick = async () => {
      const itemId = button.dataset.noteItem;
      const item = ITEMS.find(entry => entry.id === itemId);
      const currentNote = record.items?.[itemId]?.note || '';
      const next = popup.prompt(`${item?.name || '항목'} 특이사항 메모`, currentNote);
      if (next === null) return;
      const note = next.trim().slice(0, 300);
      if (!record.items[itemId]) record.items[itemId] = {};
      record.items[itemId].note = note;
      const historyRecord = state.history.find(entry => entry.id === record.id);
      if (historyRecord?.items?.[itemId]) historyRecord.items[itemId].note = note;
      if (state.current?.id === record.id && state.current.items?.[itemId]) state.current.items[itemId].note = note;
      save();
      const bubble = popup.document.querySelector(`[data-note-bubble="${itemId}"]`);
      bubble.textContent = note;
      bubble.classList.toggle('hidden', !note);
      button.textContent = note ? '메모 수정' : '메모';
      renderHistory();
      await syncRecordNotes(record).catch(error => console.warn('메모 공유본 동기화 실패', error));
      toast(note ? '메모가 저장되었습니다' : '메모가 삭제되었습니다');
    };
  });
}

async function syncRecordNotes(record) {
  if (!record.shareId || !configured()) return;
  const { db } = await services();
  const photos = ITEMS.map(item => ({
    id: item.id,
    title: item.name,
    timestamp: record.items?.[item.id]?.timestamp || null,
    note: record.items?.[item.id]?.note || ''
  }));
  const snap = await getDoc(doc(db, 'checks', record.shareId));
  if (!snap.exists()) return;
  const current = snap.data();
  const urls = new Map((current.photos || []).map(photo => [photo.id, photo.url]));
  await setDoc(doc(db, 'checks', record.shareId), {
    photos: photos.map(photo => ({ ...photo, url: urls.get(photo.id) || '' })),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

function renderSettings() {
  $('radiusInput').value = state.settings.radius;
  $('breakSelect').value = String(state.settings.breakMinutes);
  $('workshopInfo').textContent = state.settings.workshop ? `저장됨 · 반경 ${state.settings.radius}m` : '아직 저장되지 않음';
  $('shortcutUrlText').textContent = shortcutUrl();
  const ok = configured();
  $('firebaseStatus').textContent = ok ? 'Firebase 설정됨 · 자동 백업 사용' : 'Firebase 설정 필요';
  $('firebaseDot').classList.toggle('on', ok);
  $('recoveryCodeText').textContent = state.settings.recoveryCode || '';
  $('recoveryCodeInput').value = '';
}


function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const raw = [...bytes].map(value => alphabet[value % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeRecoveryCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}` : '';
}

async function copyRecoveryCode() {
  const code = state.settings.recoveryCode;
  try {
    await navigator.clipboard.writeText(code);
    toast('복구 코드가 복사되었습니다');
  } catch {
    prompt('이 복구 코드를 안전한 곳에 보관하세요', code);
  }
}

async function restoreRecoveryCode() {
  const code = normalizeRecoveryCode($('recoveryCodeInput').value);
  if (!code) return toast('복구 코드 12자리를 확인해 주세요');
  const ok = confirm('입력한 복구 코드의 기록을 이 기기로 불러올까요?\n현재 기록은 삭제되지 않고 합쳐집니다.');
  if (!ok) return;
  state.settings.recoveryCode = code;
  save();
  await syncCloudHistory({ silent: false, code });
  renderSettings();
}

function cloudRecordFromDoc(snapshot) {
  const data = snapshot.data();
  const items = {};
  for (const photo of Array.isArray(data.photos) ? data.photos : []) {
    if (!photo?.id) continue;
    items[photo.id] = {
      title: photo.title || ITEMS.find(item => item.id === photo.id)?.name || photo.id,
      timestamp: photo.timestamp || data.completedAt || null,
      note: photo.note || '',
      url: photo.url || ''
    };
  }
  return {
    id: data.sessionId || `cloud_${snapshot.id}`,
    startedAt: data.startedAt || null,
    completedAt: data.completedAt || null,
    items,
    shareId: snapshot.id,
    shareUrl: buildShareUrl(snapshot.id),
    backedUpAt: data.updatedAt?.toDate?.()?.toISOString?.() || data.completedAt || null,
    cloudOwnerUid: data.ownerUid || ''
  };
}

function buildShareUrl(id) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('share', id);
  return url.toString();
}

function mergeCloudRecords(records) {
  let added = 0;
  let updated = 0;
  for (const incoming of records) {
    if (!incoming.completedAt) continue;
    const index = state.history.findIndex(record =>
      record.shareId === incoming.shareId ||
      record.id === incoming.id ||
      (record.completedAt === incoming.completedAt && Object.keys(record.items || {}).length === Object.keys(incoming.items || {}).length)
    );
    if (index < 0) {
      state.history.push(incoming);
      added += 1;
      continue;
    }
    const current = state.history[index];
    const mergedItems = { ...(incoming.items || {}), ...(current.items || {}) };
    for (const [itemId, incomingItem] of Object.entries(incoming.items || {})) {
      mergedItems[itemId] = { ...incomingItem, ...(current.items?.[itemId] || {}) };
      if (!mergedItems[itemId].url) mergedItems[itemId].url = incomingItem.url || '';
    }
    state.history[index] = { ...incoming, ...current, items: mergedItems, shareId: incoming.shareId, shareUrl: incoming.shareUrl };
    updated += 1;
  }
  state.history.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  save();
  render();
  return { added, updated };
}

async function syncCloudHistory({ silent = true, code = state.settings.recoveryCode } = {}) {
  if (!configured() || !code) return;
  const button = $('syncCloudBtn');
  const oldText = button?.textContent;
  if (button && !silent) { button.disabled = true; button.textContent = '동기화 중…'; }
  if (!silent) toast('클라우드 기록을 확인합니다');
  try {
    const { db } = await services();
    const snap = await getDocs(query(collection(db, 'checks'), where('backupCode', '==', code)));
    const records = snap.docs.filter(docSnap => docSnap.data()?.type !== 'connection-test').map(cloudRecordFromDoc);
    const result = mergeCloudRecords(records);

    // 이 기기에만 남아 있던 이전 버전 기록도 차례로 백업한다.
    const pending = state.history.filter(record => record.completedAt && Object.keys(record.items || {}).length === ITEMS.length && !record.backedUpAt);
    for (const record of pending) {
      try { await backupSession(record); } catch (error) { console.warn('이전 기록 백업 실패', record.id, error); }
    }
    if (!silent) toast(`동기화 완료 · 새 기록 ${result.added}개`);
  } catch (error) {
    console.error('클라우드 복원 실패', error);
    if (!silent) toast(`동기화 실패 · ${firebaseErrorText(error)}`);
    throw error;
  } finally {
    if (button && !silent) { button.disabled = false; button.textContent = oldText || '지금 동기화'; }
  }
}

async function backupSession(session, onProgress = null) {
  if (!session?.completedAt || Object.keys(session.items || {}).length !== ITEMS.length) throw new Error('완료된 기록만 백업할 수 있습니다');
  if (!configured()) throw new Error('Firebase 설정 필요');
  const { db, storage, auth } = await services();

  // 복구한 타 기기 소유 문서는 수정할 수 없으므로 현재 계정 소유의 새 백업본을 만든다.
  let id = session.shareId || generateId();
  if (session.cloudOwnerUid && session.cloudOwnerUid !== auth.currentUser.uid) id = generateId();
  const checkRef = doc(db, 'checks', id);
  const existing = await getDoc(checkRef).catch(() => null);
  const existingPhotos = new Map((existing?.exists() ? existing.data().photos : []).map(photo => [photo.id, photo]));

  await setDoc(checkRef, {
    ownerUid: auth.currentUser.uid,
    backupCode: state.settings.recoveryCode,
    sessionId: session.id,
    public: true,
    type: 'inspection',
    completedAt: session.completedAt,
    startedAt: session.startedAt || null,
    progress: 0,
    createdAt: existing?.exists() ? existing.data().createdAt || serverTimestamp() : serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  const photos = [];
  for (let index = 0; index < ITEMS.length; index += 1) {
    const item = ITEMS[index];
    const meta = session.items[item.id] || {};
    onProgress?.(index + 1, ITEMS.length);
    let url = meta.url || existingPhotos.get(item.id)?.url || '';
    const blob = await getPhoto(session.id, item.id).catch(() => null);
    if (blob) {
      const path = `checks/${auth.currentUser.uid}/${id}/${item.id}.jpg`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
      url = await getDownloadURL(storageRef);
    }
    if (!url) throw new Error(`${item.name} 사진을 찾지 못했습니다`);
    meta.url = url;
    photos.push({ id: item.id, title: item.name, timestamp: meta.timestamp || null, note: meta.note || '', url });
  }

  await setDoc(checkRef, { photos, progress: 100, updatedAt: serverTimestamp() }, { merge: true });
  session.shareId = id;
  session.shareUrl = buildShareUrl(id);
  session.backedUpAt = new Date().toISOString();
  session.cloudOwnerUid = auth.currentUser.uid;
  if (state.current?.id === session.id) Object.assign(state.current, session);
  const historyRecord = state.history.find(record => record.id === session.id);
  if (historyRecord) Object.assign(historyRecord, clone(session));
  save();
  render();
  return session.shareUrl;
}

function shortcutUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('leave', '1');
  return url.toString();
}

async function copyShortcutUrl() {
  const url = shortcutUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('단축어용 주소 복사됨');
  } catch {
    prompt('이 주소를 복사하세요', url);
  }
}

async function testFirebase() {
  if (!configured()) return toast('Firebase 설정이 없습니다');
  const button = $('testFirebaseBtn');
  const old = button.textContent;
  button.disabled = true;
  button.textContent = '확인 중…';
  toast('Firebase 연결 확인 중');
  try {
    const { db, auth } = await services();
    const id = `__connection_test_${auth.currentUser.uid}`;
    await setDoc(doc(db, 'checks', id), {
      ownerUid: auth.currentUser.uid,
      public: false,
      type: 'connection-test',
      createdAt: serverTimestamp()
    });
    const snap = await getDoc(doc(db, 'checks', id));
    if (!snap.exists()) throw new Error('Firestore 읽기 실패');
    await deleteDoc(doc(db, 'checks', id));
    toast('Firebase 연결됨');
  } catch (error) {
    console.error(error);
    toast(`연결 실패 · ${firebaseErrorText(error)}`);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

function handleShortcutLaunch() {
  const query = new URLSearchParams(location.search);
  if (query.get('leave') !== '1') return;
  if (isBreak()) return toast('잠시 외출 중 · 경고 생략');
  if (state.current.completedAt) return toast('오늘 점검이 이미 완료됐습니다');
  setTimeout(() => {
    navigator.vibrate?.([180, 70, 180, 70, 220]);
    toast('퇴실 점검이 아직 끝나지 않았습니다');
    if ('Notification' in window) {
      if (Notification.permission === 'granted') new Notification('창신체크미', { body: '작업실 퇴실 점검을 완료해 주세요.' });
      else if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    }
  }, 450);
}

function toggleBreak() {
  if (isBreak()) state.settings.breakUntil = null;
  else state.settings.breakUntil = new Date(Date.now() + state.settings.breakMinutes * 60000).toISOString();
  save();
  render();
  toast(isBreak() ? '잠시 외출 켜짐' : '잠시 외출 해제');
}

function isBreak() {
  return Boolean(state.settings.breakUntil && new Date(state.settings.breakUntil) > new Date());
}

function saveWorkshop() {
  navigator.geolocation.getCurrentPosition(position => {
    state.settings.workshop = { lat: position.coords.latitude, lng: position.coords.longitude };
    save();
    render();
    toast('작업실 위치 저장됨');
  }, () => toast('위치 권한을 확인해 주세요.'), { enableHighAccuracy: true });
}

function watchLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(position => {
    coords = position.coords;
    checkLeave();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });
}

function checkLeave() {
  if (!coords || !state.settings.workshop || isBreak() || state.current.completedAt) {
    outsideHits = 0;
    return;
  }
  const accuracy = Number(coords.accuracy || 999);
  if (accuracy > 15) {
    outsideHits = 0;
    return;
  }
  const meters = distance(coords.latitude, coords.longitude, state.settings.workshop.lat, state.settings.workshop.lng);
  outsideHits = meters > state.settings.radius ? outsideHits + 1 : 0;
  if (outsideHits >= 3 && Date.now() - lastAlert > 180000) {
    outsideHits = 0;
    lastAlert = Date.now();
    navigator.vibrate?.([180, 80, 180, 80, 220]);
    toast(`작업실에서 ${Math.round(meters)}m 벗어남`);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('창신체크미', { body: `작업실에서 약 ${Math.round(meters)}m 벗어났습니다. 퇴실 점검을 확인해 주세요.` });
    }
  }
}

function distance(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const deltaLat = (lat2 - lat1) * Math.PI / 180;
  const deltaLng = (lng2 - lng1) * Math.PI / 180;
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(deltaLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toast(text) {
  const element = $('toast');
  if (!element) return;
  element.textContent = text;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2400);
}

function compressToBlob(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const maxSize = 1280;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          URL.revokeObjectURL(objectUrl);
          if (blob) resolve(blob);
          else reject(new Error('사진 압축 실패'));
        }, 'image/jpeg', 0.76);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('사진을 읽을 수 없습니다.'));
    };
    image.src = objectUrl;
  });
}

function configured() {
  return Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId && firebaseConfig?.storageBucket && firebaseConfig?.appId);
}

async function services() {
  if (fb) return fb;
  if (!configured()) throw new Error('Firebase 설정 필요');
  const app = initializeApp(firebaseConfig);
  fb = { auth: getAuth(app), db: getFirestore(app), storage: getStorage(app) };
  if (!fb.auth.currentUser) await signInAnonymously(fb.auth);
  return fb;
}

async function shareSession(session, button = null) {
  if (shareBusy) return;
  if (!session?.completedAt || Object.keys(session.items || {}).length !== ITEMS.length) return toast('7개를 모두 완료해 주세요');
  if (!configured()) return toast('Firebase 설정이 없습니다');
  if (session.shareUrl) return openNativeShare(session.shareUrl);

  shareBusy = true;
  const oldText = button?.textContent || '공유하기';
  if (button) { button.disabled = true; button.textContent = '백업 준비…'; }
  toast('사진을 안전하게 백업합니다');
  try {
    await backupSession(session, (current, total) => {
      if (button) button.textContent = `백업 ${current} / ${total}`;
    });
    if (button) button.textContent = '공유창 열기';
    toast('백업 완료 · 공유하기를 한 번 더 누르세요');
  } catch (error) {
    console.error(error);
    toast(`백업 실패 · ${firebaseErrorText(error)}`);
  } finally {
    shareBusy = false;
    if (button) { button.disabled = false; button.textContent = session.shareUrl ? '공유창 열기' : oldText; }
  }
}

async function openNativeShare(shareUrl) {
  try {
    if (navigator.share) {
      await navigator.share({
        title: '창신체크미 점검 기록',
        text: '작업실 퇴실 점검 사진입니다.',
        url: shareUrl
      });
      toast('공유 완료');
      return;
    }
    await navigator.clipboard.writeText(shareUrl);
    toast('공유 링크가 복사됐습니다');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error(error);
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast('공유창을 열지 못해 링크를 복사했습니다');
    } catch {
      prompt('이 링크를 복사하세요', shareUrl);
    }
  }
}

function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID().replaceAll('-', '');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function firebaseErrorText(error) {
  const code = String(error?.code || '');
  if (code.includes('permission-denied') || code.includes('unauthorized')) return 'Firebase 규칙 권한 오류';
  if (code.includes('network-request-failed') || !navigator.onLine) return '인터넷 연결 오류';
  if (code.includes('operation-not-allowed')) return '익명 로그인을 켜 주세요';
  if (code.includes('storage/')) return 'Storage 설정 또는 규칙 오류';
  if (error?.name === 'NotAllowedError') return '공유창은 링크 준비 후 다시 눌러 주세요';
  return error?.message || 'Firebase 설정을 확인해 주세요';
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString('ko-KR') : '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(error => console.warn('서비스워커 등록 실패', error));
}
