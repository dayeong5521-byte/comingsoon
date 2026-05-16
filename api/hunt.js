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
    const queries = [
      // 일반 검색 (한국어 + 영어)
      { endpoint:'/search', body:{ q:`${keyword} 출시일 발매일 ${CY} ${CY+1}`, gl:'kr', hl:'ko', num:8 } },
      { endpoint:'/search', body:{ q:`${keyword} release date announced ${CY} ${CY+1}`, gl:'us', hl:'en', num:8 } },
      // 뉴스 검색 — 블로그/SNS 제외, 언론사만
      { endpoint:'/news',   body:{ q:`${keyword} 출시 발매 ${CY}`, gl:'kr', hl:'ko', num:5 } },
      { endpoint:'/news',   body:{ q:`${keyword} release date ${CY}`, gl:'us', hl:'en', num:5 } },
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

    // ── 상위 2개 페이지 병렬 fetch (최대 3초, 정확도 향상) ──
    const toFetch = allItems
      .filter(o => !['instagram.com','twitter.com','x.com','youtube.com']
        .some(d => o.link?.includes(d)))
      .slice(0, 2);

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
        // 스크립트/스타일 제거 후 텍스트만 추출, 2500자 제한
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2500);
        return `[페이지 전문: ${item.link}]\n${text}`;
      } catch { return null; }
    }));

    const pageContext = pageResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .join('\n\n');

    if (pageContext) context += '\n\n' + pageContext;

    // ── 2. Gemini 호출 ──────────────────────────────────
    // gemini-2.5-flash: v1beta 지원 stable 버전
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    const prompt =
      `You extract upcoming release dates for "${keyword}" from search results.\n\n` +
      `SOURCE RULES (STRICT):\n` +
      `- TRUST: official brand websites, major news outlets, official SNS accounts (instagram.com/[brand], twitter.com/[brand], x.com/[brand])\n` +
      `- IGNORE: personal/fan SNS accounts (low follower count indicators, fan-made content, rumor accounts)\n` +
      `- IGNORE: personal blogs, forums, community posts\n` +
      `- For SNS sources: only trust if the account name matches the brand/artist being searched (e.g. instagram.com/nike for Nike)\n` +
      `- If uncertain whether SNS account is official → use "TBD" for date, still include item\n\n` +
      `DATE RULES (STRICT):\n` +
      `- release_date must be ${TODAY} or later in YYYY-MM-DD format, OR exactly "TBD"\n` +
      `- Only use dates EXPLICITLY stated as release/launch dates in the source\n` +
      `- !! Do NOT use a year in a product NAME as the release year\n` +
      `  (e.g. "2026 Season's Greetings", "2026 CALENDAR" → the year is in the title, NOT necessarily the release year)\n` +
      `- Month known but not exact day → use "TBD"\n` +
      `- Season only → spring=${CY}-04-01, summer=${CY}-07-01, fall=${CY}-10-01, winter=${CY}-12-01\n` +
      `- Quarter/분기 (Q1/Q2/Q3/Q4/1분기/2분기/3분기/4분기) → use "TBD"\n` +
      `- Year only → use "TBD"\n` +
      `- Any doubt → use "TBD"\n\n` +
      `OTHER RULES:\n` +
      `1. ONLY include items DIRECTLY about "${keyword}"\n` +
      `2. brand = official brand/maker name, item_name = specific product or event name\n` +
      `3. Return ONLY a raw JSON array. No markdown, no explanation.\n` +
      `4. If nothing qualifies, return: []\n\n` +
      `FORMAT:\n` +
      `[{"brand":"Apple","item_name":"iPhone 17 Pro","release_date":"2026-09-12","description":"한 줄 한국어 설명","image_url":"","link":"https://..."}]\n\n` +
      `Search results:\n${context}`;

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
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const valid = items.filter(item => {
      if (!item.release_date) return false;
      const isTBD = item.release_date === 'TBD';
      if (!isTBD && (!DATE_RE.test(item.release_date) || item.release_date < TODAY)) return false;
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
        if (a.release_date === 'TBD') return 1;
        if (b.release_date === 'TBD') return -1;
        return a.release_date.localeCompare(b.release_date);
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
