import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';

let firebaseServices = null;
function isFirebaseConfigured() {
  return firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.includes('여기에_');
}
function getFirebaseServices() {
  if (!isFirebaseConfigured()) throw new Error('Firebase 설정값이 아직 입력되지 않았어요.');
  if (firebaseServices) return firebaseServices;
  const app = initializeApp(firebaseConfig);
  firebaseServices = { auth:getAuth(app), db:getFirestore(app), storage:getStorage(app) };
  return firebaseServices;
}
async function ensureAnonymousUser() {
  const { auth } = getFirebaseServices();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}


const ITEMS = [
  { id:'f1_ac', floor:'1층', name:'에어컨', full:'1층 에어컨', hint:'전원이 꺼져 있는지 보이게 찍어 주세요.' },
  { id:'f1_in', floor:'1층', name:'실내조명', full:'1층 실내조명', hint:'실내 불이 꺼진 상태가 보이게 찍어 주세요.' },
  { id:'f1_out', floor:'1층', name:'실외조명', full:'1층 실외조명', hint:'실외 불 상태가 보이게 찍어 주세요.' },
  { id:'f1_lock', floor:'1층', name:'문 잠금', full:'1층 문잠금', hint:'문이 잠긴 것이 보이게 찍어 주세요.' },
  { id:'f2_ac', floor:'2층', name:'에어컨', full:'2층 에어컨', hint:'전원이 꺼져 있는지 보이게 찍어 주세요.' },
  { id:'f2_in', floor:'2층', name:'실내조명', full:'2층 실내조명', hint:'실내 불이 꺼진 상태가 보이게 찍어 주세요.' },
  { id:'f2_lock', floor:'2층', name:'문 잠금', full:'2층 문잠금', hint:'문이 잠긴 것이 보이게 찍어 주세요.' }
];
const STORAGE_KEY = 'changsinCheckMe_v2';
const DEFAULT_STATE = {
  currentSession: {
    id: '',
    startedAt: '',
    items: {},
    completedAt: ''
  },
  history: [],
  settings: {
    workshop: null,
    radius: 120,
    breakDefaultMinutes: 30,
    breakUntil: null,
    notificationsAsked: false
  },
  ui: {
    activeView: 'checkView'
  }
};
let state = loadState();
let activeItemId = null;
let previewData = null;
let previewFileMeta = '';
let geoWatchId = null;
let currentPosition = null;
let lastLeaveAlertAt = 0;
let selectedRecordId = null;

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

ensureSession();
renderAll();
setupEvents();
setupGeolocationWatch();
maybeAskNotificationPermission();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) return structuredClone(DEFAULT_STATE);
    return {
      currentSession: saved.currentSession || structuredClone(DEFAULT_STATE.currentSession),
      history: Array.isArray(saved.history) ? saved.history : [],
      settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
      ui: { ...DEFAULT_STATE.ui, ...(saved.ui || {}) }
    };
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    trimHistoryAndRetry();
  }
}

function trimHistoryAndRetry() {
  while (state.history.length > 8) {
    state.history.pop();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      showToast('저장 공간이 부족해 오래된 기록을 일부 정리했어요.');
      return;
    } catch (e) {}
  }
  showToast('저장 공간이 부족해 기록 저장에 제한이 있어요.');
}

function structuredClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function ensureSession() {
  if (!state.currentSession.id) {
    state.currentSession = createNewSession();
    saveState();
  }
}

function createNewSession() {
  return {
    id: `session_${Date.now()}`,
    startedAt: new Date().toISOString(),
    items: {},
    completedAt: ''
  };
}

