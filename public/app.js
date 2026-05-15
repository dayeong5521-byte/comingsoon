/* ── FIREBASE ── */
firebase.initializeApp({
  apiKey:"AIzaSyBPqQtCUtYCIvwqi0qbifc2n-NFIlCteos",
  authDomain:"commingsoon-859cb.firebaseapp.com",
  projectId:"commingsoon-859cb",
  storageBucket:"commingsoon-859cb.firebasestorage.app",
  messagingSenderId:"937539044603",
  appId:"1:937539044603:web:1bb76b906028ad337f1c5e"
});
var fbAuth=firebase.auth();
var fbProvider=new firebase.auth.GoogleAuthProvider();
var db=firebase.firestore();

var TODAY=new Date().toISOString().split('T')[0];
var FALLBACK='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80';

/* ══════════════════════════════════════════
   STATE — 새 데이터 구조
   keywordData: { "Nike": [item, ...], "BTS": [...] }
   전체 = savedBrands의 모든 keywordData 합산
   currentSearchItems = 검색 결과 (임시, 저장 전엔 radar에만 표시)
══════════════════════════════════════════ */
var currentUser=null;
var currentView='radar';
var viewMode='grid';
var sortMode='imminent';
var currentSearchItems=[];  // 임시 검색 결과 (radar 전용)

var keywordData=JSON.parse(localStorage.getItem('cs_keywordData')||'{}');
var archivedItems=JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
var archivedIds=new Set(archivedItems.map(function(i){ return archiveKey(i); }));
var savedBrands=new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));
var newBadgeCounts={};

/* 구 데이터 마이그레이션 (cs_allItems → cs_keywordData) */
(function migrate(){
  var old=JSON.parse(localStorage.getItem('cs_allItems')||'[]');
  if(old.length>0&&Object.keys(keywordData).length===0){
    old.forEach(function(item){
      if(item.brand&&savedBrands.has(item.brand)){
        if(!keywordData[item.brand]) keywordData[item.brand]=[];
        var k=archiveKey(item);
        if(!keywordData[item.brand].some(function(x){ return archiveKey(x)===k; })){
          keywordData[item.brand].push(item);
        }
      }
    });
    localStorage.removeItem('cs_allItems');
  }
})();

/* ── 유틸 ── */
function archiveKey(p){ return (p.brand||'')+'||'+(p.item_name||'')+'||'+(p.release_date||''); }
function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function daysUntil(d){ return Math.ceil((new Date(d)-new Date(TODAY))/86400000); }
function formatDateDot(dateStr){
  if(!dateStr) return '';
  var d=new Date(dateStr);
  return d.getFullYear()+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getDate()).padStart(2,'0');
}
function makeCalUrl(p){
  var d=p.release_date.replace(/-/g,'');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    +'&text='+encodeURIComponent('[출시] '+p.brand+' '+p.item_name)
    +'&dates='+d+'/'+d
    +'&details='+encodeURIComponent(p.description||'');
}

/* 전체 아이템 = 저장된 키워드 데이터 합산 */
function getAllItems(){
  var all=[],seen=new Set();
  savedBrands.forEach(function(kw){
    (keywordData[kw]||[]).forEach(function(item){
      var k=archiveKey(item);
      if(!seen.has(k)){ seen.add(k); all.push(item); }
    });
  });
  return all;
}

/* 특정 키워드 아이템 */
function getBrandItems(brand){ return keywordData[brand]||[]; }

var archiveSortMode='imminent';

/* ── 저장 배너 ── */
function showSavePrompt(kw){
  var el=document.getElementById('savePrompt');
  var kwEl=document.getElementById('savePromptKeyword');
  if(!el) return;
  if(kwEl) kwEl.textContent='"'+kw+'"';
  el.style.display='flex';
}
function hideSavePrompt(){
  var el=document.getElementById('savePrompt');
  if(el) el.style.display='none';
}
function showToast(msg){
  var t=document.getElementById('toast'),m=document.getElementById('toastMsg');
  if(!t||!m) return;
  m.textContent=msg; t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); },3000);
}

/* ── 상태바 ── */
function setStatus(msg,show){
  var bar=document.getElementById('statusBar'),txt=document.getElementById('statusMsg');
  if(!bar) return;
  bar.style.display=show?'flex':'none';
  if(txt&&show) txt.textContent=msg;
}

