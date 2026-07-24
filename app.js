import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';

const ITEMS = [
  { id: 'f1_ac', name: '1층 에어컨', icon: '▱' },
  { id: 'f1_in', name: '1층 실내조명', icon: '◉' },
  { id: 'f1_out', name: '1층 실외조명', icon: '◌' },
  { id: 'f1_lock', name: '1층 문잠금', icon: '▣' },
  { id: 'f2_ac', name: '2층 에어컨', icon: '▱' },
  { id: 'f2_in', name: '2층 실내조명', icon: '◉' },
  { id: 'f2_lock', name: '2층 문잠금', icon: '▣' }
];

const KEY = 'changsinCheckMe_v12';
const LEGACY_KEYS = ['changsinCheckMe_v11', 'changsinCheckMe_v10'];
const DEFAULT = {
  current: null,
  history: [],
  settings: { workshop: null, radius: 10, breakMinutes: 30, breakUntil: null },
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
      ${photos.map(photo => `<section class="public-photo"><h3>✓ ${escapeHtml(photo.title)}</h3><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.title)}" loading="lazy"><div class="public-meta">촬영 ${formatDateTime(photo.timestamp)}</div></section>`).join('')}
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
}

start().catch(error => {
  console.error(error);
  document.body.innerHTML = '<div class="loading-card">앱을 시작하지 못했습니다. 새로고침해 주세요.</div>';
});

function setup() {
  $('cameraInput').addEventListener('change', onPhoto);
  $('breakBtn').addEventListener('click', toggleBreak);
  $('shareBtn').addEventListener('click', () => shareSession(state.current, $('shareBtn')));
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
  $('newSessionBtn').addEventListener('click', async () => {
    if (Object.keys(state.current.items).length && !confirm('현재 점검을 지울까요?')) return;
    const oldSessionId = state.current.id;
    state.current = newSession();
    save();
    try { await deleteSessionPhotos(oldSessionId); } catch (error) { console.warn(error); }
    render();
    switchView('checkView');
  });
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
  state.history = state.history.slice(0, 12);
  save();
  navigator.vibrate?.([100, 50, 100, 50, 160]);
  $('completeScreen').classList.add('show');
}

function renderHistory() {
  if (!state.history.length) {
    $('historyList').innerHTML = '<div class="card"><p>아직 완료 기록이 없습니다.</p></div>';
    return;
  }
  $('historyList').innerHTML = state.history.map(record => `<article class="card">
    <h3>${new Date(record.completedAt).toLocaleDateString('ko-KR')}</h3>
    <p>${formatTime(record.completedAt)} · ${Object.keys(record.items || {}).length}개 완료</p>
    <div class="card-actions"><button class="small-btn" data-view-record="${record.id}">사진 보기</button><button class="small-btn white" data-share-record="${record.id}">공유</button></div>
  </article>`).join('');

  $$('[data-view-record]').forEach(button => button.onclick = () => showRecord(button.dataset.viewRecord));
  $$('[data-share-record]').forEach(button => button.onclick = () => {
    const record = state.history.find(entry => entry.id === button.dataset.shareRecord);
    shareSession(record, button);
  });
}

async function showRecord(id) {
  const record = state.history.find(entry => entry.id === id);
  if (!record) return;
  const popup = open('', '_blank');
  if (!popup) return toast('팝업 차단을 해제해 주세요');
  popup.document.write('<meta name="viewport" content="width=device-width"><style>body{background:#000;color:#fff;font-family:-apple-system;padding:18px}img{width:100%;border-radius:14px;margin:8px 0 24px}small{color:#888}.missing{padding:30px;border:1px solid #333;border-radius:14px;color:#888;margin:8px 0 24px}</style><h1>창신체크미</h1><p>사진을 불러오는 중...</p>');

  const sections = [];
  for (const item of ITEMS) {
    const meta = record.items?.[item.id];
    const blob = await getPhoto(record.id, item.id).catch(() => null);
    const imageHtml = blob ? `<img src="${URL.createObjectURL(blob)}" alt="${escapeHtml(item.name)}">` : '<div class="missing">이 기기에서 사진을 찾지 못했습니다.</div>';
    sections.push(`<h3>${escapeHtml(item.name)}</h3><small>${meta?.timestamp ? formatDateTime(meta.timestamp) : ''}</small>${imageHtml}`);
  }
  popup.document.body.innerHTML = `<h1>창신체크미</h1>${sections.join('')}`;
}

function renderSettings() {
  $('radiusInput').value = state.settings.radius;
  $('breakSelect').value = String(state.settings.breakMinutes);
  $('workshopInfo').textContent = state.settings.workshop ? `저장됨 · 반경 ${state.settings.radius}m` : '아직 저장되지 않음';
  $('shortcutUrlText').textContent = shortcutUrl();
  const ok = configured();
  $('firebaseStatus').textContent = ok ? 'Firebase 설정됨' : 'Firebase 설정 필요';
  $('firebaseDot').classList.toggle('on', ok);
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

  shareBusy = true;
  const oldText = button?.textContent || '공유하기';
  if (button) {
    button.disabled = true;
    button.textContent = '업로드 준비…';
  }
  toast('사진 7장을 업로드합니다');

  try {
    const { db, storage, auth } = await services();
    const id = generateId();
    const photos = [];

    for (let index = 0; index < ITEMS.length; index += 1) {
      const item = ITEMS[index];
      const meta = session.items[item.id];
      const blob = await getPhoto(session.id, item.id);
      if (!meta || !blob) throw new Error(`${item.name} 사진을 찾지 못했습니다`);
      if (button) button.textContent = `업로드 ${index + 1} / ${ITEMS.length}`;

      const path = `checks/${auth.currentUser.uid}/${id}/${item.id}.jpg`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, blob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=31536000' });
      photos.push({
        id: item.id,
        title: item.name,
        timestamp: meta.timestamp,
        url: await getDownloadURL(storageRef)
      });
    }

    await setDoc(doc(db, 'checks', id), {
      ownerUid: auth.currentUser.uid,
      public: true,
      completedAt: session.completedAt,
      startedAt: session.startedAt || null,
      photos,
      progress: 100,
      createdAt: serverTimestamp(),
      location: coords ? { accuracy: Math.round(coords.accuracy || 0) } : null
    });

    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('share', id);
    const shareUrl = url.toString();

    if (navigator.share) {
      try {
        await navigator.share({ title: '창신체크미 점검 기록', text: '작업실 퇴실 점검 사진입니다.', url: shareUrl });
        toast('공유 완료');
      } catch (error) {
        if (error?.name !== 'AbortError') throw error;
      }
    } else {
      await navigator.clipboard.writeText(shareUrl);
      toast('공유 링크가 복사됐습니다');
    }
  } catch (error) {
    console.error(error);
    toast(`업로드 실패 · ${firebaseErrorText(error)}`);
  } finally {
    shareBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = oldText;
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