function setupEvents() {
  $('newSessionBtn').addEventListener('click', () => {
    if (countCompleted() > 0 && !confirm('현재 진행 중인 점검을 새로 시작할까요?')) return;
    state.currentSession = createNewSession();
    saveState();
    renderAll();
    showToast('새 점검을 시작했어요.');
  });

  $('breakBtn').addEventListener('click', handleBreakButton);
  $('shareCurrentBtn').addEventListener('click', () => shareSession(state.currentSession, false));
  $('requestLocationBtn').addEventListener('click', async () => {
    if (!navigator.geolocation) return showToast('이 기기에서는 위치 기능을 사용할 수 없어요.');
    navigator.geolocation.getCurrentPosition(
      pos => {
        currentPosition = pos.coords;
        showToast('현재 위치 접근이 확인됐어요.');
      },
      () => showToast('위치 권한이 필요해요. Safari 설정에서 허용해 주세요.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $('saveWorkshopBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('위치 기능을 사용할 수 없어요.');
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.settings.workshop = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.settings.radius = clampRadius(Number($('radiusInput').value) || 120);
        saveState();
        renderSettings();
        showToast('현재 위치를 작업실로 저장했어요.');
      },
      () => showToast('현재 위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $('clearWorkshopBtn').addEventListener('click', () => {
    state.settings.workshop = null;
    saveState();
    renderSettings();
    showToast('작업실 위치를 지웠어요.');
  });

  $('radiusInput').addEventListener('change', e => {
    state.settings.radius = clampRadius(Number(e.target.value) || 120);
    e.target.value = state.settings.radius;
    saveState();
    renderSettings();
  });

  $('breakSelect').addEventListener('change', e => {
    state.settings.breakDefaultMinutes = Number(e.target.value) || 30;
    saveState();
    renderHeader();
  });

  $$('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.ui.activeView = btn.dataset.view;
      saveState();
      renderViews();
    });
  });

  $('cameraTriggerBtn').addEventListener('click', () => $('cameraInput').click());
  $('cameraInput').addEventListener('change', handleCameraInput);
  $('retakeBtn').addEventListener('click', () => $('cameraInput').click());
  $('savePhotoBtn').addEventListener('click', saveActiveItemPhoto);
  $('closeCameraSheetBtn').addEventListener('click', closeCameraSheet);
  $('cameraSheetBackdrop').addEventListener('click', e => {
    if (e.target.id === 'cameraSheetBackdrop') closeCameraSheet();
  });

  $('closeRecordSheetBtn').addEventListener('click', closeRecordSheet);
  $('recordSheetBackdrop').addEventListener('click', e => {
    if (e.target.id === 'recordSheetBackdrop') closeRecordSheet();
  });
  $('shareRecordBtn').addEventListener('click', () => {
    const record = state.history.find(r => r.id === selectedRecordId);
    if (record) shareSession(record, true);
  });
  $('duplicateSessionBtn').addEventListener('click', () => {
    state.currentSession = createNewSession();
    saveState();
    closeRecordSheet();
    state.ui.activeView = 'checkView';
    saveState();
    renderAll();
    showToast('새 점검을 시작했어요.');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkLeaveCondition();
  });
}

function clampRadius(v) { return Math.max(30, Math.min(500, Math.round(v))); }

function handleBreakButton() {
  const now = Date.now();
  if (state.settings.breakUntil && new Date(state.settings.breakUntil).getTime() > now) {
    if (confirm('잠시 외출을 해제할까요?')) {
      state.settings.breakUntil = null;
      saveState();
      renderHeader();
      showToast('잠시 외출을 해제했어요.');
    }
    return;
  }
  const mins = state.settings.breakDefaultMinutes || 30;
  const until = new Date(now + mins * 60 * 1000).toISOString();
  state.settings.breakUntil = until;
  saveState();
  renderHeader();
  showToast(`${mins}분 동안 잠시 외출 모드가 켜졌어요.`);
}

async function handleCameraInput() {
  const file = $('cameraInput').files?.[0];
  if (!file) return;
  previewData = await compressImage(file);
  previewFileMeta = `${new Date().toLocaleString('ko-KR')} · ${(file.size / 1024 / 1024).toFixed(1)}MB`;
  $('previewImg').src = previewData;
  $('previewMeta').textContent = previewFileMeta;
  $('cameraPreview').classList.add('show');
  $('savePhotoBtn').disabled = false;
}

