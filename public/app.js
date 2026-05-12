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
var currentView = 'radar'; // 'radar', 'archive', 또는 특정 브랜드명
var allItems = JSON.parse(localStorage.getItem('cs_allItems')||'[]');
var archivedItems = JSON.parse(localStorage.getItem('cs_archivedItems')||'[]');
var archivedIds = new Set(archivedItems.map(function(item) { return archiveKey(item); }));
var savedBrands = new Set(JSON.parse(localStorage.getItem('cs_savedBrands')||'[]'));
var newBadgeCounts = {}; // 브랜드별 신규 아이템 개수

/* ── 1. 위계 분리 및 탭 전환 ── */
function switchView(viewType) {
  currentView = viewType;
  
  // 패널 표시 전환
  document.getElementById('radarPanel').style.display = (viewType === 'archive') ? 'none' : 'flex';
  document.getElementById('archivePanel').style.display = (viewType === 'archive') ? 'flex' : 'none';
  
  if (viewType === 'radar') {
    renderItems(allItems);
  } else if (viewType === 'archive') {
    renderArchive();
  } else {
    // 3. 포커스 그룹 클릭 시 저장된 데이터 즉시 호출
    var brandData = allItems.filter(function(item) { return item.brand === viewType; });
    renderItems(brandData);
    // 클릭해서 확인했으니 해당 브랜드 뱃지 초기화
    newBadgeCounts[viewType] = 0;
  }
  
  rebuildNav();
  closeSidebar();
}

/* ── 2. 백그라운드 자동 트래킹 (몰래 수색) ── */
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
            if (!allItems.some(function(x) { return archiveKey(x) === key; })) {
              allItems.push(ev.data);
              newBadgeCounts[brand] = (newBadgeCounts[brand] || 0) + 1;
              totalNew++;
            }
          }
        }
      }
      rebuildNav(); // 뱃지 실시간 업데이트
    } catch (e) { console.error(e); }
    await new Promise(r => setTimeout(r, 2000));
  }

  localStorage.setItem('last_auto_hunt', TODAY);
  syncToCloud();
  if (totalNew > 0) showToast("🔔 포커스 그룹에 새로운 소식이 도착했습니다.");
}

/* ── NAV & UI REBUILD ── */
function rebuildNav() {
  var navList = document.getElementById('navList');
  var allRow = document.getElementById('allFilter');
  navList.innerHTML = '';
  navList.appendChild(allRow);

  savedBrands.forEach(function(brand) {
    var cnt = allItems.filter(function(p) { return p.brand === brand; }).length;
    var newCnt = newBadgeCounts[brand] || 0;
    
    var row = document.createElement('div');
    row.className = 'nav-item' + (currentView === brand ? ' active' : '');
    row.innerHTML = `
      <div class="ni-left"><div class="ni-dot"></div><span class="ni-label"># ${brand}</span></div>
      <div style="display:flex; align-items:center; gap:6px;">
        ${newCnt > 0 ? `<span class="badge-new" style="background:var(--accent);color:white;font-size:10px;padding:1px 5px;border-radius:10px;font-weight:800;">${newCnt}</span>` : ''}
        <span class="ni-count">${cnt}</span>
      </div>`;
    row.onclick = function() { switchView(brand); };
    navList.appendChild(row);
  });

  document.getElementById('allFilterCnt').textContent = allItems.length;
  document.getElementById('totalCnt').textContent = allItems.length;
  document.getElementById('navRadar').classList.toggle('active', currentView === 'radar');
  document.getElementById('navArchive').classList.toggle('active', currentView === 'archive');
}

/* ── 기존 핵심 로직들 (유지) ── */
function archiveKey(p){ return (p.brand||'')+'||'+(p.item_name||'')+'||'+(p.release_date||''); }
function escapeHtml(str) { return (str || '').toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function syncToCloud() {
  localStorage.setItem('cs_archivedItems', JSON.stringify(archivedItems));
  localStorage.setItem('cs_savedBrands', JSON.stringify(Array.from(savedBrands)));
  localStorage.setItem('cs_allItems', JSON.stringify(allItems));
  if (currentUser) {
    db.collection('users').doc(currentUser.uid).set({
      archivedItems: archivedItems, savedBrands: Array.from(savedBrands), allItems: allItems,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
}

async function startHunt() {
  var kw = document.getElementById('mainSearch').value.trim();
  if (!kw) return;
  var btn = document.getElementById('huntBtn');
  btn.disabled = true; btn.textContent = '탐색 중...';
  setStatus("'"+kw+"' 수색 중...", true);
  
  try {
    var res = await fetch('/api/hunt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: kw }) });
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
          if (!allItems.some(x => archiveKey(x) === archiveKey(ev.data))) allItems.push(ev.data);
          renderItems(currentView === 'radar' ? allItems : allItems.filter(p => p.brand === currentView));
          rebuildNav();
        }
      }
    }
  } catch (e) { showToast("오류: " + e.message); }
  finally { btn.disabled = false; btn.innerHTML = '발견하기'; setStatus('', false); syncToCloud(); }
}

function renderItems(list) {
  var el = document.getElementById('content');
  document.getElementById('resultCount').textContent = list.length + '개 시그널';
  if (!list.length) { el.innerHTML = '<div class="empty-state"><div class="empty-title">데이터가 없습니다</div></div>'; return; }
  var html = '<div class="card-grid">';
  list.forEach(p => { html += mkGrid(p); });
  el.innerHTML = html + '</div>';
  bindCardEvents(el);
}

// ... mkGrid, mkList, bindCardEvents, toggleArchive 등 기존 UI 헬퍼 함수들을 아래에 그대로 유지 ...
// (지면상 생략하지만 다영님이 이전에 가지고 계시던 그 함수들입니다!)

/* ── INIT ── */
fbAuth.onAuthStateChanged(function(u) {
  if (u) {
    currentUser = { name: u.displayName, email: u.email, uid: u.uid };
    db.collection('users').doc(u.uid).get().then(doc => {
      if (doc.exists) {
        var data = doc.data();
        allItems = data.allItems || allItems;
        archivedItems = data.archivedItems || archivedItems;
        savedBrands = new Set(data.savedBrands || []);
        archivedIds = new Set(archivedItems.map(item => archiveKey(item)));
      }
      updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
    });
  } else {
    updateUserUI(); rebuildNav(); switchView('radar'); runSilentAutoHunt();
  }
});
