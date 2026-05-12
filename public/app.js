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
var FALLBACK = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80';

/* ── STATE ── */
var currentUser = null;
var currentView = 'radar';
var viewMode = 'grid'; // 'grid' | 'list'
var sortMode = 'imminent'; // 'imminent' | 'recent'
var allItems = JSON.parse(localStorage.getItem('cs_allItems')||'[]');
var archivedItems = JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
var archivedIds = new Set(archivedItems.map(function(item) { return archiveKey(item); }));
var savedBrands = new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));
var newBadgeCounts = {};

/* ── 유틸 ── */
function archiveKey(p){ return (p.brand||'')+'||'+(p.item_name||'')+'||'+(p.release_date||''); }
function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function daysUntil(dateStr) {
  var diff = new Date(dateStr) - new Date(TODAY);
  return Math.ceil(diff / 86400000);
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  return d.toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric' });
}

/* ── 토스트 ── */
function showToast(msg) {
  var t = document.getElementById('toast');
  var m = document.getElementById('toastMsg');
  if (!t || !m) return;
  m.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 3000);
}

/* ── 상태바 ── */
function setStatus(msg, show) {
  var bar = document.getElementById('statusBar');
  var txt = document.getElementById('statusMsg');
  if (!bar) return;
  if (show) {
    bar.style.display = 'flex';
    if (txt) txt.textContent = msg;
  } else {
    bar.style.display = 'none';
  }
}

/* ── 모달 ── */
function openModal(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}
function closeModal(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/* ── 사이드바 ── */
function closeSidebar() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('overlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('show');
}
function openSidebar() {
  var sb = document.getElementById('sidebar');
  var ov = document.getElementById('overlay');
  if (sb) sb.classList.add('open');
  if (ov) ov.classList.add('show');
}

/* ── 로그인/로그아웃 ── */
function googleLogin() {
  fbAuth.signInWithPopup(fbProvider).catch(function(e){ showToast('로그인 실패: ' + e.message); });
}
function continueAsGuest() {
  closeModal('loginModalBg');
}
function logout() {
  fbAuth.signOut().then(function(){
    currentUser = null;
    updateUserUI();
    showToast('로그아웃 되었습니다.');
  });
}

/* ── 유저 UI 업데이트 ── */
function updateUserUI() {
  var nameEl  = document.getElementById('userName');
  var roleEl  = document.getElementById('userRole');
  var avEl    = document.getElementById('userAv');
  var loginBtn = document.getElementById('loginBtnSb');

  if (currentUser) {
    if (nameEl) nameEl.textContent = currentUser.name || currentUser.email;
    if (roleEl) roleEl.textContent = currentUser.email;
    if (avEl)   avEl.textContent   = (currentUser.name || 'U')[0].toUpperCase();
    if (loginBtn) { loginBtn.textContent = '로그아웃'; loginBtn.onclick = logout; }
    closeModal('loginModalBg');
  } else {
    if (nameEl) nameEl.textContent = '로그인이 필요해요';
    if (roleEl) roleEl.textContent = '게스트';
    if (avEl)   avEl.textContent   = '?';
    if (loginBtn) { loginBtn.textContent = '로그인'; loginBtn.onclick = function(){ openModal('loginModalBg'); }; }
  }

  // 아카이브 로그인 버튼
  var archLoginBtn = document.getElementById('archiveLoginBtn');
  var archMeta     = document.getElementById('archiveMeta');
  if (archLoginBtn) archLoginBtn.style.display = currentUser ? 'none' : 'flex';
  if (archMeta)     archMeta.style.display     = currentUser ? 'flex' : 'none';
}

/* ── 탭 전환 ── */
function switchView(viewType) {
  currentView = viewType;
  document.getElementById('radarPanel').style.display   = (viewType === 'archive') ? 'none' : 'flex';
  document.getElementById('archivePanel').style.display = (viewType === 'archive') ? 'flex' : 'none';

  if (viewType === 'radar') {
    renderItems(getSortedItems(allItems));
  } else if (viewType === 'archive') {
    renderArchive();
  } else {
    var brandData = allItems.filter(function(item){ return item.brand === viewType; });
    renderItems(getSortedItems(brandData));
    newBadgeCounts[viewType] = 0;
  }
  rebuildNav();
  closeSidebar();
}

/* ── 정렬 ── */
function getSortedItems(list) {
  var copy = list.slice();
  if (sortMode === 'imminent') {
    copy.sort(function(a,b){ return a.release_date.localeCompare(b.release_date); });
  } else {
    copy.sort(function(a,b){ return b.release_date.localeCompare(a.release_date); });
  }
  return copy;
}

/* ── 백그라운드 자동 트래킹 ── */
async function runSilentAutoHunt() {
  if (savedBrands.size === 0) return;
  var lastHunt = localStorage.getItem('last_auto_hunt');
  if (lastHunt === TODAY) return;

  var brandsArray = Array.from(savedBrands);
  var totalNew = 0;

  for (var brand of brandsArray) {
    try {
      var res = await fetch('/api/hunt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: brand })
      });
      if (!res.ok) continue;

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var parts = buf.split('\n\n'); buf = parts.pop();
        for (var line of parts) {
          if (!line.startsWith('data: ')) continue;
          var ev = JSON.parse(line.slice(6));
          if (ev.type === 'item') {
            var key = archiveKey(ev.data);
            if (!allItems.some(function(x){ return archiveKey(x) === key; })) {
              allItems.push(ev.data);
              newBadgeCounts[brand] = (newBadgeCounts[brand] || 0) + 1;
              totalNew++;
            }
          }
        }
      }
      rebuildNav();
    } catch (e) { console.error(e); }
    await new Promise(function(r){ setTimeout(r, 2000); });
  }

  localStorage.setItem('last_auto_hunt', TODAY);
  syncToCloud();
  if (totalNew > 0) showToast('🔔 포커스 그룹에 새로운 소식이 도착했습니다.');
}

