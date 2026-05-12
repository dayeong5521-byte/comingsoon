/* ── FIREBASE 초기화 ── */
firebase.initializeApp({
  apiKey:"AIzaSyBPqQtCUtYCIvwqi0qbifc2n-NFIlCteos",
  authDomain:"commingsoon-859cb.firebaseapp.com",
  projectId:"commingsoon-859cb",
  storageBucket:"commingsoon-859cb.firebasestorage.app",
  messagingSenderId:"937539044603",
  appId:"1:937539044603:web:1bb76b906028ad337f1c5e"
});
var fbAuth = firebase.auth();
var fbProvider = new firebase.auth.GoogleAuthProvider();
var db = firebase.firestore();

var TODAY = new Date().toISOString().split('T')[0];
var CY = new Date().getFullYear();
var FALLBACK = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80';

/* ── USER STATE ── */
var currentUser = null; 

/* ── DATA STATE ── */
var currentFilter = 'all';
var viewMode = 'grid';
var currentSort = 'imminent';
var currentTab = 'radar';

/* ── 안전한 문자열 처리 (Escape HTML) ── */
function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function archiveKey(p){return (p.brand||'')+'||'+(p.item_name||'')+'||'+(p.release_date||'');}

// 초기 데이터는 브라우저 로컬 스토리지에서 객체 배열로 불러옵니다.
var allItems = JSON.parse(localStorage.getItem('cs_allItems')||'[]');
var archivedItems = JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
var archivedIds = new Set(archivedItems.map(function(item) { return archiveKey(item); }));
var savedBrands = new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));

/* ── 하이브리드 동기화 함수 (병합 및 저장) ── */
function syncToCloud() {
  localStorage.setItem('cs_archivedItems', JSON.stringify(archivedItems));
  localStorage.setItem('cs_savedBrands', JSON.stringify(Array.from(savedBrands)));
  localStorage.setItem('cs_allItems', JSON.stringify(allItems));

  if (currentUser) {
    db.collection('users').doc(currentUser.uid).set({
      archivedItems: archivedItems,
      savedBrands: Array.from(savedBrands),
      allItems: allItems,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

function loadFromCloud(uid) {
  db.collection('users').doc(uid).get().then(function(doc) {
    if (doc.exists) {
      var data = doc.data();
      
      // 기존 로컬 데이터와 클라우드 데이터 병합 (중복 제거 처리)
      var cloudItems = data.allItems || [];
      var combinedItems = allItems.concat(cloudItems);
      var itemsMap = new Map();
      combinedItems.forEach(function(item) { itemsMap.set(archiveKey(item), item); });
      allItems = Array.from(itemsMap.values());
      
      archivedItems = data.archivedItems || [];
      archivedIds = new Set(archivedItems.map(function(item) { return archiveKey(item); }));
      savedBrands = new Set(data.savedBrands || []);
      
      syncToCloud(); 
    } else {
      syncToCloud();
    }
    
    rebuildNav();
    renderItems();
    renderArchive();
    updateArchiveCnt();
    
    runDailyAutoHunt();

  }).catch(function(e) {
    console.error("Firestore Error: ", e);
  });
}

/* ── MODAL ── */
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
document.querySelectorAll('.modal-bg').forEach(function(el){
  el.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});
});

function continueAsGuest(){
  closeModal('loginModalBg');
  showToast('게스트로 계속합니다. 아카이브는 브라우저에 임시 저장됩니다.');
}

function updateUserUI(){
  var av=document.getElementById('userAv');
  var uname=document.getElementById('userName');
  var urole=document.getElementById('userRole');
  var loginBtn=document.getElementById('loginBtnSb');
  if(currentUser){
    av.innerHTML=currentUser.name.charAt(0);
    uname.textContent=currentUser.name;
    urole.textContent=currentUser.email;
    loginBtn.textContent='로그아웃'; loginBtn.onclick=function(){ googleLogout(); };
    document.getElementById('archiveLoginBtn').style.display='none';
    document.getElementById('archiveMeta').style.display='flex';
  } else {
    av.innerHTML='?';
    uname.textContent='로그인이 필요해요';
    urole.textContent='게스트';
    loginBtn.textContent='로그인';
    loginBtn.onclick=function(){openModal('loginModalBg');};
    document.getElementById('archiveLoginBtn').style.display='flex';
    document.getElementById('archiveMeta').style.display='none';
  }
}

/* ── TOAST ── */
var toastTimer;
function showToast(msg){
  var t=document.getElementById('toast');
  document.getElementById('toastMsg').textContent=msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.classList.remove('show');},2600);
}