/* ── 모달 ── */
function openModal(id){ var el=document.getElementById(id); if(el) el.style.display='flex'; }
function closeModal(id){ var el=document.getElementById(id); if(el) el.style.display='none'; }

/* ── 로그인 게이트 — 로그인 필요 시 팝업 ── */
function requireLogin(action){
  if(!currentUser){ openModal('loginModalBg'); return false; }
  if(action) action();
  return true;
}

/* ── 사이드바 ── */
function closeSidebar(){
  var sb=document.getElementById('sidebar'),ov=document.getElementById('overlay');
  if(sb) sb.classList.remove('open'); if(ov) ov.classList.remove('open');
}
function openSidebar(){
  var sb=document.getElementById('sidebar'),ov=document.getElementById('overlay');
  if(sb) sb.classList.add('open'); if(ov) ov.classList.add('open');
}

/* ── 인증 ── */
function googleLogin(){ fbAuth.signInWithPopup(fbProvider).catch(function(e){ showToast('로그인 실패: '+e.message); }); }
function continueAsGuest(){ closeModal('loginModalBg'); }
function logout(){ fbAuth.signOut().then(function(){ currentUser=null; updateUserUI(); showToast('로그아웃 되었습니다.'); }); }

/* ── 유저 UI ── */
function updateUserUI(){
  var nameEl=document.getElementById('userName');
  var roleEl=document.getElementById('userRole');
  var avEl=document.getElementById('userAv');
  var loginBtn=document.getElementById('loginBtnSb');
  if(currentUser){
    if(nameEl) nameEl.textContent=currentUser.name||currentUser.email;
    if(roleEl) roleEl.textContent=currentUser.email;
    if(avEl)   avEl.textContent=(currentUser.name||'U')[0].toUpperCase();
    if(loginBtn){ loginBtn.textContent='로그아웃'; loginBtn.onclick=logout; }
    closeModal('loginModalBg');
  } else {
    if(nameEl) nameEl.textContent='로그인이 필요해요';
    if(roleEl) roleEl.textContent='게스트';
    if(avEl)   avEl.textContent='?';
    if(loginBtn){ loginBtn.textContent='로그인'; loginBtn.onclick=function(){ openModal('loginModalBg'); }; }
  }
  var alb=document.getElementById('archiveLoginBtn');
  var am=document.getElementById('archiveMeta');
  if(alb) alb.style.display=currentUser?'none':'flex';
  if(am)  am.style.display=currentUser?'flex':'none';
}

/* ── 검색창/헤더 전환 ── */
function updateLayoutForView(viewType){
  var searchHdr=document.getElementById('searchHeader');
  var focusHdr=document.getElementById('focusGroupHeader');
  var focusTitle=document.getElementById('focusGroupTitle');
  /* radar만 검색창, 나머지는 타이틀 헤더 */
  if(searchHdr) searchHdr.style.display=(viewType==='radar')?'flex':'none';
  if(focusHdr){
    var show=(viewType!=='radar'&&viewType!=='archive');
    if(show){
      focusHdr.classList.add('show');
      if(focusTitle) focusTitle.textContent=(viewType==='all')?'전체':'# '+viewType;
    } else {
      focusHdr.classList.remove('show');
    }
  }
}

/* ── 탭 전환 ── */
function switchView(viewType){
  currentView=viewType;
  document.getElementById('radarPanel').style.display  =(viewType==='archive')?'none':'flex';
  document.getElementById('archivePanel').style.display=(viewType==='archive')?'flex':'none';
  updateLayoutForView(viewType);
  if(viewType==='radar'){
    renderItems(getSortedItems(currentSearchItems));
  } else if(viewType==='all'){
    renderItems(getSortedItems(getAllItems()));
  } else if(viewType==='archive'){
    renderArchive();
  } else {
    renderItems(getSortedItems(getBrandItems(viewType)));
    newBadgeCounts[viewType]=0;
  }
  rebuildNav(); closeSidebar();
}

function getDisplayList(){
  if(currentView==='radar')   return currentSearchItems;
  if(currentView==='all')     return getAllItems();
  if(currentView==='archive') return archivedItems;
  return getBrandItems(currentView);
}

/* ── 정렬 ── */
function getSortedItems(list){
  return list.slice().sort(function(a,b){
    return sortMode==='imminent'
      ? a.release_date.localeCompare(b.release_date)
      : b.release_date.localeCompare(a.release_date);
  });
}

