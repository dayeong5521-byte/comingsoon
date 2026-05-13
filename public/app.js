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

/* ── STATE ── */
var currentUser=null;
var currentView='radar';
var viewMode='grid';
var sortMode='imminent';
var currentSearchItems=[];
var allItems=JSON.parse(localStorage.getItem('cs_allItems')||'[]');
var archivedItems=JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
var archivedIds=new Set(archivedItems.map(function(i){ return archiveKey(i); }));
var savedBrands=new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));
var newBadgeCounts={};

/* ── 유틸 ── */
function archiveKey(p){ return (p.brand||'')+'||'+(p.item_name||'')+'||'+(p.release_date||''); }
function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function daysUntil(d){ return Math.ceil((new Date(d)-new Date(TODAY))/86400000); }

/* 날짜 형식 — Figma: 2026.05.22 */
function formatDateDot(dateStr){
  if(!dateStr) return '';
  var d=new Date(dateStr);
  var y=d.getFullYear();
  var m=String(d.getMonth()+1).padStart(2,'0');
  var day=String(d.getDate()).padStart(2,'0');
  return y+'.'+m+'.'+day;
}

function makeCalUrl(p){
  var d=p.release_date.replace(/-/g,'');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    +'&text='+encodeURIComponent('[출시] '+p.brand+' '+p.item_name)
    +'&dates='+d+'/'+d
    +'&details='+encodeURIComponent(p.description||'');
}

/* ── 토스트 ── */
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

/* ── 검색창/포커스헤더 표시 ── */
function updateLayoutForView(viewType){
  var searchHdr=document.getElementById('searchHeader');
  var focusHdr=document.getElementById('focusGroupHeader');
  var focusTitle=document.getElementById('focusGroupTitle');
var isBrand=(viewType!=='radar'&&viewType!=='archive');  if(searchHdr) searchHdr.style.display=isBrand?'none':'flex';
  if(focusHdr){
    if(isBrand){ focusHdr.classList.add('show'); if(focusTitle) focusTitle.textContent='# '+viewType; }
    else { focusHdr.classList.remove('show'); }
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
    renderItems(getSortedItems(allItems));
  } else if(viewType==='archive'){
    renderArchive();
  } else {
    var bd=allItems.filter(function(item){ return item.brand===viewType; });
    renderItems(getSortedItems(bd));
    newBadgeCounts[viewType]=0;
  }
  rebuildNav(); closeSidebar();
}

function getDisplayList(){
  if(currentView==='radar')   return currentSearchItems;
  if(currentView==='all')     return allItems;
  if(currentView==='archive') return archivedItems;
  return allItems.filter(function(p){ return p.brand===currentView; });
}