/* ── TABS ── */
function switchTab(tab){
  currentTab=tab;
  document.getElementById('radarPanel').style.display=tab==='radar'?'flex':'none';
  document.getElementById('archivePanel').style.display=tab==='archive'?'flex':'none';
  document.getElementById('navRadar').classList.toggle('active',tab==='radar');
  document.getElementById('navArchive').classList.toggle('active',tab==='archive');
  if(tab==='archive') renderArchive();
}

/* ── ARCHIVE TOGGLE ── */
function toggleArchive(p, el){
  var key = archiveKey(p);
  if(archivedIds.has(key)){
    archivedIds.delete(key);
    archivedItems = archivedItems.filter(function(item) { return archiveKey(item) !== key; });
    el.classList.remove('archived');
    showToast('아카이브에서 제거되었습니다.');
  } else {
    if(!currentUser){
      showToast('아카이브 저장은 로그인 후 이용 가능합니다.');
      openModal('loginModalBg');
      return;
    }
    archivedIds.add(key);
    archivedItems.push(p); 
    el.classList.add('archived');
    el.classList.add('archive-pop');
    setTimeout(function(){el.classList.remove('archive-pop');},400);
    showToast('"'+p.item_name+'" 아카이브에 추가됐어요 ✓');
  }
  syncToCloud(); 
  updateArchiveCnt();
  if(currentTab==='archive') renderArchive();
  renderItems(); 
}

function updateArchiveCnt(){
  var cnt=archivedIds.size;
  var el=document.getElementById('archiveCnt');
  el.textContent=cnt;
  el.style.display=cnt>0?'':'none';
  document.getElementById('archiveStatCount').textContent=cnt;
  
  var brands=new Set();
  archivedItems.forEach(function(p){ brands.add(p.brand); });
  document.getElementById('archiveStatBrands').textContent=brands.size;
  
  var upcoming=archivedItems.filter(function(p){ return isUrgent(p.release_date); }).length;
  document.getElementById('archiveStatUpcoming').textContent=upcoming;
}

/* ── ARCHIVE RENDER ── */
function renderArchive(){
  var ac=document.getElementById('archiveContent');
  if(!currentUser){
    ac.innerHTML='<div style="display:flex;justify-content:center;padding-top:60px;"><div class="archive-guest"><div class="archive-guest-icon"><svg width="26" height="26" viewBox="0 0 26 26" fill="none"><circle cx="13" cy="9" r="5" stroke="#BDBDBD" stroke-width="1.5"/><path d="M4 22c0-5 4-8 9-8s9 3 9 8" stroke="#BDBDBD" stroke-width="1.5" stroke-linecap="round"/></svg></div><div class="archive-guest-title">아카이브를 시작해볼까요?</div><div class="archive-guest-desc">로그인하면 발견한 릴리즈 정보를 내 아카이브에 저장하고, 어디서든 꺼내볼 수 있어요.</div><button class="archive-login-btn" onclick="openModal(\'loginModalBg\')"><svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M10 2 A8 8 0 1 1 10 18" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>Google로 로그인하기</button><button class="archive-login-btn-outline" onclick="continueAsGuest()">나중에 할게요</button></div></div>';
    return;
  }
  if(!archivedItems.length){
    ac.innerHTML='<div class="empty-state"><div class="empty-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="5" width="16" height="13" rx="2" stroke="#BDBDBD" stroke-width="1.4"/><path d="M2 9h16" stroke="#BDBDBD" stroke-width="1.4"/><path d="M7 13h6" stroke="#BDBDBD" stroke-width="1.4" stroke-linecap="round"/></svg></div><div class="empty-title">아카이브가 비어있어요</div><div class="empty-desc">릴리즈 카드의 <strong>🔖</strong> 버튼을 눌러<br>내 컬렉션에 담아보세요.</div></div>';
    return;
  }
  var html='<div class="card-grid">';
  archivedItems.forEach(function(p){ html += mkGrid(p); });
  ac.innerHTML=html+'</div>';
  bindCardEvents(ac);
}

