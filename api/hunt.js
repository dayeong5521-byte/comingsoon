// api/hunt.js
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;
  if (!GEMINI_KEY || !SERPER_KEY)
    return res.status(500).json({ error: 'API 키가 서버에 설정되지 않았습니다.' });

  const { keyword } = req.body;
  if (!keyword?.trim())
    return res.status(400).json({ error: '키워드를 입력해주세요.' });

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
    send({ type: 'status', message: `'${keyword}' 검색 중...` });

    // ── 1. 검색 + 뉴스 병렬 실행 ──────────────────────────
    // 한국어/영어 혼합 OR 확장어 (모든 카테고리 커버)
    const KO = '출시 OR 발매 OR 오픈 OR 개봉 OR 공연 OR 전시 OR 팝업 OR 출간 OR 드롭 OR 티켓팅 OR 컴백';
    const EN = 'release OR launch OR drop OR open OR concert OR exhibition OR collab OR collection OR premiere';
    const TERMS = `(${KO} OR ${EN})`;
    const FW = `FW${String(CY).slice(2)} OR SS${String(CY+1).slice(2)}`; // 패션 시즌

    const queries = [
      // 쿼리 1: 한국어 OR 확장어 + 한국 구글
      { endpoint:'/search', body:{ q:`${keyword} ${TERMS} ${CY} ${CY+1}`, gl:'kr', hl:'ko', num:10 } },
      // 쿼리 2: 영어 OR 확장어 + 미국 구글 (한국어 키워드도 영어 결과 가져옴)
      { endpoint:'/search', body:{ q:`${keyword} ${EN} ${FW} ${CY} ${CY+1}`, gl:'us', hl:'en', num:8 } },
      // 쿼리 3: 뉴스 (언론사 기사 우선)
      { endpoint:'/news',   body:{ q:`${keyword} ${TERMS} ${CY}`, gl:'kr', hl:'ko', num:5 } },
    ];

    const responses = await Promise.all(queries.map(opt =>
      fetch(`https://google.serper.dev${opt.endpoint}`, {
        method:  'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify(opt.body),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ));

    // 개인 블로그/커뮤니티만 차단, SNS는 허용 (공식 계정 포함 가능)
    const BLOCK_DOMAINS = [
      'blog.naver.com','m.blog.naver.com','cafe.naver.com',
      'tistory.com','brunch.co.kr','blog.daum.net',
      'blog.kakao.com','post.naver.com',
      'reddit.com','quora.com','pinterest.com',
      'dcinside.com','ruliweb.com','clien.net','fmkorea.com',
    ];
    const isBlocked = url => BLOCK_DOMAINS.some(d => url?.includes(d));

    // 중복 URL 제거 + 차단 도메인 필터
    const seenUrls = new Set();
    const allItems = [];
    for (const sd of responses) {
      if (!sd) continue;
      // 일반 검색 결과
      for (const o of (sd.organic || sd.news || [])) {
        if (!o?.link || seenUrls.has(o.link) || isBlocked(o.link)) continue;
        seenUrls.add(o.link);
        allItems.push(o);
      }
    }

    if (!allItems.length) throw new Error('신뢰할 수 있는 검색 결과가 없습니다.');

    // answerBox 추가
    let context = '';
    const ab = responses[0]?.answerBox || responses[1]?.answerBox;
    if (ab?.answer || ab?.snippet)
      context += `[직접답변] ${ab.answer || ab.snippet}\n\n`;
    context += allItems.map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || o.snippet || ''}\nURL: ${o.link}${o.date ? '\nDate: '+o.date : ''}`
    ).join('\n\n');

    send({ type: 'status', message: 'AI 분석 중...' });

    // ── 상위 2개 페이지 fetch + 날짜 포함 문장만 추출 ──────
    const toFetch = allItems
      .filter(o => !['instagram.com','twitter.com','x.com','youtube.com']
        .some(d => o.link?.includes(d)))
      .slice(0, 2);

    // 날짜가 포함된 문장만 추출 (Gemini 추측 여지 제거)
    const extractDateLines = text => {
      if (!text) return '';
      return text.split(/[\n。.!?]/)
        .filter(line =>
          /\d{4}[\.\-\/년]\s*\d{1,2}|발매|출시|공연|콘서트|팬미팅|컴백|오픈|개최|일정|예정|release|launch|concert|tour|date|open/i
          .test(line) && line.trim().length > 10
        )
        .slice(0, 15)
        .join('\n');
    };

    const pageResults = await Promise.allSettled(toFetch.map(async item => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(item.link, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        // 날짜 포함 문장만 전달 (노이즈 제거)
        const dateLines = extractDateLines(text);
        return dateLines ? `[${item.link} 날짜 관련 내용]\n${dateLines}` : null;
      } catch { return null; }
    }));

    const pageContext = pageResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .join('\n\n');

    if (pageContext) context += '\n\n' + pageContext;

    // ── 2. Gemini 호출 ──────────────────────────────────
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    const prompt =
      `You are a release curator. Extract upcoming release/event schedule for "${keyword}".\n` +
      `Today: ${TODAY}. Only include items releasing on or after ${TODAY}.\n\n` +
      `## CATEGORIES\n` +
      `Assign one category per item:\n` +
      `- PRODUCT: fashion, sneakers, tech, goods, merchandise\n` +
      `- EVENT: popup store, launch party, exhibition, fan meeting, concert, tour\n` +
      `- CULTURE: movie premiere, book release, album, drama/anime air date\n` +
      `- CONTENT: game update, digital drop, streaming release\n\n` +
      `## DATE RULES\n` +
      `DO NOT infer or guess. Only use dates EXPLICITLY written in source.\n` +
      `- Day known → "YYYY-MM-DD"\n` +
      `- Month known, day unknown → "YYYY-MM"\n` +
      `- Range → "YYYY-MM-DD~DD"\n` +
      `- Season/Quarter/Year only/Unclear → "TBD"\n` +
      `- Year in product NAME ≠ release year (e.g. "FW26 Collection" → find actual drop date)\n\n` +
      `## SOURCE RULES\n` +
      `Trust: official sites, major media. Ignore: personal blogs, fan accounts, rumors.\n\n` +
      `## OUTPUT (raw JSON array only, no markdown)\n` +
      `[{"category":"PRODUCT|EVENT|CULTURE|CONTENT","brand":"${keyword}","item_name":"...","release_date":"...","description":"한 줄 한국어 설명","image_url":"","link":"..."}]\n` +
      `If nothing found: []\n\n` +
      `## SOURCES\n${context}`;

    let gr, attempt = 0;
    while (attempt < 3) {
      gr = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        }),
      });
      if (gr.ok) break;
      if (gr.status === 503 && attempt < 2) {
        send({ type: 'status', message: `AI 서버 혼잡, 재시도 중... (${attempt + 1}/3)` });
        await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
        attempt++;
        continue;
      }
      // 상세 에러 로깅
      const errBody = await gr.text().catch(() => '');
      console.error(`[hunt] Gemini ${gr.status}:`, errBody);
      throw new Error(`Gemini HTTP ${gr.status}: ${errBody.slice(0, 200)}`);
    }

    const gd = await gr.json();
    if (gd.error) throw new Error(`Gemini: ${gd.error.message}`);

    // 모든 parts의 텍스트를 합쳐서 JSON 배열 추출 (thinking 여부 무관)
    const allParts = gd.candidates?.[0]?.content?.parts || [];
    const fullText = allParts.map(p => p.text || '').join('').trim();
    const cleaned  = fullText.replace(/```json|```/gi, '').trim();
    const start    = cleaned.indexOf('[');
    const end      = cleaned.lastIndexOf(']') + 1;
    if (start === -1 || end === 0) throw new Error('AI가 올바른 형식을 반환하지 않았습니다.');

    let items;
    try { items = JSON.parse(cleaned.slice(start, end)); }
    catch { throw new Error('AI 응답 JSON 파싱 실패'); }

    // 유효 아이템 필터 — YYYY-MM-DD 형식 + 오늘 이후만
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
      if (!item.brand?.trim()) item.brand = keyword.toUpperCase();
      const key = `${item.item_name}||${item.release_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!valid.length) { send({ type: 'done', total: 0 }); return; }

    send({ type: 'status', message: `이미지 검색 중... (${valid.length}개)` });

    // ── 3. 이미지 병렬 검색 ──────────────────────────────
    await Promise.allSettled(valid.map(async item => {
      try {
        const ir = await fetch('https://google.serper.dev/images', {
          method:  'POST',
          headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ q: `${item.brand} ${item.item_name}`, num: 1 }),
        });
        if (!ir.ok) return;
        const id_ = await ir.json();
        if (id_.images?.[0]) item.image_url = id_.images[0].imageUrl;
      } catch { /* 이미지 없어도 진행 */ }
    }));

    valid
      .sort((a, b) => {
        const da = getBaseDate(a.release_date) || '9999-12-31';
        const db = getBaseDate(b.release_date) || '9999-12-31';
        return da.localeCompare(db);
      })
      .forEach(item => send({ type: 'item', data: item }));

    send({ type: 'done', total: valid.length });

  } catch (err) {
    console.error('[hunt] Error:', err.message);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
}