function openCameraSheet(itemId) {
  activeItemId = itemId;
  const item = ITEMS.find(x => x.id === itemId);
  previewData = null;
  previewFileMeta = '';
  $('cameraInput').value = '';
  $('cameraPreview').classList.remove('show');
  $('savePhotoBtn').disabled = true;
  $('cameraSheetTitle').textContent = item.full;
  $('cameraSheetDesc').textContent = item.hint;
  $('cameraSheetBackdrop').classList.add('show');
}

function closeCameraSheet() {
  $('cameraSheetBackdrop').classList.remove('show');
  activeItemId = null;
  previewData = null;
  previewFileMeta = '';
  $('cameraInput').value = '';
  $('cameraPreview').classList.remove('show');
  $('savePhotoBtn').disabled = true;
}

function saveActiveItemPhoto() {
  if (!activeItemId || !previewData) return;
  const item = ITEMS.find(x => x.id === activeItemId);
  state.currentSession.items[activeItemId] = {
    itemId: activeItemId,
    title: item.full,
    timestamp: new Date().toISOString(),
    image: previewData
  };
  saveState();
  const completedBefore = !!state.currentSession.completedAt;
  const allDone = countCompleted() === ITEMS.length;
  if (allDone && !completedBefore) completeCurrentSession();
  closeCameraSheet();
  renderAll();
  showToast(`${item.full} 사진을 저장했어요.`);
}

function completeCurrentSession() {
  state.currentSession.completedAt = new Date().toISOString();
  state.history.unshift(structuredClone(state.currentSession));
  if (state.history.length > 15) state.history = state.history.slice(0, 15);
  saveState();
  if (navigator.vibrate) navigator.vibrate([90, 40, 90]);
  showToast('모든 항목을 완료했어요. 귀가 가능합니다.');
}

function countCompleted() {
  return Object.keys(state.currentSession.items || {}).length;
}

function renderAll() {
  renderViews();
  renderHeader();
  renderItems();
  renderHistory();
  renderSettings();
}

function renderViews() {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === state.ui.activeView));
  $$('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.ui.activeView));
}

function renderHeader() {
  const done = countCompleted();
  $('headerCount').textContent = `${done} / ${ITEMS.length} 완료`;
  $('progressText').textContent = `${done}개 완료`;
  $('progressBar').style.width = `${(done / ITEMS.length) * 100}%`;
  $('sessionStatus').textContent = state.currentSession.completedAt ? '점검 완료' : '점검 진행 중';
  $('heroTitle').textContent = state.currentSession.completedAt ? '모든 점검이 완료되었어요' : '원하는 항목부터 눌러서 사진 찍기';
  $('heroDesc').textContent = state.currentSession.completedAt
    ? `${new Date(state.currentSession.completedAt).toLocaleString('ko-KR')}에 모든 항목을 완료했어요. 필요하면 공유하거나 새 점검을 시작하세요.`
    : '1층부터든 2층부터든 상관없이, 아래 카드 중 필요한 곳을 바로 눌러 사진을 찍어 주세요.';
  const breakUntil = state.settings.breakUntil ? new Date(state.settings.breakUntil).getTime() : 0;
  if (breakUntil > Date.now()) {
    $('breakText').textContent = `잠시 외출 중 · ${formatTime(breakUntil)}`;
    $('breakBtn').textContent = '잠시 외출 해제';
    $('breakBtn').className = 'btn red';
  } else {
    if (state.settings.breakUntil) {
      state.settings.breakUntil = null;
      saveState();
    }
    $('breakText').textContent = `잠시 외출 꺼짐`;
    $('breakBtn').textContent = '잠시 외출';
    $('breakBtn').className = 'btn soft';
  }
  renderMonitorNotice();
}