/* ── 출시된 아이템 자동 삭제 ── */
function cleanupReleasedItems(){
  var changed=false;
  savedBrands.forEach(function(kw){
    if(!keywordData[kw]) return;
    var before=keywordData[kw].length;
    keywordData[kw]=keywordData[kw].filter(function(item){
      if(item.release_date<TODAY){
        var k=archiveKey(item);
        archivedIds.delete(k);
        archivedItems=archivedItems.filter(function(a){ return archiveKey(a)!==k; });
        return false;
      }
      return true;
    });
    if(keywordData[kw].length!==before) changed=true;
  });
  if(changed) syncToCloud();
}

/* ── 백그라운드 트래킹 ── */
async function runSilentAutoHunt(){
  if(savedBrands.size===0) return;
  if(localStorage.getItem('last_auto_hunt')===TODAY) return;
  var totalNew=0;
  for(var brand of Array.from(savedBrands)){
    try{
      var res=await fetch('/api/hunt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:brand})});
      if(!res.ok) continue;
      var reader=res.body.getReader(),decoder=new TextDecoder(),buf='';
      while(true){
        var chunk=await reader.read(); if(chunk.done) break;
        buf+=decoder.decode(chunk.value,{stream:true});
        var parts=buf.split('\n\n'); buf=parts.pop();
        for(var line of parts){
          if(!line.startsWith('data: ')) continue;
          var ev=JSON.parse(line.slice(6));
          if(ev.type==='item'){
            /* 키워드 데이터에 직접 저장 */
            if(!keywordData[brand]) keywordData[brand]=[];
            var tagged=Object.assign({},ev.data,{brand:brand});
            var key=archiveKey(tagged);
            if(!keywordData[brand].some(function(x){ return archiveKey(x)===key; })){
              keywordData[brand].push(tagged);
              newBadgeCounts[brand]=(newBadgeCounts[brand]||0)+1;
              totalNew++;
            }
          }
        }
      }
      rebuildNav();
    } catch(e){ console.error(e); }
    await new Promise(function(r){ setTimeout(r,2000); });
  }
  localStorage.setItem('last_auto_hunt',TODAY);
  syncToCloud();
  if(totalNew>0) showToast('🔔 포커스 그룹에 새로운 소식이 도착했습니다.');
}

/* ── 키워드 삭제 ── */
function deleteKeyword(brand, e){
  e.stopPropagation();
  if(!confirm('"'+brand+'" 키워드를 삭제할까요?\n저장된 데이터도 함께 삭제돼요.')) return;
  savedBrands.delete(brand);
  delete keywordData[brand];
  // 해당 키워드 아카이브 항목도 정리
  archivedItems=archivedItems.filter(function(p){ return p.brand!==brand; });
  archivedIds=new Set(archivedItems.map(function(p){ return archiveKey(p); }));
  syncToCloud();
  if(currentView===brand) switchView('radar');
  else rebuildNav();
  showToast('"'+brand+'" 키워드가 삭제됐어요.');
}

/* ── NAV 재빌드 ── */
function rebuildNav(){
  var navList=document.getElementById('navList');
  var allRow=document.getElementById('allFilter');
  navList.innerHTML=''; navList.appendChild(allRow);

  savedBrands.forEach(function(brand){
    var newCnt=newBadgeCounts[brand]||0;  // ★ 새 소식만
    var row=document.createElement('div');
    row.className='nav-item nav-item-brand'+(currentView===brand?' active':'');
    row.innerHTML=
      '<div class="ni-left">'+
        '<div class="ni-dot"></div>'+
        '<span class="ni-label"># '+escapeHtml(brand)+'</span>'+
      '</div>'+
      '<div class="ni-right">'+
        // ★ 새 소식 있을 때만 뱃지 표시 (총 갯수 아님)
        (newCnt>0?'<span class="ni-badge">'+newCnt+'</span>':'')+
        '<button class="ni-delete" onclick="deleteKeyword(\''+escapeHtml(brand)+'\',event)" title="삭제">'+
          '<svg viewBox="0 0 10 10" fill="none"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'+
        '</button>'+
      '</div>';
    row.onclick=function(){ switchView(brand); };
    navList.appendChild(row);
  });

  /* 전체 뱃지 — 새 소식 합산만 표시 */
  var oldBadge=allRow.querySelector('.ni-badge');
  if(oldBadge) oldBadge.remove();
  allRow.className='nav-item nav-item-brand'+(currentView==='all'?' active':'');
  var totalNew=Object.values(newBadgeCounts).reduce(function(s,v){ return s+v; },0);
  if(totalNew>0){
    var b=document.createElement('span'); b.className='ni-badge'; b.textContent=totalNew;
    allRow.appendChild(b);
  }

  document.getElementById('navRadar').classList.toggle('active',  currentView==='radar');
  document.getElementById('navArchive').classList.toggle('active',currentView==='archive');
}

/* ── 클라우드 동기화 ── */
function syncToCloud(){
  localStorage.setItem('cs_keywordData',  JSON.stringify(keywordData));
  localStorage.setItem('cs_archivedItems',JSON.stringify(archivedItems));
  localStorage.setItem('cs_savedBrands',  JSON.stringify(Array.from(savedBrands)));
  if(currentUser){
    db.collection('users').doc(currentUser.uid).set({
      keywordData:keywordData,
      archivedItems:archivedItems,
      savedBrands:Array.from(savedBrands),
      lastUpdated:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }
}

/* ── 키워드 저장 — 로그인 필요, 검색 결과 자동 연결 ── */
function saveCurrentKeyword(){
  /* 로그인 필요 */
  if(!currentUser){ openModal('loginModalBg'); return; }

  var kw=document.getElementById('mainSearch').value.trim();
  if(!kw){ showToast('키워드를 먼저 입력해주세요.'); return; }
  if(savedBrands.has(kw)){ showToast('이미 저장된 키워드예요.'); return; }

  /* 현재 검색 결과를 이 키워드로 태깅해서 저장 */
  keywordData[kw]=currentSearchItems.map(function(item){
    return Object.assign({},item,{brand:kw});
  });
  savedBrands.add(kw);
  syncToCloud(); rebuildNav();
  hideSavePrompt();
  var saveBtn=document.getElementById('saveKwBtn');
  if(saveBtn) saveBtn.classList.remove('has-results');
  var cnt=keywordData[kw].length;
  showToast('✅ "'+kw+'" 저장됨'+(cnt>0?' ('+cnt+'개 항목)':''));
  switchView(kw);
}

/* ── 검색 — currentSearchItems만 업데이트, keywordData에 저장 안 함 ── */
async function startHunt(){
  var kw=document.getElementById('mainSearch').value.trim();
  if(!kw) return;
  var btn=document.getElementById('huntBtn');
  btn.disabled=true; btn.textContent='탐색 중...';
  setStatus("'"+kw+"' 수색 중...",true);
  /* 검색할 때마다 radar 초기화 */
  currentSearchItems=[]; renderItems([]);
  try{
    var res=await fetch('/api/hunt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:kw})});
    if(!res.ok){ var err=await res.json().catch(function(){return{};}); throw new Error(err.error||'API 오류 ('+res.status+')'); }
    var reader=res.body.getReader(),decoder=new TextDecoder(),buf='';
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      buf+=decoder.decode(chunk.value,{stream:true});
      var parts=buf.split('\n\n'); buf=parts.pop();
      for(var line of parts){
        if(!line.startsWith('data: ')) continue;
        var ev=JSON.parse(line.slice(6));
        if(ev.type==='status') setStatus(ev.message,true);
        if(ev.type==='item'){
          /* radar(임시)에만 추가 — keywordData에는 저장 안 함 */
          if(!currentSearchItems.some(function(x){ return archiveKey(x)===archiveKey(ev.data); })){
            currentSearchItems.push(ev.data);
          }
          renderItems(getSortedItems(currentSearchItems));
        }
        if(ev.type==='error') showToast('오류: '+ev.message);
      }
    }
  } catch(e){ showToast('오류: '+e.message); }
  finally{
    btn.disabled=false;
    btn.innerHTML='<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="white" stroke-width="1.3"/><circle cx="6" cy="6" r="2" fill="white"/></svg> 발견하기';
    setStatus('',false);
    // 검색 결과 있으면 저장 배너 + 별 버튼 강조
    if(currentSearchItems.length>0){
      var kw2=document.getElementById('mainSearch').value.trim();
      if(kw2&&!savedBrands.has(kw2)){
        showSavePrompt(kw2);
        var saveBtn=document.getElementById('saveKwBtn');
        if(saveBtn) saveBtn.classList.add('has-results');
      }
    }
  }
}

/* ── 캘린더 추가 — 로그인 필요 ── */
function addToCalendar(url){
  if(!currentUser){ openModal('loginModalBg'); return; }
  window.open(url,'_blank','noopener');
}

/* ── 아이콘 ── */
var ICON_ARCHIVE='<svg viewBox="0 0 15 15" fill="none"><path d="M2 5.5h11M3 5.5V12a1 1 0 001 1h7a1 1 0 001-1V5.5M6 5.5V4a1.5 1.5 0 013 0v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var ICON_CHECK='<svg viewBox="0 0 15 15" fill="none"><path d="M3 7.5l3.5 3.5 5.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var ICON_PLUS='<svg viewBox="0 0 15 15" fill="none"><line x1="7.5" y1="3" x2="7.5" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="7.5" x2="12" y2="7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/* ── 그리드 카드 ── */
/* ── 그리드 카드 — inline onclick 제거, data 속성으로 처리 ── */
function mkGrid(p){
  var days=daysUntil(p.release_date);
  var isArc=archivedIds.has(archiveKey(p));
  var calUrl=makeCalUrl(p);
  var key=archiveKey(p);
  var badgeText=days<0?'출시됨':'D-'+days;

  return '<div class="pcard" data-key="'+escapeHtml(key)+'">'+
    /* ★ 이미지: onclick 대신 data-link 속성 사용 */
    '<div class="pcard-img-wrap"'+(p.link?' data-link="'+escapeHtml(p.link)+'"':'')+'>'+
      '<img class="pcard-img" src="'+escapeHtml(p.image_url||FALLBACK)+'" onerror="this.src=\''+FALLBACK+'\'" loading="lazy"/>'+
      '<span class="pbadge">'+escapeHtml(badgeText)+'</span>'+
      /* ★ 아카이브 버튼: data-key만, onclick 없음 */
      '<button class="archive-btn'+(isArc?' archived':'')+'" data-key="'+escapeHtml(key)+'">'+
        (isArc?ICON_CHECK:ICON_ARCHIVE)+
      '</button>'+
    '</div>'+
    '<div class="pcard-body">'+
      '<div class="pc-brand-title">'+
        '<span class="pc-brand">'+escapeHtml(p.brand)+'</span>'+
        '<div class="pc-name">'+escapeHtml(p.item_name)+'</div>'+
      '</div>'+
      '<div class="pc-foot">'+
        '<div>'+
          '<div class="pc-date-lbl">Coming Up</div>'+
          '<div class="pc-date'+(days>=0&&days<=30?' urg':'')+'">'+formatDateDot(p.release_date)+'</div>'+
        '</div>'+
        /* ★ 캘린더 버튼: data-cal-url 속성 사용 */
        '<button class="cal-btn" data-cal-url="'+escapeHtml(calUrl)+'">'+
          'Calendar '+ICON_PLUS+
        '</button>'+
      '</div>'+
    '</div>'+
  '</div>';
}

/* ── 리스트 카드 ── */
function mkList(p){
  var days=daysUntil(p.release_date);
  var isArc=archivedIds.has(archiveKey(p));
  var calUrl=makeCalUrl(p);
  var key=archiveKey(p);
  return '<div class="lcard" data-key="'+escapeHtml(key)+'"'+(p.link?' data-link="'+escapeHtml(p.link)+'"':'')+'>'+
    '<img class="lcard-img" src="'+escapeHtml(p.image_url||FALLBACK)+'" onerror="this.src=\''+FALLBACK+'\'" loading="lazy"/>'+
    '<div class="lcard-body">'+
      '<div class="lc-brand">'+escapeHtml(p.brand)+'</div>'+
      '<div class="lc-name">'+escapeHtml(p.item_name)+'</div>'+
    '</div>'+
    '<div class="lcard-right">'+
      '<div>'+
        '<div class="lc-date-lbl">Coming Up</div>'+
        '<div class="lc-date'+(days>=0&&days<=30?' urg':'')+'">D-'+days+'</div>'+
      '</div>'+
      '<button class="lcal-btn" data-cal-url="'+escapeHtml(calUrl)+'">Calendar</button>'+
      '<button class="larchive-btn'+(isArc?' archived':'')+'" data-key="'+escapeHtml(key)+'">'+
        (isArc?ICON_CHECK:ICON_ARCHIVE)+
      '</button>'+
    '</div>'+
  '</div>';
}

/* ── 렌더 ── */
function renderItems(list){
  var el=document.getElementById('content');
  document.getElementById('resultCount').textContent=list.length+'개 시그널';
  if(!list.length){
    el.innerHTML=
      '<div class="empty-state">'+
        '<div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="7.5" stroke="#BDBDBD" stroke-width="1.5"/><line x1="16" y1="16" x2="22" y2="22" stroke="#BDBDBD" stroke-width="1.5" stroke-linecap="round"/></svg></div>'+
        '<div class="empty-title">데이터가 없습니다</div>'+
        '<div class="empty-desc">키워드를 검색해서 릴리즈 소식을 찾아보세요.</div>'+
      '</div>';
    return;
  }
  if(viewMode==='grid'){
    var html='<div class="card-grid">'; list.forEach(function(p){ html+=mkGrid(p); }); el.innerHTML=html+'</div>';
  } else {
    var html='<div class="card-list">'; list.forEach(function(p){ html+=mkList(p); }); el.innerHTML=html+'</div>';
  }
  bindCardEvents(el); /* ★ 항상 이벤트 다시 바인딩 */
}

/* ── 이벤트 바인딩 — data 속성 기반, inline onclick 없음 ── */
function bindCardEvents(container){
  /* 아카이브 버튼 */
  container.querySelectorAll('.archive-btn,.larchive-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      toggleArchive(this.getAttribute('data-key'),this);
    });
  });
  /* 캘린더 버튼 — data-cal-url 속성에서 URL 읽기 */
  container.querySelectorAll('.cal-btn,.lcal-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      addToCalendar(this.getAttribute('data-cal-url'));
    });
  });
  /* 이미지/카드 클릭 → 링크 열기 */
  container.querySelectorAll('.pcard-img-wrap[data-link]').forEach(function(el){
    el.style.cursor='pointer';
    el.addEventListener('click',function(){
      window.open(this.getAttribute('data-link'),'_blank','noopener');
    });
  });
  container.querySelectorAll('.lcard[data-link]').forEach(function(el){
    el.style.cursor='pointer';
    el.addEventListener('click',function(e){
      if(e.target.closest('.larchive-btn,.lcal-btn')) return;
      window.open(this.getAttribute('data-link'),'_blank','noopener');
    });
  });
}