/* ── 정렬 ── */
function getSortedItems(list){
  return list.slice().sort(function(a,b){
    return sortMode==='imminent'
      ? a.release_date.localeCompare(b.release_date)
      : b.release_date.localeCompare(a.release_date);
  });
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
            var key=archiveKey(ev.data);
            if(!allItems.some(function(x){ return archiveKey(x)===key; })){
              allItems.push(ev.data); newBadgeCounts[brand]=(newBadgeCounts[brand]||0)+1; totalNew++;
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

/* ── NAV 재빌드 ── */
function rebuildNav(){
  var navList=document.getElementById('navList');
  var allRow=document.getElementById('allFilter');
  navList.innerHTML=''; navList.appendChild(allRow);

  savedBrands.forEach(function(brand){
    var cnt=allItems.filter(function(p){ return p.brand===brand; }).length;
    var newCnt=newBadgeCounts[brand]||0;
    var row=document.createElement('div');
    row.className='nav-item nav-item-brand'+(currentView===brand?' active':'');
    row.innerHTML=
      '<div class="ni-left">'+
        '<div class="ni-dot"></div>'+
        '<span class="ni-label"># '+escapeHtml(brand)+'</span>'+
      '</div>'+
      (cnt>0?'<span class="ni-badge">'+(newCnt>0?newCnt:cnt)+'</span>':'');
    row.onclick=function(){ switchView(brand); };
    navList.appendChild(row);
  });

  // 전체 뱃지 업데이트
  var oldBadge=allRow.querySelector('.ni-badge');
  if(oldBadge) oldBadge.remove();
  allRow.className='nav-item nav-item-brand'+(currentView==='all'?' active':'');
  if(allItems.length>0){
    var b=document.createElement('span'); b.className='ni-badge'; b.textContent=allItems.length;
    allRow.appendChild(b);
  }

  // 상단 nav active 표시
  document.getElementById('navRadar').classList.toggle('active',  currentView==='radar');
  document.getElementById('navArchive').classList.toggle('active',currentView==='archive');

  // 사이드바 검색 필터
  var sbSearch=document.getElementById('sbSearch');
  if(sbSearch) sbSearch.oninput=function(){
    var q=this.value.toLowerCase();
    navList.querySelectorAll('.nav-item-brand:not(#allFilter)').forEach(function(r){
      r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';
    });
  };
}

/* ── 클라우드 동기화 ── */
function syncToCloud(){
  localStorage.setItem('cs_archivedItems',JSON.stringify(archivedItems));
  localStorage.setItem('cs_savedBrands',  JSON.stringify(Array.from(savedBrands)));
  localStorage.setItem('cs_allItems',     JSON.stringify(allItems));
  if(currentUser){
    db.collection('users').doc(currentUser.uid).set({
      archivedItems:archivedItems,savedBrands:Array.from(savedBrands),allItems:allItems,
      lastUpdated:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});
  }
}

/* ── 키워드 저장 ── */
function saveCurrentKeyword(){
  var kw=document.getElementById('mainSearch').value.trim();
  if(!kw){ showToast('키워드를 먼저 입력해주세요.'); return; }
  if(savedBrands.has(kw)){ showToast('이미 저장된 키워드예요.'); return; }
  savedBrands.add(kw); syncToCloud(); rebuildNav();
  showToast('✅ "'+kw+'" 포커스 그룹에 추가됐어요!');
}

/* ── 검색 ── */
async function startHunt(){
  var kw=document.getElementById('mainSearch').value.trim();
  if(!kw) return;
  var btn=document.getElementById('huntBtn');
  btn.disabled=true; btn.textContent='탐색 중...';
  setStatus("'"+kw+"' 수색 중...",true);
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
          if(!currentSearchItems.some(function(x){ return archiveKey(x)===archiveKey(ev.data); })) currentSearchItems.push(ev.data);
          if(!allItems.some(function(x){ return archiveKey(x)===archiveKey(ev.data); })) allItems.push(ev.data);
          renderItems(getSortedItems(currentSearchItems)); rebuildNav();
        }
        if(ev.type==='error') showToast('오류: '+ev.message);
      }
    }
  } catch(e){ showToast('오류: '+e.message); }
  finally{
    btn.disabled=false;
    btn.innerHTML='<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="white" stroke-width="1.3"/><circle cx="6" cy="6" r="2" fill="white"/></svg> 발견하기';
    setStatus('',false); syncToCloud();
  }
}

/* ── 아이콘 ── */
var ICON_ARCHIVE='<svg viewBox="0 0 15 15" fill="none"><path d="M2 5.5h11M3 5.5V12a1 1 0 001 1h7a1 1 0 001-1V5.5M6 5.5V4a1.5 1.5 0 013 0v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
var ICON_CHECK='<svg viewBox="0 0 15 15" fill="none"><path d="M3 7.5l3.5 3.5 5.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/* Calendar + 아이콘 */
var ICON_PLUS='<svg viewBox="0 0 15 15" fill="none"><line x1="7.5" y1="3" x2="7.5" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="3" y1="7.5" x2="12" y2="7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/* ── 그리드 카드 — Figma 9:736 정확 반영 ── */
function mkGrid(p){
  var days=daysUntil(p.release_date);
  var isArc=archivedIds.has(archiveKey(p));
  var calUrl=makeCalUrl(p);
  var imgClick=p.link?'onclick="window.open(\''+escapeHtml(p.link)+'\',\'_blank\')" style="cursor:pointer;"':'';

  // D-뱃지
  var badgeText=days<0?'출시됨':'D-'+days;

  return '<div class="pcard" data-key="'+escapeHtml(archiveKey(p))+'">'+
    /* 이미지 영역 — Figma: h-160px 고정 */
    '<div class="pcard-img-wrap" '+imgClick+'>'+
      '<img class="pcard-img" src="'+escapeHtml(p.image_url||FALLBACK)+'" onerror="this.src=\''+FALLBACK+'\'" loading="lazy"/>'+
      /* D-뱃지 — Figma: h-20px, top-9px, left-9.5px, rgba(255,255,255,0.9) */
      '<span class="pbadge">'+escapeHtml(badgeText)+'</span>'+
      /* 아카이브 버튼 — Figma: 28x28, top-9px, right-9px, rgba(255,255,255,0.9) */
      '<button class="archive-btn'+(isArc?' archived':'')+'" data-key="'+escapeHtml(archiveKey(p))+'" onclick="event.stopPropagation()">'+
        (isArc?ICON_CHECK:ICON_ARCHIVE)+
      '</button>'+
    '</div>'+
    /* 카드 바디 — Figma: padding 12px, gap-10px */
    '<div class="pcard-body">'+
      /* 브랜드+타이틀 섹션 — gap-4px */
      '<div class="pc-brand-title">'+
        /* 브랜드 — Figma: h-17.5px, rounded pill, rgba(242,102,75,0.08), 9px ExtraBold */
        '<span class="pc-brand">'+escapeHtml(p.brand)+'</span>'+
        /* 타이틀 — ★ 고정 높이 35px, 13px Bold */
        '<div class="pc-name">'+escapeHtml(p.item_name)+'</div>'+
      '</div>'+
      /* 푸터 — Figma: h-39.5px, border-top, justify-between */
      '<div class="pc-foot">'+
        '<div>'+
          /* "Coming Up" — Figma: 8px Medium, #bdbdbd */
          '<div class="pc-date-lbl">Coming Up</div>'+
          /* 날짜 — Figma: 14px Black, #111, 형식 2026.05.22 */
          '<div class="pc-date'+(days>=0&&days<=30?' urg':'')+'">'+formatDateDot(p.release_date)+'</div>'+
        '</div>'+
        /* Calendar 버튼 — Figma: h-30px, outlined (white bg + orange border) */
        '<a class="cal-btn" href="'+calUrl+'" target="_blank" rel="noopener">'+
          'Calendar '+ICON_PLUS+
        '</a>'+
      '</div>'+
    '</div>'+
  '</div>';
}