/* ── NAV ── */
function rebuildNav(){
  var navList=document.getElementById('navList');
  var allRow=document.getElementById('allFilter');
  navList.innerHTML='';
  navList.appendChild(allRow);
  document.getElementById('allFilterCnt').textContent=allItems.length;
  document.getElementById('totalCnt').textContent=allItems.length;
  savedBrands.forEach(function(brand){
    var cnt=allItems.filter(function(p){return p.brand===brand;}).length;
    var row=document.createElement('div');
    row.className='nav-item'+(currentFilter===brand?' active':'');
    row.dataset.filter=brand;
    row.innerHTML='<div class="ni-left"><div class="ni-dot"></div><span class="ni-label"># '+brand+'</span></div><span class="ni-count">'+cnt+'</span>';
    row.onclick=function(){setFilter(brand);closeSidebar();};
    navList.appendChild(row);
  });
  allRow.classList.toggle('active',currentFilter==='all');
}
function setFilter(f){
  currentFilter=f;
  document.querySelectorAll('#navList .nav-item[data-filter]').forEach(function(el){el.classList.toggle('active',el.dataset.filter===f);});
  renderItems();
}
function saveCurrentKeyword(){
  var kw=document.getElementById('mainSearch').value.trim().toUpperCase();
  if(!kw)return;
  if(!currentUser){
    showToast('Focus Group 저장은 로그인 후 이용 가능합니다.');
    openModal('loginModalBg');
    return;
  }
  if(savedBrands.has(kw))savedBrands.delete(kw); else savedBrands.add(kw);
  syncToCloud(); 
  updateSaveKwBtn(); rebuildNav();
  showToast(savedBrands.has(kw)?'"'+kw+'" Focus Group에 추가됐어요 ✓':'"'+kw+'" Focus Group에서 제거됐어요.');
}
function updateSaveKwBtn(){
  var kw=document.getElementById('mainSearch').value.trim().toUpperCase();
  document.getElementById('saveKwBtn').classList.toggle('saved',savedBrands.has(kw));
}

/* ── HELPERS ── */
function isUrgent(d){return d&&(new Date(d)-new Date(TODAY))/86400000<=30;}
function dBadge(d){if(!d)return'';var diff=Math.ceil((new Date(d)-new Date(TODAY))/86400000);return diff>=0?'D-'+diff:'종료';}
function calURL(item){
  var t=encodeURIComponent('[COMING SOON] '+(item.brand||'')+' — '+(item.item_name||''));
  var d=(item.release_date||'').replace(/[^0-9]/g,'');
  var det=encodeURIComponent((item.description||'')+(item.link?'\n\n🔗 '+item.link:''));
  return'https://www.google.com/calendar/render?action=TEMPLATE&text='+t+'&dates='+d+'/'+d+'&details='+det;
}
function safeImg(url){return url&&url.startsWith('http')?url:FALLBACK;}

