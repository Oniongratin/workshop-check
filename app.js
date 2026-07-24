import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';

const ITEMS=[
{id:'f1_ac',name:'1층 에어컨',icon:'▱'},{id:'f1_in',name:'1층 실내조명',icon:'◉'},{id:'f1_out',name:'1층 실외조명',icon:'◌'},{id:'f1_lock',name:'1층 문잠금',icon:'▣'},
{id:'f2_ac',name:'2층 에어컨',icon:'▱'},{id:'f2_in',name:'2층 실내조명',icon:'◉'},{id:'f2_lock',name:'2층 문잠금',icon:'▣'}];
const KEY='changsinCheckMe_v4';
const DEFAULT={current:null,history:[],settings:{workshop:null,radius:120,breakMinutes:30,breakUntil:null},view:'checkView'};
let state=load(); let activeItem=null; let coords=null; let lastAlert=0; let fb=null;
const $=id=>document.getElementById(id); const $$=s=>[...document.querySelectorAll(s)];

function newSession(){return{id:`s_${Date.now()}`,startedAt:new Date().toISOString(),items:{},completedAt:''}}
function load(){try{return{...DEFAULT,...JSON.parse(localStorage.getItem(KEY)||'{}')}}catch{return structuredClone(DEFAULT)}}
function save(){localStorage.setItem(KEY,JSON.stringify(state))}
function clone(v){return JSON.parse(JSON.stringify(v))}
if(!state.current)state.current=newSession(); save();

async function renderPublic(){const id=new URLSearchParams(location.search).get('share');if(!id)return false;document.body.innerHTML='<div class="loading-card">기록을 불러오는 중...</div>';try{const {db}=await services();const snap=await getDoc(doc(db,'shares',id));if(!snap.exists())throw new Error();const d=snap.data();document.body.innerHTML=`<main class="public-wrap"><header class="top"><div class="brand"><div class="mark"><span>창신✓</span></div><div class="title"><h1>창신체크미 기록</h1><p>${new Date(d.completedAt).toLocaleString('ko-KR')}</p></div></div></header>${d.photos.map(p=>`<section class="public-photo"><h3>${escapeHtml(p.title)}</h3><img src="${p.url}" alt="${escapeHtml(p.title)}"><div class="public-meta">${new Date(p.timestamp).toLocaleString('ko-KR')}</div></section>`).join('')}</main>`}catch{document.body.innerHTML='<div class="loading-card">기록을 불러오지 못했습니다.</div>'}return true}
if(await renderPublic())throw new Error('public');

setup(); render(); watchLocation();