/* ── 아카이브 토글 — 로그인 필요 ── */
function toggleArchive(key,btn){
  /* 로그인 필요 */
  if(!currentUser){ openModal('loginModalBg'); return; }

  /* keywordData + currentSearchItems에서 아이템 찾기 */
  var item=null;
  savedBrands.forEach(function(kw){
    if(item) return;
    item=(keywordData[kw]||[]).find(function(p){ return archiveKey(p)===key; });
  });
  if(!item) item=currentSearchItems.find(function(p){ return archiveKey(p)===key; });
  if(!item) return;

  if(archivedIds.has(key)){
    archivedIds.delete(key); archivedItems=archivedItems.filter(function(p){ return archiveKey(p)!==key; });
    if(btn){ btn.innerHTML=ICON_ARCHIVE; btn.classList.remove('archived'); }
    showToast('보관을 취소했어요.');
  } else {
    archivedIds.add(key); archivedItems.push(item);
    if(btn){ btn.innerHTML=ICON_CHECK; btn.classList.add('archived'); }
    showToast('✅ 아카이브에 추가됐어요!');
  }
  syncToCloud(); updateArchiveStats();
}

/* ── 아카이브 패널 ── */
function renderArchive(){
  var el=document.getElementById('archiveContent');
  updateArchiveStats();
  if(!archivedItems.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="16" rx="2" stroke="#BDBDBD" stroke-width="1.5"/><path d="M2 11h20" stroke="#BDBDBD" stroke-width="1.5"/><path d="M10 16h4" stroke="#BDBDBD" stroke-width="1.5" stroke-linecap="round"/></svg></div><div class="empty-title">아직 보관된 항목이 없어요</div><div class="empty-desc">릴리즈 카드에서 보관 버튼을 눌러보세요.</div></div>';
    return;
  }
  var sorted=archivedItems.slice().sort(function(a,b){
    return archiveSortMode==='imminent'
      ? a.release_date.localeCompare(b.release_date)
      : b.release_date.localeCompare(a.release_date);
  });
  var cntEl=document.getElementById('archiveResultCount');
  if(cntEl) cntEl.textContent=sorted.length+'개 보관됨';
  if(viewMode==='grid'){
    var html='<div class="card-grid">'; sorted.forEach(function(p){ html+=mkGrid(p); }); el.innerHTML=html+'</div>';
  } else {
    var html='<div class="card-list">'; sorted.forEach(function(p){ html+=mkList(p); }); el.innerHTML=html+'</div>';
  }
  bindCardEvents(el);
}

