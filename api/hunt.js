// api/hunt.js
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;
  if (!GEMINI_KEY || !SERPER_KEY)
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

  const { keyword } = req.body ?? {};
  if (!keyword?.trim()) return res.status(400).json({ error: '키워드를 입력해주세요.' });

  const TODAY = new Date().toISOString().split('T')[0];
  const CY    = new Date().getFullYear();

  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const seen = new Set();

  try {
    // ────────────────────────────────────────────
    // 1. Serper 검색 — 한국어 + 영어 OR 쿼리 병렬
    // ────────────────────────────────────────────
    send({ type:'status', message:`'${keyword}' 검색 중...` });

    const KO = '출시 OR 발매 OR 오픈 OR 공연 OR 팝업 OR 출간';
    const EN = 'release OR launch OR drop OR concert OR collection';
    const FW = `FW${String(CY).slice(2)} OR SS${String(CY+1).slice(2)}`;

    const queries = [
      { q:`${keyword} (${KO}) ${CY} ${CY+1}`,           gl:'kr', hl:'ko', num:10, tbs:'qdr:m6' },
      { q:`${keyword} (${EN} OR ${FW}) ${CY} ${CY+1}`,  gl:'us', hl:'en', num:10, tbs:'qdr:m6' },
      // 뉴스 기사 우선 — 날짜가 텍스트에 명확히 포함됨
      { q:`${keyword} release date ${CY}`,               gl:'us', hl:'en', num:8,  tbs:'qdr:m6', news:true },
      { q:`${keyword} 출시일 발매일 ${CY}`,              gl:'kr', hl:'ko', num:5,  tbs:'qdr:m6', news:true },
    ];

    const searchResponses = await Promise.all(queries.map(opt => {
      const { news, ...body } = opt;
      return fetch(`https://google.serper.dev/${news ? 'news' : 'search'}`, {
        method:'POST',
        headers:{ 'X-API-KEY':SERPER_KEY, 'Content-Type':'application/json' },
        body:JSON.stringify(body),
      }).then(r => r.ok ? r.json() : null).catch(() => null);
    }));

    // 차단 도메인
    const BLOCKED = [
      'facebook.com','threads.net',           // ← 차단
      'blog.naver.com','m.blog.naver.com','cafe.naver.com',
      'tistory.com','brunch.co.kr',
      'reddit.com','quora.com','dcinside.com',
    ];
    const isBlocked = url => BLOCKED.some(d => url?.includes(d));

    // 중복 제거 + 차단 필터
    const seenUrls = new Set();
    const allResults = [];
    for (const sd of searchResponses) {
      if (!sd) continue;
      // answerBox
      if (sd.answerBox?.answer || sd.answerBox?.snippet) {
        allResults.push({ title:'[직접답변]', snippet: sd.answerBox.answer || sd.answerBox.snippet, link:'' });
      }
      for (const o of (sd.organic || sd.news || [])) {
        if (!o?.link || seenUrls.has(o.link) || isBlocked(o.link)) continue;
        seenUrls.add(o.link);
        allResults.push(o);
      }
    }

    if (!allResults.length) throw new Error('검색 결과가 없습니다.');

    // ────────────────────────────────────────────
    // 2. 상위 페이지 fetch — 리스트 페이지 우선 선택
    //    release-dates, schedule, calendar 등 키워드 포함 URL 우선
    // ────────────────────────────────────────────
    send({ type:'status', message:'페이지 내용을 수집하고 있어요...' });

    const LIST_KEYWORDS = ['release-date','release-dates','schedule','calendar',
      'lineup','upcoming','drop-list','출시일정','발매일정'];
    const isListPage = url => LIST_KEYWORDS.some(k => url?.toLowerCase().includes(k));

    // 리스트 페이지 우선, 나머지는 뒤로
    const sortedResults = [
      ...allResults.filter(o => o.link && isListPage(o.link)),
      ...allResults.filter(o => o.link && !isListPage(o.link)),
    ];

    // 상위 3개 페이지 병렬 fetch (5초 타임아웃)
    const toFetch = sortedResults
      .filter(o => o.link && !['instagram.com','twitter.com','x.com','youtube.com','facebook.com','threads.net']
        .some(d => o.link.includes(d)))
      .slice(0, 3);

    const pageContents = await Promise.allSettled(toFetch.map(async item => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(item.link, {
          signal: ctrl.signal,
          headers: { 'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 5000); // 넉넉하게 5000자
        return `[페이지: ${item.link}]\n${text}`;
      } catch { return null; }
    }));

    // 컨텍스트 구성 (스니펫 + 페이지 내용)
    let context = allResults.slice(0, 12).map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || ''}\n${o.link ? 'URL: '+o.link : ''}`
    ).join('\n\n');

    const pageTexts = pageContents
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .join('\n\n');

    if (pageTexts) context += '\n\n=== 페이지 상세 내용 ===\n' + pageTexts;

    // ────────────────────────────────────────────
    // 3. Gemini 호출 — JSONL 형식 (한 줄 = 하나의 아이템)
    //    JSON 배열 대신 JSONL → 토큰 잘려도 앞 항목은 살아있음
    // ────────────────────────────────────────────
    send({ type:'status', message:'AI가 열심히 분석 중이에요...' });

    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    const prompt =
      `You are a release curator. Extract ALL upcoming items for "${keyword}" from the sources.\n` +
      `Today: ${TODAY}. Only include items with release date >= ${TODAY}.\n\n` +
      `## CATEGORIES\n` +
      `PRODUCT: fashion/sneakers/tech goods | EVENT: popup/concert/exhibition/fanmeeting\n` +
      `CULTURE: album/movie/book premiere   | CONTENT: game/streaming/digital drop\n\n` +
      `## DATE RULES\n` +
      `- Prefer dates from NEWS ARTICLES over official brand sites (news has explicit dates in text)\n` +
      `- Exact date found → "YYYY-MM-DD"\n` +
      `- Month only → "YYYY-MM"\n` +
      `- Date range → "YYYY-MM-DD~DD"\n` +
      `- Quarter/season/year only/unclear → "TBD"\n` +
      `- DO NOT guess or infer. Copy dates verbatim from source.\n` +
      `- Year in product name ≠ release year (e.g. FW26 collection ≠ released in 2026 necessarily)\n\n` +
      `## SOURCE RULES\n` +
      `- Do NOT use Facebook, Threads, personal blogs as link sources\n` +
      `- Prefer official brand sites or major media outlets for the link field\n\n` +
      `Each line must be a complete, valid JSON object. No trailing commas.\n` +
      `{"category":"PRODUCT","brand":"${keyword}","item_name":"...","release_date":"...","description":"한 줄 한국어 설명","image_url":"","link":"..."}\n` +
      `{"category":"EVENT","brand":"${keyword}","item_name":"...","release_date":"...","description":"...","image_url":"","link":"..."}\n\n` +
      `Extract ALL items found. If none, output nothing.\n\n` +
      `## SOURCES\n${context}`;

    let gr, attempt = 0;
    while (attempt < 3) {
      gr = await fetch(GEMINI_URL, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          contents:[{ parts:[{ text: prompt }] }],
          generationConfig:{ temperature:0, maxOutputTokens:8192 },
          safetySettings:[
            { category:'HARM_CATEGORY_HARASSMENT',        threshold:'BLOCK_NONE' },
            { category:'HARM_CATEGORY_HATE_SPEECH',       threshold:'BLOCK_NONE' },
            { category:'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold:'BLOCK_NONE' },
            { category:'HARM_CATEGORY_DANGEROUS_CONTENT', threshold:'BLOCK_NONE' },
          ],
        }),
      });
      if (gr.ok) break;
      if (gr.status === 503 && attempt < 2) {
        send({ type:'status', message:`소식이 많아 찾는 데 시간이 조금 더 걸려요... (${attempt+1}/3)` });
        await new Promise(r => setTimeout(r, (attempt+1)*1500));
        attempt++;
        continue;
      }
      const errBody = await gr.text().catch(() => '');
      console.error(`[hunt] Gemini ${gr.status}:`, errBody.slice(0, 200));
      throw new Error(`Gemini HTTP ${gr.status}`);
    }

    const gd = await gr.json();
    if (gd.error) throw new Error(`Gemini: ${gd.error.message}`);

    const fullText = (gd.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();

    // ────────────────────────────────────────────
    // 4. JSONL 파싱 — 한 줄씩 파싱 (잘려도 앞 항목 살아있음)
    // ────────────────────────────────────────────
    const items = [];
    for (const line of fullText.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const obj = JSON.parse(t.endsWith('}') ? t : t + '}');
        if (obj.item_name && obj.release_date) items.push(obj);
      } catch { /* 잘린 줄 무시 */ }
    }

    console.log(`[hunt] items parsed: ${items.length}`);

    // ────────────────────────────────────────────
    // 5. 날짜 유효성 필터
    // ────────────────────────────────────────────
    const getBaseDate = d => {
      if (!d || d === 'TBD') return null;
      const base = d.split('~')[0];
      return /^\d{4}-\d{2}$/.test(base) ? base+'-01' : base;
    };
    const isValidFmt = d =>
      d === 'TBD' ||
      /^\d{4}-\d{2}$/.test(d) ||
      /^\d{4}-\d{2}-\d{2}$/.test(d) ||
      /^\d{4}-\d{2}-\d{2}~\d{1,2}$/.test(d) ||
      /^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(d);

    const valid = items.filter(item => {
      if (!item.release_date || !isValidFmt(item.release_date)) return false;
      const base = getBaseDate(item.release_date);
      if (base && base < TODAY) return false;
      // Gemini 출력 링크도 차단 도메인 필터
      if (item.link && isBlocked(item.link)) return false;
      if (!item.brand?.trim()) item.brand = keyword;
      const key = `${item.item_name}||${item.release_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[hunt] valid items: ${valid.length}`);
    if (!valid.length) { send({ type:'done', total:0 }); return; }

    // 거의 완료 메시지
    send({ type:'status', message:`${valid.length}개 찾았어요! 이미지 가져오는 중...` });

    await Promise.allSettled(valid.map(async item => {
      try {
        // 이미지 검색은 영어로 + 따옴표 제거 (한국어 쿼리는 이미지 결과 없음)
        const imgQuery = `${item.brand} ${item.item_name}`
          .replace(/["""'']/g, '')   // 따옴표 제거
          .replace(/[\u3131-\uD79D]/gu, '') // 한국어 제거
          .replace(/\s+/g, ' ').trim()
          || `${item.brand} ${item.item_name}`.replace(/["""'']/g, '');
        const ir = await fetch('https://google.serper.dev/images', {
          method:'POST',
          headers:{ 'X-API-KEY':SERPER_KEY, 'Content-Type':'application/json' },
          body: JSON.stringify({ q: imgQuery, num:3, gl:'us', hl:'en' }),
        });
        if (!ir.ok) return;
        const id = await ir.json();
        // 첫 번째 유효한 이미지 URL 사용
        const img = (id.images || []).find(i => i.imageUrl && i.imageUrl.startsWith('http'));
        if (img) item.image_url = img.imageUrl;
      } catch {}
    }));

    // 날짜 확정 우선, TBD는 뒤로 정렬
    valid
      .sort((a, b) => {
        if (a.release_date === 'TBD') return 1;
        if (b.release_date === 'TBD') return -1;
        const da = getBaseDate(a.release_date) || '9999-12-31';
        const db = getBaseDate(b.release_date) || '9999-12-31';
        return da.localeCompare(db);
      })
      .forEach(item => send({ type:'item', data:item }));

    send({ type:'done', total:valid.length });

  } catch(err) {
    console.error('[hunt] Error:', err.message);
    send({ type:'error', message:err.message });
  } finally {
    res.end();
  }
}