/* ── NAV 재빌드 ── */
function rebuildNav() {
  var navList = document.getElementById('navList');
  var allRow  = document.getElementById('allFilter');
  navList.innerHTML = '';
  navList.appendChild(allRow);

  savedBrands.forEach(function(brand) {
    var cnt    = allItems.filter(function(p){ return p.brand === brand; }).length;
    var newCnt = newBadgeCounts[brand] || 0;
    var row    = document.createElement('div');
    row.className = 'nav-item' + (currentView === brand ? ' active' : '');
    row.innerHTML =
      '<div class="ni-left"><div class="ni-dot"></div><span class="ni-label"># ' + escapeHtml(brand) + '</span></div>' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        (newCnt > 0 ? '<span class="badge-new" style="background:var(--accent);color:white;font-size:10px;padding:1px 5px;border-radius:10px;font-weight:800;">' + newCnt + '</span>' : '') +
        '<span class="ni-count">' + cnt + '</span>' +
      '</div>';
    row.onclick = function(){ switchView(brand); };
    navList.appendChild(row);
  });

  document.getElementById('allFilterCnt').textContent = allItems.length;
  document.getElementById('totalCnt').textContent     = allItems.length;
  document.getElementById('navRadar').classList.toggle('active',   currentView === 'radar');
  document.getElementById('navArchive').classList.toggle('active', currentView === 'archive');

  // 사이드바 검색 필터
  var sbSearch = document.getElementById('sbSearch');
  if (sbSearch) {
    sbSearch.oninput = function() {
      var q = this.value.toLowerCase();
      navList.querySelectorAll('.nav-item:not(#allFilter)').forEach(function(row) {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    };
  }
}

/* ── 클라우드 동기화 ── */
function syncToCloud() {
  localStorage.setItem('cs_archivedItems', JSON.stringify(archivedItems));
  localStorage.setItem('cs_savedBrands',   JSON.stringify(Array.from(savedBrands)));
  localStorage.setItem('cs_allItems',      JSON.stringify(allItems));
  if (currentUser) {
    db.collection('users').doc(currentUser.uid).set({
      archivedItems: archivedItems,
      savedBrands:   Array.from(savedBrands),
      allItems:      allItems,
      lastUpdated:   firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

/* ── 키워드 저장 ── */
function saveCurrentKeyword() {
  var kw = document.getElementById('mainSearch').value.trim();
  if (!kw) { showToast('키워드를 먼저 입력해주세요.'); return; }
  if (savedBrands.has(kw)) { showToast('이미 저장된 키워드예요.'); return; }
  savedBrands.add(kw);
  syncToCloud();
  rebuildNav();
  showToast('✅ "' + kw + '" 포커스 그룹에 추가됐어요!');
}

/* ── 검색 실행 ── */
async function startHunt() {
  var kw = document.getElementById('mainSearch').value.trim();
  if (!kw) return;
  var btn = document.getElementById('huntBtn');
  btn.disabled = true; btn.textContent = '탐색 중...';
  setStatus("'" + kw + "' 수색 중...", true);

  try {
    var res = await fetch('/api/hunt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: kw })
    });
    if (!res.ok) {
      var errData = await res.json().catch(function(){ return {}; });
      throw new Error(errData.error || 'API 오류 (' + res.status + ')');
    }

    var reader  = res.body.getReader();
    var decoder = new TextDecoder();
    var buf     = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var parts = buf.split('\n\n'); buf = parts.pop();
      for (var line of parts) {
        if (!line.startsWith('data: ')) continue;
        var ev = JSON.parse(line.slice(6));
        if (ev.type === 'status') { setStatus(ev.message, true); }
        if (ev.type === 'item') {
          if (!allItems.some(function(x){ return archiveKey(x) === archiveKey(ev.data); })) {
            allItems.push(ev.data);
          }
          var display = currentView === 'radar' ? allItems : allItems.filter(function(p){ return p.brand === currentView; });
          renderItems(getSortedItems(display));
          rebuildNav();
        }
        if (ev.type === 'error') { showToast('오류: ' + ev.message); }
      }
    }
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4.5" stroke="white" stroke-width="1.2"/><circle cx="5.5" cy="5.5" r="1.8" fill="white"/></svg> 발견하기';
    setStatus('', false);
    syncToCloud();
  }
}

/* ── 카드 렌더링 (그리드) ── */
function mkGrid(p) {
  var days  = daysUntil(p.release_date);
  var isArc = archivedIds.has(archiveKey(p));
  var badge = days <= 7
    ? '<span class="card-badge imminent">D-' + days + '</span>'
    : days <= 30
      ? '<span class="card-badge soon">D-' + days + '</span>'
      : '<span class="card-badge upcoming">D-' + days + '</span>';

  return '<div class="card" data-key="' + escapeHtml(archiveKey(p)) + '">' +
    '<div class="card-img-wrap">' +
      '<img class="card-img" src="' + escapeHtml(p.image_url || FALLBACK) + '" onerror="this.src=\'' + FALLBACK + '\'" loading="lazy"/>' +
      badge +
    '</div>' +
    '<div class="card-body">' +
      '<div class="card-brand">' + escapeHtml(p.brand) + '</div>' +
      '<div class="card-name">'  + escapeHtml(p.item_name) + '</div>' +
      '<div class="card-date">'  + formatDate(p.release_date) + '</div>' +
      (p.description ? '<div class="card-desc">' + escapeHtml(p.description) + '</div>' : '') +
      '<div class="card-actions">' +
        (p.link ? '<a class="card-link" href="' + escapeHtml(p.link) + '" target="_blank" rel="noopener">링크 열기</a>' : '') +
        '<button class="archive-btn' + (isArc ? ' archived' : '') + '" data-key="' + escapeHtml(archiveKey(p)) + '">' +
          (isArc ? '✅ 보관됨' : '+ 보관') +
        '</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* ── 카드 렌더링 (리스트) ── */
function mkList(p) {
  var days  = daysUntil(p.release_date);
  var isArc = archivedIds.has(archiveKey(p));
  return '<div class="list-row" data-key="' + escapeHtml(archiveKey(p)) + '">' +
    '<img class="list-img" src="' + escapeHtml(p.image_url || FALLBACK) + '" onerror="this.src=\'' + FALLBACK + '\'" loading="lazy"/>' +
    '<div class="list-info">' +
      '<div class="list-brand">' + escapeHtml(p.brand) + '</div>' +
      '<div class="list-name">'  + escapeHtml(p.item_name) + '</div>' +
      (p.description ? '<div class="list-desc">' + escapeHtml(p.description) + '</div>' : '') +
    '</div>' +
    '<div class="list-meta">' +
      '<div class="list-date">' + formatDate(p.release_date) + '</div>' +
      '<div class="list-days">D-' + days + '</div>' +
    '</div>' +
    '<button class="archive-btn' + (isArc ? ' archived' : '') + '" data-key="' + escapeHtml(archiveKey(p)) + '">' +
      (isArc ? '✅' : '+') +
    '</button>' +
  '</div>';
}

/* ── 아이템 목록 렌더 ── */
function renderItems(list) {
  var el = document.getElementById('content');
  document.getElementById('resultCount').textContent = list.length + '개 시그널';
  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-title">데이터가 없습니다</div><div class="empty-sub">키워드를 검색해서 릴리즈 소식을 찾아보세요.</div></div>';
    return;
  }
  if (viewMode === 'grid') {
    var html = '<div class="card-grid">';
    list.forEach(function(p){ html += mkGrid(p); });
    el.innerHTML = html + '</div>';
  } else {
    var html = '<div class="list-view">';
    list.forEach(function(p){ html += mkList(p); });
    el.innerHTML = html + '</div>';
  }
  bindCardEvents(el);
}

/* ── 카드 이벤트 바인딩 ── */
function bindCardEvents(container) {
  container.querySelectorAll('.archive-btn').forEach(function(btn) {
    btn.onclick = function() {
      var key = this.getAttribute('data-key');
      toggleArchive(key, this);
    };
  });
}

/* ── 아카이브 토글 ── */
function toggleArchive(key, btn) {
  var item = allItems.find(function(p){ return archiveKey(p) === key; });
  if (!item) return;

  if (archivedIds.has(key)) {
    archivedIds.delete(key);
    archivedItems = archivedItems.filter(function(p){ return archiveKey(p) !== key; });
    if (btn) { btn.textContent = '+ 보관'; btn.classList.remove('archived'); }
    showToast('보관을 취소했어요.');
  } else {
    archivedIds.add(key);
    archivedItems.push(item);
    if (btn) { btn.textContent = '✅ 보관됨'; btn.classList.add('archived'); }
    showToast('✅ 아카이브에 추가됐어요!');
  }
  syncToCloud();
  updateArchiveStats();
}

/* ── 아카이브 패널 렌더 ── */
function renderArchive() {
  var el = document.getElementById('archiveContent');
  updateArchiveStats();

  if (!archivedItems.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-title">아직 보관된 항목이 없어요</div><div class="empty-sub">릴리즈 카드에서 + 보관 버튼을 눌러보세요.</div></div>';
    return;
  }

  var sorted = archivedItems.slice().sort(function(a,b){ return a.release_date.localeCompare(b.release_date); });
  var html = '<div class="card-grid">';
  sorted.forEach(function(p){ html += mkGrid(p); });
  el.innerHTML = html + '</div>';
  bindCardEvents(el);
}

/* ── 아카이브 통계 ── */
function updateArchiveStats() {
  var cntEl      = document.getElementById('archiveStatCount');
  var brandEl    = document.getElementById('archiveStatBrands');
  var upcomingEl = document.getElementById('archiveStatUpcoming');
  var archCntEl  = document.getElementById('archiveCnt');

  if (cntEl)      cntEl.textContent      = archivedItems.length;
  if (archCntEl)  archCntEl.textContent  = archivedItems.length;
  if (brandEl)    brandEl.textContent    = new Set(archivedItems.map(function(p){ return p.brand; })).size;
  if (upcomingEl) upcomingEl.textContent = archivedItems.filter(function(p){ return daysUntil(p.release_date) <= 30; }).length;
}

/* ── INIT & 이벤트 리스너 ── */
document.addEventListener('DOMContentLoaded', function() {

  // 모바일 사이드바 토글
  var mobToggle = document.getElementById('mobToggle');
  var overlay   = document.getElementById('overlay');
  if (mobToggle) mobToggle.onclick = openSidebar;
  if (overlay)   overlay.onclick   = closeSidebar;

  // 뷰 전환 (그리드/리스트)
  var btnGrid = document.getElementById('btnGrid');
  var btnList = document.getElementById('btnList');
  if (btnGrid) btnGrid.onclick = function() {
    viewMode = 'grid';
    btnGrid.classList.add('on'); btnList.classList.remove('on');
    var display = currentView === 'radar' ? allItems : allItems.filter(function(p){ return p.brand === currentView; });
    renderItems(getSortedItems(display));
  };
  if (btnList) btnList.onclick = function() {
    viewMode = 'list';
    btnList.classList.add('on'); btnGrid.classList.remove('on');
    var display = currentView === 'radar' ? allItems : allItems.filter(function(p){ return p.brand === currentView; });
    renderItems(getSortedItems(display));
  };

  // 정렬 버튼
  document.querySelectorAll('.sort-btn').forEach(function(btn) {
    btn.onclick = function() {
      sortMode = this.getAttribute('data-sort');
      document.querySelectorAll('.sort-btn').forEach(function(b){ b.classList.remove('on'); });
      this.classList.add('on');
      var display = currentView === 'radar' ? allItems : allItems.filter(function(p){ return p.brand === currentView; });
      renderItems(getSortedItems(display));
    };
  });

  // 검색창 엔터키
  var mainSearch = document.getElementById('mainSearch');
  if (mainSearch) mainSearch.onkeydown = function(e){ if (e.key === 'Enter') startHunt(); };

  // 모달 배경 클릭 닫기
  var loginBg = document.getElementById('loginModalBg');
  if (loginBg) loginBg.onclick = function(e){ if (e.target === this) closeModal('loginModalBg'); };

  // 초기 상태바 숨김
  setStatus('', false);
});

/* ── Firebase 인증 상태 ── */
fbAuth.onAuthStateChanged(function(u) {
  if (u) {
    currentUser = { name: u.displayName, email: u.email, uid: u.uid };
    db.collection('users').doc(u.uid).get().then(function(doc) {
      if (doc.exists) {
        var data = doc.data();
        allItems      = data.allItems      || allItems;
        archivedItems = data.archivedItems || archivedItems;
        savedBrands   = new Set(data.savedBrands || []);
        archivedIds   = new Set(archivedItems.map(function(item){ return archiveKey(item); }));
      }
      updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
    }).catch(function(e){ console.error(e); updateUserUI(); rebuildNav(); switchView('radar'); });
  } else {
    currentUser = null;
    updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
  }
});