/* ── RENDER ── */
function getFiltered(){
  var list=currentFilter==='all'?allItems.slice():allItems.filter(function(p){return p.brand===currentFilter;});
  if(currentSort==='imminent')list.sort(function(a,b){return a.release_date<b.release_date?-1:1;});
  else list.sort(function(a,b){return a.release_date>b.release_date?-1:1;});
  return list;
}
function renderItems(){
  var list=getFiltered();
  document.getElementById('resultCount').textContent=list.length+'개 시그널';
  if(!list.length&&!allItems.length)return;
  if(!list.length){document.getElementById('content').innerHTML='<div class="empty-state"><div class="empty-title">결과 없음</div></div>';return;}
  var wrap=viewMode==='grid'?'card-grid':'card-list';
  var html='<div class="'+wrap+'">';
  list.forEach(function(p){html+=viewMode==='grid'?mkGrid(p):mkList(p);});
  var el=document.getElementById('content');
  el.innerHTML=html+'</div>';
  bindCardEvents(el);
}

var ARC_ICON='<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M1 5.5h11" stroke="currentColor" stroke-width="1.1"/><path d="M4.5 8h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

function mkGrid(p){
  var urg=isUrgent(p.release_date);
  var key=archiveKey(p);
  var safeKey=escapeHtml(key); 
  var isArc=archivedIds.has(key);
  return '<div class="pcard'+(isArc?' is-archived':'')+'" onclick="window.open(\''+escapeHtml(p.link||'#')+'\',\'_blank\')">'
    +'<div class="pcard-img-wrap">'
    +'<img class="pcard-img" src="'+safeImg(p.image_url)+'" loading="lazy" onerror="this.src=\''+FALLBACK+'\'">'
    +'<span class="pbadge '+(urg?'pb-hot':'pb-up')+'">'+dBadge(p.release_date)+'</span>'
    +'<button class="archive-btn'+(isArc?' archived':'')+'" data-key="'+safeKey+'" title="'+(isArc?'아카이브에서 제거':'내 아카이브에 저장')+'" onclick="event.stopPropagation()">'+ARC_ICON+'</button>'
    +'</div>'
    +'<div class="pcard-body">'
    +'<div class="pc-brand">'+escapeHtml(p.brand||'—')+'</div>'
    +'<div class="pc-name">'+escapeHtml(p.item_name||'')+'</div>'
    +'<div class="pc-foot">'
    +'<div><div class="pc-date-lbl">Coming Up</div><div class="pc-date'+(urg?' urg':'')+'">'+escapeHtml(p.release_date||'—')+'</div></div>'
    +'<a href="'+calURL(p)+'" target="_blank" onclick="event.stopPropagation()"><button class="cal-btn">Calendar +</button></a>'
    +'</div></div></div>';
}

function mkList(p){
  var urg=isUrgent(p.release_date);
  var key=archiveKey(p);
  var safeKey=escapeHtml(key); 
  var isArc=archivedIds.has(key);
  return '<div class="lcard" onclick="window.open(\''+escapeHtml(p.link||'#')+'\',\'_blank\')">'
    +'<img class="lcard-img" src="'+safeImg(p.image_url)+'" loading="lazy" onerror="this.src=\''+FALLBACK+'\'">'
    +'<div class="lcard-body"><div class="lc-brand">'+escapeHtml(p.brand||'—')+'</div>'
    +'<div class="lc-name">'+escapeHtml(p.item_name||'')+'</div>'
    +'<div class="lc-desc">'+escapeHtml(p.description||'')+'</div></div>'
    +'<div class="lcard-right">'
    +'<div><div class="lc-date-lbl">Coming Up</div><div class="lc-date'+(urg?' urg':'')+'">'+escapeHtml(p.release_date||'—')+'</div></div>'
    +'<a href="'+calURL(p)+'" target="_blank" onclick="event.stopPropagation()"><button class="lcal-btn">Calendar +</button></a>'
    +'<button class="larchive-btn'+(isArc?' archived':'')+'" data-key="'+safeKey+'" onclick="event.stopPropagation()">'+ARC_ICON+'</button>'
    +'</div></div>';
}

