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
      { q:`${keyword} (${KO}) ${CY} ${CY+1}`,       gl:'kr', hl:'ko', num:10, tbs:'qdr:m6' },
      { q:`${keyword} (${EN} OR ${FW}) ${CY} ${CY+1}`,  gl:'us', hl:'en', num:10, tbs:'qdr:m6' },
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

    const BLOCKED = [
      'facebook.com','threads.net',
      'blog.naver.com','m.blog.naver.com','cafe.naver.com',
      'tistory.com','brunch.co.kr',
      'reddit.com','quora.com','dcinside.com',
    ];
    const isBlocked = url => BLOCKED.some(d => url?.includes(d));

    const seenUrls = new Set();
    const allResults = [];
    for (const sd of searchResponses) {
      if (!sd) continue;
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
    // 2. 상위 페이지 fetch
    // ────────────────────────────────────────────
    send({ type:'status', message:'페이지 내용 수집 중...' });

    const LIST_KEYWORDS = ['release-date','release-dates','schedule','calendar',
      'lineup','upcoming','drop-list','출시일정','발매일정'];
    const isListPage = url => LIST_KEYWORDS.some(k => url?.toLowerCase().includes(k));

    const sortedResults = [
      ...allResults.filter(o => o.link && isListPage(o.link)),
      ...allResults.filter(o => o.link && !isListPage(o.link)),
    ];

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
          .slice(0, 5000); 
        return `[페이지: ${item.link}]\n${text}`;
      } catch { return null; }
    }));

    let context = allResults.slice(0, 12).map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || ''}\n${o.link ? 'URL: '+o.link : ''}`
    ).join('\n\n');

    const pageTexts = pageContents
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .join('\n\n');

    if (pageTexts) context += '\n\n=== 페이지 상세 내용 ===\n' + pageTexts;

    // ────────────────────────────────────────────
    // 3. Gemini 호출 — 💡 잃어버린 프롬프트 복구 & 완벽한 1.5 우회망 적용
    // ────────────────────────────────────────────
    send({ type:'status', message:'AI 분석 중...' });

    // 🌟 핵심: 이 영어 텍스트 덩어리(프롬프트)가 있어야 AI가 일을 합니다!
    const prompt =
      `You are a release curator. Extract ALL upcoming items for "${keyword}" from the sources.\n` +
      `Today: ${TODAY}. Only include items with release date >= ${TODAY}.\n\n` +
      `## CATEGORIES\n` +
      `PRODUCT: fashion/sneakers/tech goods | EVENT: popup/concert/exhibition/fanmeeting\n` +
      `CULTURE: album/movie/book premiere   | CONTENT: game/streaming/digital drop\n\n` +
      `## DATE RULES\n` +
      `- CRITICAL: Distinguish between the "article publication date" and the "actual event/release date". NEVER extract the publication date of the webpage as the release_date.\n` +
      `- If the text says "Next Friday" or "Tomorrow", calculate the exact date based on Today (${TODAY}).\n` +
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
    // 2.5-flash 전용 URL
    const MODEL_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    while (attempt < 3) {
      gr = await fetch(MODEL_URL, {
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

      // 3. Gemini 호출 루프 직후...
    const gd = await gr.json();
    
    // 💡 1단계: 명시적 API 오류 확인
    if (gd.error) {
      throw new Error(`Gemini API 오류 (${gd.error.code}): ${gd.error.message}`);
    }

    // 💡 2단계: 응답 구조 2중 검사 (구조가 꼬였을 때 대비)
    if (!gd.candidates || !gd.candidates[0] || !gd.candidates[0].content) {
      console.error('[hunt] 비정상 응답:', JSON.stringify(gd));
      throw new Error('AI가 결과를 생성하지 않았습니다. (응답 데이터 구조 오류)');
    }

    // 💡 3단계: 안전하게 텍스트 추출
    const fullText = (gd.candidates[0].content.parts || [])
      .map(p => p.text || '')
      .join('')
      .trim();

    if (!fullText) {
      throw new Error('AI 분석 결과가 빈 값입니다. 검색 키워드를 다시 확인해주세요.');
    }

    console.log(`[hunt] 분석 성공, 텍스트 길이: ${fullText.length}`);

    // ────────────────────────────────────────────
    // 4. JSONL 파싱 (이후 기존 로직 동일)
    // ────────────────────────────────────────────
    const items = [];
    // ... (기존 JSONL 파싱 로직 사용)

    // ────────────────────────────────────────────
    // 4. JSONL 파싱
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
      /^\d{4}-(Q1|Q2|Q3|Q4)$/.test(d) ||
      /^\d{4}-\d{2}-(early|mid|late)$/.test(d) ||
      /^\d{4}-\d{2}-\d{2}~\d{1,2}$/.test(d) ||
      /^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(d);

    const valid = items.filter(item => {
      if (!item.release_date || !isValidFmt(item.release_date)) return false;
      const base = getBaseDate(item.release_date);
      if (base && base < TODAY) return false;
      if (item.link && isBlocked(item.link)) return false;
      if (!item.brand?.trim()) item.brand = keyword;
      const key = `${item.item_name}||${item.release_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const confirmed = valid.filter(i => i.release_date !== 'TBD');
    const tbdItems  = valid.filter(i => i.release_date === 'TBD'); 
    const finalList = [...confirmed, ...tbdItems];

    console.log(`[hunt] confirmed: ${confirmed.length}, tbd: ${tbdItems.length}`);
    if (!finalList.length) { send({ type:'done', total:0 }); return; }

    // ────────────────────────────────────────────
    // 6. 이미지 병렬 검색
    // ────────────────────────────────────────────
    send({ type:'status', message:`이미지 검색 중... (${finalList.length}개)` });

    await Promise.allSettled(finalList.map(async item => {
      try {
        const ir = await fetch('https://google.serper.dev/images', {
          method:'POST',
          headers:{ 'X-API-KEY':SERPER_KEY, 'Content-Type':'application/json' },
          body: JSON.stringify({ q:`${item.brand} ${item.item_name}`, num:1 }),
        });
        if (!ir.ok) return;
        const id = await ir.json();
        if (id.images?.[0]) item.image_url = id.images[0].imageUrl;
      } catch {}
    }));

    finalList
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