/* ── 리스트 카드 ── */
function mkList(p){
  var days=daysUntil(p.release_date);
  var isArc=archivedIds.has(archiveKey(p));
  var calUrl=makeCalUrl(p);
  var rowClick=p.link?'onclick="window.open(\''+escapeHtml(p.link)+'\',\'_blank\')" style="cursor:pointer;"':'';
  return '<div class="lcard" data-key="'+escapeHtml(archiveKey(p))+'" '+rowClick+'>'+
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
      '<a class="lcal-btn" href="'+calUrl+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">Calendar</a>'+
      '<button class="larchive-btn'+(isArc?' archived':'')+'" data-key="'+escapeHtml(archiveKey(p))+'" onclick="event.stopPropagation()">'+
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
        '<div class="empty-icon">'+
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">'+
            '<circle cx="10.5" cy="10.5" r="7.5" stroke="#BDBDBD" stroke-width="1.5"/>'+
            '<line x1="16" y1="16" x2="22" y2="22" stroke="#BDBDBD" stroke-width="1.5" stroke-linecap="round"/>'+
          '</svg>'+
        '</div>'+
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
  bindCardEvents(el);
}

function bindCardEvents(container){
  container.querySelectorAll('.archive-btn,.larchive-btn').forEach(function(btn){
    btn.onclick=function(e){ e.stopPropagation(); toggleArchive(this.getAttribute('data-key'),this); };
  });
}

function toggleArchive(key,btn){
  var item=allItems.find(function(p){ return archiveKey(p)===key; })||currentSearchItems.find(function(p){ return archiveKey(p)===key; });
  if(!item) return;
  if(archivedIds.has(key)){
    archivedIds.delete(key); archivedItems=archivedItems.filter(function(p){ return archiveKey(p)!==key; });
    if(btn){ btn.innerHTML=ICON_ARCHIVE; btn.classList.remove('archived'); }
    showToast('보관을 취소했어요.');
  } else {
    archivedIds.add(key); archivedItems.push(item);
    if(btn){ btn.innerHTML=ICON_CHECK; btn.classList.add('archived','archive-pop'); }
    showToast('✅ 아카이브에 추가됐어요!');
  }
  syncToCloud(); updateArchiveStats();
}

/* ── 아카이브 ── */
function renderArchive(){
  var el=document.getElementById('archiveContent');
  updateArchiveStats();
  if(!archivedItems.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="16" rx="2" stroke="#BDBDBD" stroke-width="1.5"/><path d="M2 11h20" stroke="#BDBDBD" stroke-width="1.5"/><path d="M10 16h4" stroke="#BDBDBD" stroke-width="1.5" stroke-linecap="round"/></svg></div><div class="empty-title">아직 보관된 항목이 없어요</div><div class="empty-desc">릴리즈 카드에서 보관 버튼을 눌러보세요.</div></div>';
    return;
  }
  var sorted=archivedItems.slice().sort(function(a,b){ return a.release_date.localeCompare(b.release_date); });
  var html='<div class="card-grid">'; sorted.forEach(function(p){ html+=mkGrid(p); }); el.innerHTML=html+'</div>';
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
        allItems=data.allItems||allItems;
        archivedItems=data.archivedItems||archivedItems;
        savedBrands=new Set(data.savedBrands||[]);
        archivedIds=new Set(archivedItems.map(function(item){ return archiveKey(item); }));
      }
      updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
    }).catch(function(e){ console.error(e); updateUserUI(); rebuildNav(); switchView('radar'); });
  } else {
    currentUser=null;
    updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
  }
});