function setup(){
 $('cameraInput').addEventListener('change',onPhoto);
 $('breakBtn').addEventListener('click',toggleBreak); $('shareBtn').addEventListener('click',()=>shareSession(state.current));
 $('quickSettings').addEventListener('click',()=>switchView('settingsView'));
 $('saveWorkshopBtn').addEventListener('click',saveWorkshop); $('clearWorkshopBtn').addEventListener('click',()=>{state.settings.workshop=null;save();render()});
 $('radiusInput').addEventListener('change',e=>{state.settings.radius=Math.max(30,Math.min(500,+e.target.value||120));save()});
 $('breakSelect').addEventListener('change',e=>{state.settings.breakMinutes=+e.target.value;save()});
 $('newSessionBtn').addEventListener('click',()=>{if(Object.keys(state.current.items).length&&!confirm('현재 점검을 지울까요?'))return;state.current=newSession();save();render();switchView('checkView')});
 $$('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
 $('completeClose').addEventListener('click',()=>{$('completeScreen').classList.remove('show');switchView('checkView')});
 $('completeHistory').addEventListener('click',()=>{$('completeScreen').classList.remove('show');switchView('historyView')});
}
function switchView(id){state.view=id;save();$$('.view').forEach(v=>v.classList.toggle('active',v.id===id));$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===id))}
function render(){renderProgress();renderItems();renderHistory();renderSettings();switchView(state.view||'checkView')}
function renderProgress(){const n=Object.keys(state.current.items).length,p=Math.round(n/ITEMS.length*100);$('percent').textContent=p;$('countText').textContent=`${n} / ${ITEMS.length} 완료`;$('progressFill').style.width=`${p}%`;$('statusText').textContent=state.current.completedAt?'완료':isBreak()?'잠시 외출 중':'점검 중';$('breakBtn').textContent=isBreak()?'외출 해제':'잠시 외출'}
function renderItems(){$('itemList').innerHTML=ITEMS.map(i=>{const x=state.current.items[i.id];return`<button class="item ${x?'done':''}" data-id="${i.id}"><span class="item-icon">${i.icon}</span><span class="item-main"><span class="item-name">${i.name}</span><span class="item-meta">${x?new Date(x.timestamp).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})+' 촬영':'탭하여 촬영'}</span></span><span class="state">${x?'✓':''}</span></button>`}).join('');$$('[data-id]').forEach(b=>b.addEventListener('click',()=>{if(state.current.completedAt)return toast('새 점검을 시작해 주세요');activeItem=b.dataset.id;$('cameraInput').value='';$('cameraInput').click()}))}
async function onPhoto(){const file=$('cameraInput').files?.[0];if(!file||!activeItem)return;const image=await compress(file);const item=ITEMS.find(i=>i.id===activeItem);state.current.items[activeItem]={title:item.name,timestamp:new Date().toISOString(),image};save();navigator.vibrate?.([70,30,70]);const n=Object.keys(state.current.items).length,p=Math.round(n/ITEMS.length*100);toast(`${p}% 완료`);activeItem=null;if(n===ITEMS.length&&!state.current.completedAt)complete();render()}
function complete(){state.current.completedAt=new Date().toISOString();state.history.unshift(clone(state.current));state.history=state.history.slice(0,12);save();navigator.vibrate?.([100,50,100,50,160]);$('completeScreen').classList.add('show')}
function renderHistory(){if(!state.history.length){$('historyList').innerHTML='<div class="card"><p>아직 완료 기록이 없습니다.</p></div>';return}$('historyList').innerHTML=state.history.map(r=>`<article class="card"><h3>${new Date(r.completedAt).toLocaleDateString('ko-KR')}</h3><p>${new Date(r.completedAt).toLocaleTimeString('ko-KR')} · 7개 완료</p><div class="photos">${ITEMS.slice(0,3).map(i=>`<img src="${r.items[i.id]?.image||''}" alt="">`).join('')}</div><div class="card-actions"><button class="small-btn" data-view-record="${r.id}">사진 보기</button><button class="small-btn white" data-share-record="${r.id}">공유</button></div></article>`).join('');$$('[data-view-record]').forEach(b=>b.onclick=()=>showRecord(b.dataset.viewRecord));$$('[data-share-record]').forEach(b=>b.onclick=()=>shareSession(state.history.find(r=>r.id===b.dataset.shareRecord)))}
function showRecord(id){const r=state.history.find(x=>x.id===id);if(!r)return;const w=open('','_blank');w.document.write(`<meta name="viewport" content="width=device-width"><style>body{background:#000;color:#fff;font-family:-apple-system;padding:18px}img{width:100%;border-radius:14px;margin:8px 0 24px}small{color:#888}</style><h1>창신체크미</h1>${ITEMS.map(i=>`<h3>${i.name}</h3><small>${new Date(r.items[i.id].timestamp).toLocaleString('ko-KR')}</small><img src="${r.items[i.id].image}">`).join('')}`)}
function renderSettings(){$('radiusInput').value=state.settings.radius;$('breakSelect').value=String(state.settings.breakMinutes);$('workshopInfo').textContent=state.settings.workshop?`저장됨 · 반경 ${state.settings.radius}m`:'아직 저장되지 않음'}
function toggleBreak(){if(isBreak())state.settings.breakUntil=null;else state.settings.breakUntil=new Date(Date.now()+state.settings.breakMinutes*60000).toISOString();save();render();toast(isBreak()?'잠시 외출 켜짐':'잠시 외출 해제')}
function isBreak(){return state.settings.breakUntil&&new Date(state.settings.breakUntil)>new Date()}
function saveWorkshop(){navigator.geolocation.getCurrentPosition(p=>{state.settings.workshop={lat:p.coords.latitude,lng:p.coords.longitude};save();render();toast('작업실 위치 저장됨')},()=>toast('위치 권한을 확인해 주세요.'),{enableHighAccuracy:true})}
function watchLocation(){if(!navigator.geolocation)return;navigator.geolocation.watchPosition(p=>{coords=p.coords;checkLeave()},()=>{},{enableHighAccuracy:true,maximumAge:30000})}
function checkLeave(){if(!coords||!state.settings.workshop||isBreak()||state.current.completedAt)return;const d=distance(coords.latitude,coords.longitude,state.settings.workshop.lat,state.settings.workshop.lng);if(d>state.settings.radius&&Date.now()-lastAlert>180000){lastAlert=Date.now();navigator.vibrate?.([180,80,180]);toast(`작업실에서 ${Math.round(d)}m 벗어남`);if(Notification.permission==='granted')new Notification('창신체크미',{body:'아직 퇴실 점검이 끝나지 않았습니다.'})}}
function distance(a,b,c,d){const R=6371000,x=(c-a)*Math.PI/180,y=(d-b)*Math.PI/180,q=Math.sin(x/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(y/2)**2;return 2*R*Math.atan2(Math.sqrt(q),Math.sqrt(1-q))}
function toast(t){$('toast').textContent=t;$('toast').classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').classList.remove('show'),1500)}
function compress(file){return new Promise((res,rej)=>{const im=new Image(),u=URL.createObjectURL(file);im.onload=()=>{const m=1200,s=Math.min(1,m/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=im.width*s;c.height=im.height*s;c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',.72))};im.onerror=rej;im.src=u})}
function configured(){return firebaseConfig?.apiKey&&!firebaseConfig.apiKey.includes('여기에_')}
async function services(){if(fb)return fb;if(!configured())throw new Error('Firebase 설정 필요');const app=initializeApp(firebaseConfig);fb={auth:getAuth(app),db:getFirestore(app),storage:getStorage(app)};if(!fb.auth.currentUser)await signInAnonymously(fb.auth);return fb}
async function shareSession(s){if(!s.completedAt)return toast('7개를 모두 완료해 주세요');if(!configured()){const text=`창신체크미 점검 완료\n${new Date(s.completedAt).toLocaleString('ko-KR')}`;return navigator.share?navigator.share({title:'창신체크미',text}):navigator.clipboard.writeText(text)}toast('공유 링크 만드는 중');try{const {db,storage}=await services(),id=crypto.randomUUID().replaceAll('-',''),photos=[];for(const item of ITEMS){const p=s.items[item.id],blob=dataBlob(p.image),path=`shares/${id}/${item.id}.jpg`,r=ref(storage,path);await uploadBytes(r,blob,{contentType:'image/jpeg'});photos.push({title:item.name,timestamp:p.timestamp,url:await getDownloadURL(r)})}await setDoc(doc(db,'shares',id),{completedAt:s.completedAt,photos,createdAt:serverTimestamp()});const url=`${location.origin}${location.pathname}?share=${id}`;if(navigator.share)await navigator.share({title:'창신체크미 기록',text:'사진 기록을 확인하세요.',url});else{await navigator.clipboard.writeText(url);toast('링크 복사됨')}}catch(e){toast('공유 설정을 확인해 주세요')}}
function dataBlob(d){const [h,b]=d.split(','),m=h.match(/:(.*?);/)[1],bin=atob(b),a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type:m})}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js');