function updateArchiveStats(){
  var c=document.getElementById('archiveStatCount'),b=document.getElementById('archiveStatBrands');
  var u=document.getElementById('archiveStatUpcoming'),a=document.getElementById('archiveCnt');
  if(c) c.textContent=archivedItems.length;
  if(a) a.textContent=archivedItems.length;
  if(b) b.textContent=new Set(archivedItems.map(function(p){ return p.brand; })).size;
  if(u) u.textContent=archivedItems.filter(function(p){ var d=daysUntil(p.release_date); return d>=0&&d<=30; }).length;
}

/* ── DOMContentLoaded ── */
document.addEventListener('DOMContentLoaded',function(){
  var mobToggle=document.getElementById('mobToggle'),overlay=document.getElementById('overlay');
  if(mobToggle) mobToggle.onclick=openSidebar;
  if(overlay)   overlay.onclick=closeSidebar;

  var btnGrid=document.getElementById('btnGrid'),btnList=document.getElementById('btnList');
  if(btnGrid) btnGrid.onclick=function(){ viewMode='grid'; btnGrid.classList.add('on'); if(btnList) btnList.classList.remove('on'); renderItems(getSortedItems(getDisplayList())); };
  if(btnList) btnList.onclick=function(){ viewMode='list'; btnList.classList.add('on'); if(btnGrid) btnGrid.classList.remove('on'); renderItems(getSortedItems(getDisplayList())); };

  document.querySelectorAll('.sort-btn').forEach(function(btn){
    btn.onclick=function(){
      sortMode=this.getAttribute('data-sort');
      document.querySelectorAll('.sort-btn').forEach(function(b){ b.classList.remove('on'); });
      this.classList.add('on');
      renderItems(getSortedItems(getDisplayList()));
    };
  });

  var ms=document.getElementById('mainSearch');
  if(ms) ms.onkeydown=function(e){ if(e.key==='Enter') startHunt(); };

  // 3. 아카이브 뷰/정렬 버튼
  var btnGridArc=document.getElementById('btnGridArc');
  var btnListArc=document.getElementById('btnListArc');
  if(btnGridArc) btnGridArc.onclick=function(){
    viewMode='grid'; btnGridArc.classList.add('on'); if(btnListArc) btnListArc.classList.remove('on');
    renderArchive();
  };
  if(btnListArc) btnListArc.onclick=function(){
    viewMode='list'; btnListArc.classList.add('on'); if(btnGridArc) btnGridArc.classList.remove('on');
    renderArchive();
  };
  document.querySelectorAll('[data-sort-arc]').forEach(function(btn){
    btn.onclick=function(){
      archiveSortMode=this.getAttribute('data-sort-arc');
      document.querySelectorAll('[data-sort-arc]').forEach(function(b){ b.classList.remove('on'); });
      this.classList.add('on');
      renderArchive();
    };
  });
  var lb=document.getElementById('loginModalBg');
  if(lb) lb.onclick=function(e){ if(e.target===this) closeModal('loginModalBg'); };
  setStatus('',false);
});

/* ── Firebase Auth ── */
fbAuth.onAuthStateChanged(function(u){
  if(u){
    currentUser={name:u.displayName,email:u.email,uid:u.uid};
    db.collection('users').doc(u.uid).get().then(function(doc){
      if(doc.exists){
        var data=doc.data();
        keywordData=data.keywordData||keywordData;
        archivedItems=data.archivedItems||archivedItems;
        savedBrands=new Set(data.savedBrands||[]);
        archivedIds=new Set(archivedItems.map(function(item){ return archiveKey(item); }));
      }
      updateUserUI(); rebuildNav(); cleanupReleasedItems(); switchView('radar'); runSilentAutoHunt();
    }).catch(function(e){ console.error(e); updateUserUI(); rebuildNav(); switchView('radar'); });
  } else {
    currentUser=null;
    updateUserUI(); rebuildNav(); cleanupReleasedItems(); switchView('radar'); runSilentAutoHunt();
  }
});