function renderMonitorNotice() {
  const workshop = state.settings.workshop;
  let text = '웹앱이 열려 있는 동안에는 작업실에서 멀어질 때 경고를 띄울 수 있어요. 아이폰에서 완전한 백그라운드 즉시 경고는 웹앱만으로 제한이 있으니, 진짜 즉각 경고는 단축어 자동화와 같이 쓰는 걸 추천해요.';
  if (workshop) {
    text = `작업실 위치 저장됨 · 반경 ${state.settings.radius}m. 웹앱이 열려 있는 동안에는 이 반경을 벗어나면 경고를 띄웁니다.`;
  }
  $('monitorText').textContent = text;
}

function renderItems() {
  const floors = ['1층', '2층'];
  $('itemsWrap').innerHTML = floors.map(floor => {
    const floorItems = ITEMS.filter(i => i.floor === floor);
    const doneCount = floorItems.filter(i => state.currentSession.items[i.id]).length;
    return `
      <div>
        <div class="floor-title"><h3>${floor}</h3><span class="pill">${doneCount} / ${floorItems.length}</span></div>
        <div class="item-grid">
          ${floorItems.map((item, idx) => {
            const saved = state.currentSession.items[item.id];
            const done = !!saved;
            return `
              <button class="item-card ${done ? 'done' : ''}" type="button" data-item-id="${item.id}">
                <div class="item-num">${done ? '✓' : idx + 1}</div>
                <div class="item-main">
                  <h4>${item.full}</h4>
                  <p>${done ? `${new Date(saved.timestamp).toLocaleString('ko-KR')}에 저장됨` : item.hint}</p>
                </div>
                <div class="status">${done ? '완료' : '촬영'}</div>
              </button>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  $$('[data-item-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.currentSession.completedAt) {
        showToast('이 점검은 이미 완료됐어요. 새 점검 시작 버튼으로 다음 점검을 시작해 주세요.');
        return;
      }
      openCameraSheet(btn.dataset.itemId);
    });
  });
}

function renderHistory() {
  const list = $('recordList');
  if (!state.history.length) {
    list.innerHTML = '<div class="record empty">아직 완료된 기록이 없어요.</div>';
    return;
  }
  list.innerHTML = state.history.map(record => {
    const count = Object.keys(record.items || {}).length;
    return `
      <div class="record">
        <div class="record-head">
          <div>
            <h4>${formatDateHeading(record.completedAt || record.startedAt)}</h4>
            <p>${new Date(record.completedAt || record.startedAt).toLocaleString('ko-KR')} · ${count}개 사진</p>
          </div>
          <div class="pill">${count} / ${ITEMS.length}</div>
        </div>
        <div class="record-actions">
          <button class="btn secondary" type="button" data-record-view="${record.id}">사진 보기</button>
          <button class="btn primary" type="button" data-record-share="${record.id}">공유하기</button>
        </div>
      </div>`;
  }).join('');

  $$('[data-record-view]').forEach(btn => btn.addEventListener('click', () => openRecordSheet(btn.dataset.recordView)));
  $$('[data-record-share]').forEach(btn => btn.addEventListener('click', () => {
    const record = state.history.find(r => r.id === btn.dataset.recordShare);
    if (record) shareSession(record, true);
  }));
}

function renderSettings() {
  $('radiusInput').value = state.settings.radius || 120;
  $('breakSelect').value = String(state.settings.breakDefaultMinutes || 30);
  if (state.settings.workshop) {
    $('workshopInfo').textContent = `저장된 위치 · 위도 ${state.settings.workshop.lat.toFixed(5)}, 경도 ${state.settings.workshop.lng.toFixed(5)} · 반경 ${state.settings.radius}m`;
  } else {
    $('workshopInfo').textContent = '아직 작업실 위치가 저장되지 않았습니다.';
  }
}