function bindCardEvents(container){
  container.querySelectorAll('.cal-btn,.lcal-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      if(!currentUser){
        showToast('캘린더 추가는 로그인 후 이용 가능합니다.');
        openModal('loginModalBg');
        return;
      }
      var prev=btn.innerHTML;
      btn.classList.add('added');btn.textContent='✓ 추가됨';
      setTimeout(function(){btn.classList.remove('added');btn.innerHTML=prev;},2000);
    });
  });
  
  container.querySelectorAll('.archive-btn,.larchive-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      var key=btn.dataset.key;
      var p=archivedItems.find(function(x){return archiveKey(x)===key;}) || allItems.find(function(x){return archiveKey(x)===key;});
      if(p) toggleArchive(p,btn);
    });
  });
}

function showSkeleton(){
  var html='<div class="skeleton-grid">';
  for(var i=0;i<6;i++) html+='<div class="sk-card"><div class="sk-img"></div><div class="sk-body"><div class="sk-line s"></div><div class="sk-line m"></div><div class="sk-line"></div></div></div>';
  document.getElementById('content').innerHTML=html+'</div>';
}
function setStatus(msg,on){
  document.getElementById('statusMsg').textContent=msg;
  document.getElementById('statusBar').classList.toggle('on',!!on);
}

/* ── HUNT — 데이터 누적(Accumulation) 로직 ── */
async function startHunt(autoKeyword){
  var kw = autoKeyword || document.getElementById('mainSearch').value.trim();
  if(!kw){document.getElementById('mainSearch').focus();return 0;}
  
  if(autoKeyword) document.getElementById('mainSearch').value = kw;

  var btn=document.getElementById('huntBtn');
  btn.disabled=true;btn.textContent='탐색 중...';
  
  currentFilter = 'all'; 
  rebuildNav();
  showSkeleton();
  setStatus("'"+kw+"' 수색 중...",true);

  var newlyAddedCount = 0; 

  try{
    var res=await fetch('/api/hunt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:kw})});
    if(!res.ok){var e=await res.json();throw new Error(e.error||'서버 오류 '+res.status);}
    var reader=res.body.getReader();
    var decoder=new TextDecoder();
    var buf='';
    var foundAny = false;

    while(true){
      var chunk=await reader.read();
      if(chunk.done)break;
      buf+=decoder.decode(chunk.value,{stream:true});
      var parts=buf.split('\n\n');buf=parts.pop();

      for(var i=0;i<parts.length;i++){
        var line=parts[i];
        if(!line.startsWith('data: '))continue;
        try{
          var ev=JSON.parse(line.slice(6));
          if(ev.type==='status') setStatus(ev.message,true);
          else if(ev.type==='item'){
            foundAny = true;
            var itemKey = archiveKey(ev.data);
            if(!allItems.some(function(x){ return archiveKey(x) === itemKey; })) {
              allItems.push(ev.data);
              newlyAddedCount++; 
            }
            rebuildNav(); renderItems();
          }
          else if(ev.type==='done') setStatus('탐색 완료! '+ev.total+'개 시그널 확보.',false);
          else if(ev.type==='error') throw new Error(ev.message);
        }catch(e){if(e.message&&!e.message.includes('JSON'))throw e;}
      }
    }
    
    if(!foundAny && allItems.length === 0) {
      document.getElementById('content').innerHTML='<div class="empty-state"><div class="empty-title">결과를 찾지 못했습니다</div><div class="empty-desc">다른 키워드로 시도해보세요.</div></div>';
    } else if (!foundAny && !autoKeyword) {
      showToast('새로운 시그널을 찾지 못했습니다.');
      renderItems(); 
    }
  }catch(err){
    setStatus('',false);
    showToast('오류 발생: ' + err.message);
    renderItems(); 
  }finally{
    syncToCloud(); 
    btn.disabled=false;
    btn.innerHTML='<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4.5" stroke="white" stroke-width="1.2"/><circle cx="5.5" cy="5.5" r="1.8" fill="white"/></svg> 발견하기';
  }
  
  return newlyAddedCount; 
}

/* ── AUTO HUNT (일일 자동 수색 및 알림) ── */
async function runDailyAutoHunt() {
  if (savedBrands.size === 0) return;

  var lastHunt = localStorage.getItem('last_auto_hunt');
  var today = new Date().toISOString().split('T')[0];

  if (lastHunt === today) return;

  showToast("📅 데일리 자동 레이더 가동 중...");
  var brandsArray = Array.from(savedBrands);
  var totalNewFound = 0;
  
  for (var i = 0; i < brandsArray.length; i++) {
    var brand = brandsArray[i];
    try {
      var newCnt = await startHunt(brand);
      totalNewFound += (newCnt || 0);
    } catch (e) {
      console.error(brand + " 자동 수색 오류", e);
    }
    await new Promise(function(resolve) { setTimeout(resolve, 2500); });
  }
  
  document.getElementById('mainSearch').value = ''; 
  localStorage.setItem('last_auto_hunt', today); 

  if (totalNewFound > 0) {
    showToast("🔔 포커스 그룹에서 " + totalNewFound + "개의 새로운 릴리즈를 발견했습니다!");
  } else {
    showToast("✅ 자동 업데이트 완료 (새로운 소식 없음)");
  }
}

/* ── CONTROLS ── */
document.getElementById('mainSearch').addEventListener('keydown',function(e){if(e.key==='Enter')startHunt();});
document.getElementById('mainSearch').addEventListener('input',updateSaveKwBtn);
document.getElementById('btnGrid').addEventListener('click',function(){viewMode='grid';this.classList.add('on');document.getElementById('btnList').classList.remove('on');renderItems();});
document.getElementById('btnList').addEventListener('click',function(){viewMode='list';this.classList.add('on');document.getElementById('btnGrid').classList.remove('on');renderItems();});
document.querySelectorAll('[data-sort]').forEach(function(b){b.addEventListener('click',function(){currentSort=b.dataset.sort;document.querySelectorAll('[data-sort]').forEach(function(x){x.classList.remove('on');});b.classList.add('on');renderItems();});});
document.getElementById('sbSearch').addEventListener('input',function(){
  var q=this.value.toLowerCase().trim();
  document.querySelectorAll('#navList .nav-item[data-filter]').forEach(function(el){el.style.display=(!q||el.querySelector('.ni-label').textContent.toLowerCase().includes(q))?'':'none';});
});
function closeSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('overlay').classList.remove('open');}
document.getElementById('mobToggle').addEventListener('click',function(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('overlay').classList.toggle('open');});
document.getElementById('overlay').addEventListener('click',closeSidebar);

/* ── GOOGLE AUTH (하이브리드 동기화 연동) ── */
function googleLogin() {
  fbAuth.signInWithPopup(fbProvider).then(function(r) {
    var u = r.user;
    currentUser = { name: u.displayName, email: u.email, photo: u.photoURL, uid: u.uid };
    updateUserUI();
    closeModal('loginModalBg');
    showToast(u.displayName + '님, 환영해요 ✓');
  }).catch(function(e) {
    if (e.code !== 'auth/popup-closed-by-user') showToast('로그인 실패: ' + e.message);
  });
}

function googleLogout() {
  fbAuth.signOut().then(function() {
    currentUser = null;
    updateUserUI();
    showToast('로그아웃됐어요.');
  });
}

fbAuth.onAuthStateChanged(function(u) {
  if (u) {
    currentUser = { name: u.displayName, email: u.email, photo: u.photoURL, uid: u.uid };
    loadFromCloud(u.uid); 
  } else {
    currentUser = null;
    
    archivedItems = JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
    archivedIds = new Set(archivedItems.map(function(item) { return archiveKey(item); }));
    savedBrands = new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));
    allItems = JSON.parse(localStorage.getItem('cs_allItems')||'[]');
    
    rebuildNav();
    renderItems();
    renderArchive();
    updateArchiveCnt();
    
    runDailyAutoHunt();
  }
  
  if (typeof updateUserUI === 'function') { updateUserUI(); }
});