function openRecordSheet(recordId) {
  selectedRecordId = recordId;
  const record = state.history.find(r => r.id === recordId);
  if (!record) return;
  $('recordSheetTitle').textContent = formatDateHeading(record.completedAt || record.startedAt);
  $('recordSheetDesc').textContent = `${new Date(record.completedAt || record.startedAt).toLocaleString('ko-KR')}에 완료된 기록입니다.`;
  const order = ITEMS.map(i => i.id);
  $('recordDetailGrid').innerHTML = order.map(itemId => {
    const photo = record.items[itemId];
    const item = ITEMS.find(x => x.id === itemId);
    if (!photo) return `
      <div class="detail-item">
        <strong>${item.full}</strong>
        <div class="detail-meta">저장된 사진이 없습니다.</div>
      </div>`;
    return `
      <div class="detail-item">
        <strong>${item.full}</strong>
        <div class="detail-meta">${new Date(photo.timestamp).toLocaleString('ko-KR')}</div>
        <img src="${photo.image}" alt="${item.full} 사진" />
      </div>`;
  }).join('');
  $('recordSheetBackdrop').classList.add('show');
}

function closeRecordSheet() {
  $('recordSheetBackdrop').classList.remove('show');
  selectedRecordId = null;
}

function formatDateHeading(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 기록`;
}

function formatTime(timestampMs) {
  const d = new Date(timestampMs);
  return d.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1200;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function shareSession(session, fromHistory) {
  const count = Object.keys(session.items || {}).length;
  if (!count) return showToast('공유할 사진이 아직 없어요.');

  if (!isFirebaseConfigured()) {
    const stamp = new Date(session.completedAt || session.startedAt).toLocaleString('ko-KR');
    const text = `${fromHistory ? '작업실 점검 기록' : '현재 작업실 점검'}\n${stamp}\n\n${ITEMS.map(item => `${session.items[item.id] ? '✅' : '⬜'} ${item.full}`).join('\n')}\n\nFirebase 설정을 완료하면 사진이 보이는 공유 링크가 생성됩니다.`;
    try {
      if (navigator.share) await navigator.share({ title:'창신체크미 점검 기록', text });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); showToast('공유용 문구를 복사했어요.'); }
      else alert(text);
    } catch (e) {}
    return;
  }

  const oldText = $('shareCurrentBtn')?.textContent;
  try {
    showToast('공유 링크를 만들고 있어요. 사진 수에 따라 잠시 걸릴 수 있어요.');
    if ($('shareCurrentBtn')) $('shareCurrentBtn').textContent = '업로드 중…';
    const user = await ensureAnonymousUser();
    const { db, storage } = getFirebaseServices();
    const shareId = makeShareId();
    const photoEntries = [];

    for (const item of ITEMS) {
      const photo = session.items?.[item.id];
      if (!photo?.image) continue;
      const blob = dataUrlToBlob(photo.image);
      const path = `shares/${shareId}/${item.id}.jpg`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, blob, { contentType:'image/jpeg' });
      const imageUrl = await getDownloadURL(storageRef);
      photoEntries.push({ itemId:item.id, title:item.full, timestamp:photo.timestamp, imageUrl });
    }

    await setDoc(doc(db, 'shares', shareId), {
      ownerUid: user.uid,
      createdAt: serverTimestamp(),
      completedAt: session.completedAt || null,
      startedAt: session.startedAt || null,
      count: photoEntries.length,
      photos: photoEntries,
      appName: '창신체크미'
    });

    const shareUrl = `${location.origin}${location.pathname}?share=${encodeURIComponent(shareId)}`;
    const shareText = `창신체크미 점검 기록\n${new Date(session.completedAt || session.startedAt).toLocaleString('ko-KR')}\n사진 ${photoEntries.length}장을 확인할 수 있습니다.`;
    if (navigator.share) await navigator.share({ title:'창신체크미 점검 기록', text:shareText, url:shareUrl });
    else if (navigator.clipboard) {
      await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      showToast('사진 확인 링크를 복사했어요.');
    } else prompt('아래 링크를 복사하세요.', shareUrl);
  } catch (e) {
    console.error(e);
    showToast(`공유 링크 생성 실패: ${friendlyFirebaseError(e)}`);
  } finally {
    if ($('shareCurrentBtn') && oldText) $('shareCurrentBtn').textContent = oldText;
  }
}

function makeShareId() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/data:(.*?);/)?.[1] || 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type:mime });
}

function friendlyFirebaseError(error) {
  const code = error?.code || '';
  if (code.includes('auth/operation-not-allowed')) return 'Firebase에서 익명 로그인을 켜 주세요.';
  if (code.includes('storage/unauthorized') || code.includes('permission-denied')) return 'Firebase 보안 규칙을 확인해 주세요.';
  if (code.includes('storage/unknown')) return 'Storage 설정 또는 요금제 상태를 확인해 주세요.';
  return error?.message || '설정을 확인해 주세요.';
}

async function renderPublicShareIfNeeded() {
  const shareId = new URLSearchParams(location.search).get('share');
  if (!shareId) return false;
  $('appRoot').style.display = 'none';
  const root = $('publicShareRoot');
  root.style.display = 'block';
  root.innerHTML = '<div class="loading-card">공유된 점검 사진을 불러오고 있어요…</div>';
  try {
    const { db } = getFirebaseServices();
    const snap = await getDoc(doc(db, 'shares', shareId));
    if (!snap.exists()) throw new Error('공유 기록을 찾을 수 없어요.');
    const data = snap.data();
    const stamp = data.completedAt || data.startedAt;
    root.innerHTML = `
      <main class="public-wrap">
        <section class="public-head">
          <h1>창신체크미 ✓</h1>
          <p>${stamp ? new Date(stamp).toLocaleString('ko-KR') : '완료 시각 미기록'} · 사진 ${data.count || data.photos?.length || 0}장</p>
        </section>
        <section class="public-grid">
          ${(data.photos || []).map(photo => `
            <article class="public-photo">
              <h3>${escapeHtml(photo.title || '점검 사진')}</h3>
              <img src="${photo.imageUrl}" alt="${escapeHtml(photo.title || '점검 사진')}" loading="lazy" />
              <div class="public-meta">${photo.timestamp ? new Date(photo.timestamp).toLocaleString('ko-KR') : ''}</div>
            </article>`).join('') || '<div class="loading-card">공유된 사진이 없어요.</div>'}
        </section>
      </main>`;
  } catch (e) {
    root.innerHTML = `<div class="loading-card"><strong>기록을 열지 못했어요.</strong><p>${escapeHtml(friendlyFirebaseError(e))}</p></div>`;
  }
  return true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function setupGeolocationWatch() {
  if (!navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      currentPosition = pos.coords;
      checkLeaveCondition();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  );
}

function maybeAskNotificationPermission() {
  if (!('Notification' in window) || state.settings.notificationsAsked) return;
  state.settings.notificationsAsked = true;
  saveState();
  if (Notification.permission === 'default') {
    setTimeout(() => {
      Notification.requestPermission().catch(() => {});
    }, 1400);
  }
}

function checkLeaveCondition() {
  if (!currentPosition) return;
  if (countCompleted() === ITEMS.length) return;
  const workshop = state.settings.workshop;
  if (!workshop) return;
  const breakUntil = state.settings.breakUntil ? new Date(state.settings.breakUntil).getTime() : 0;
  if (breakUntil > Date.now()) return;
  const distance = calcDistanceMeters(currentPosition.latitude, currentPosition.longitude, workshop.lat, workshop.lng);
  if (distance > (state.settings.radius || 120)) triggerLeaveAlert(Math.round(distance));
}

function triggerLeaveAlert(distance) {
  const now = Date.now();
  if (now - lastLeaveAlertAt < 180000) return;
  lastLeaveAlertAt = now;
  const msg = `작업실에서 약 ${distance}m 벗어났어요. 아직 점검이 끝나지 않았습니다.`;
  showToast(msg);
  if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 180]);
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('창신체크미 경고', { body: msg }); } catch (e) {}
  }
}

function calcDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) * Math.sin(dLng/2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

renderPublicShareIfNeeded();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
