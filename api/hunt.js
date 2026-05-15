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

  // ── SSE 헤더 ──
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  // ✅ CORS 허용 (Vercel 환경에서 간혹 필요)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const seen = new Set();

  try {
    send({ type: 'status', message: `'${keyword}' 릴리즈 정보 수집 중...` });

    // ── 1. 릴리즈 특화 쿼리 2개를 병렬로 검색 ──
    const isKorean = /[ㄱ-ㅎ가-힣]/.test(keyword);
    const queries = isKorean
      ? [
          `"${keyword}" 출시일 발매일 출시예정 ${CY} ${CY + 1}`,
          `"${keyword}" 신제품 컴백 출시 일정 ${CY}`,
        ]
      : [
          `"${keyword}" release date upcoming ${CY} ${CY + 1}`,
          `"${keyword}" launch schedule drop date ${CY}`,
        ];

    const searchOpts = { gl: isKorean ? 'kr' : 'us', hl: isKorean ? 'ko' : 'en', num: 10 };

    const fetches = queries.map(q =>
      fetch('https://google.serper.dev/search', {
        method:  'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q, ...searchOpts }),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    );

    const [sd1, sd2] = await Promise.all(fetches);
    const allOrganics = [
      ...(sd1?.organic || []),
      ...(sd2?.organic || []),
    ];

    if (!allOrganics.length) throw new Error('검색 결과가 없습니다.');

    // ── 릴리즈 관련 키워드 필터 ──
    const RELEASE_WORDS = [
      '출시', '발매', '출간', '공개', '발표', '예정', '일정', '드롭', '컴백',
      'release', 'launch', 'drop', 'date', 'upcoming', 'schedule', 'available',
      CY.toString(), (CY + 1).toString(),
    ];

    // 중복 URL 제거 + 릴리즈 관련 내용만 필터링
    const seenUrls = new Set();
    const filtered = allOrganics.filter(o => {
      if (!o?.link || seenUrls.has(o.link)) return false;
      seenUrls.add(o.link);
      const text = `${o.title || ''} ${o.snippet || ''}`.toLowerCase();
      return RELEASE_WORDS.some(w => text.includes(w.toLowerCase()));
    });

    if (!filtered.length) throw new Error('릴리즈 관련 정보를 찾지 못했습니다.');

    // answerBox + topStories + 필터된 결과 컨텍스트 구성
    let context = '';
    const ab = sd1?.answerBox || sd2?.answerBox;
    if (ab?.answer || ab?.snippet) {
      context += `[직접 답변] ${ab.answer || ab.snippet}\n\n`;
    }
    const stories = [...(sd1?.topStories || []), ...(sd2?.topStories || [])].slice(0, 4);
    if (stories.length) {
      context += stories.map(s => `[최신뉴스] ${s.title} ${s.date || ''}`).join('\n') + '\n\n';
    }
    context += filtered.map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || ''}\nURL: ${o.link}${o.date ? '\nDate: ' + o.date : ''}`
    ).join('\n\n');

    send({ type: 'status', message: `AI 분석 중... (${filtered.length}개 릴리즈 정보 발견)` });

    // ── 2. Gemini 호출 — 503 시 최대 3회 재시도 ──
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    const GEMINI_BODY = JSON.stringify({
      contents: [{ parts: [{ text:
        `You are a release date extractor. Extract ALL upcoming product/event release dates for "${keyword}".\n` +
        `Today is ${TODAY}. Include ONLY items with release_date >= ${TODAY}.\n\n` +
        `RULES:\n` +
        `- release_date must be YYYY-MM-DD format\n` +
        `- If only month/season is given, estimate: spring=03-21, summer=06-21, fall=09-21, winter=12-01\n` +
        `- If only year is given, use ${CY}-12-31\n` +
        `- brand: use the official brand/artist name\n` +
        `- item_name: specific product or event name\n` +
        `- link: use the URL from the search result\n` +
        `- description: one-line Korean summary\n` +
        `- Return ONLY a valid JSON array. No markdown, no explanation.\n\n` +
        `OUTPUT FORMAT:\n` +
        `[{"brand":"Nike","item_name":"Air Jordan 1 Retro","release_date":"2026-06-15","description":"레트로 컬러웨이 한정 출시","image_url":"","link":"https://..."}]\n\n` +
        `Search results for "${keyword}":\n${context}`
      }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    });

    let gr, attempt = 0;
    while (attempt < 3) {
      gr = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: GEMINI_BODY,
      });
      if (gr.ok) break;
      if (gr.status === 503 && attempt < 2) {
        // 503: 서버 과부하 → 잠시 대기 후 재시도 (1초, 2초)
        send({ type: 'status', message: `AI 서버 혼잡, 재시도 중... (${attempt + 1}/3)` });
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
        attempt++;
        continue;
      }
      throw new Error(`Gemini HTTP ${gr.status}`);
    }
    const gd = await gr.json();
    if (gd.error) throw new Error(`Gemini: ${gd.error.message}`);

    const txt = gd.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // ✅ JSON 파싱 — 마크다운 코드블록 제거 후 시도
    const cleaned = txt.replace(/```json|```/gi, '').trim();
    const start   = cleaned.indexOf('[');
    const end     = cleaned.lastIndexOf(']') + 1;
    if (start === -1 || end === 0) throw new Error('AI가 올바른 형식을 반환하지 않았습니다.');

    let items;
    try {
      items = JSON.parse(cleaned.slice(start, end));
    } catch {
      throw new Error('AI 응답 JSON 파싱 실패');
    }

    // ✅ 유효 아이템 필터링
    const valid = items.filter(item => {
      if (!item.release_date || item.release_date < TODAY) return false;
      if (!item.brand?.trim()) item.brand = keyword.toUpperCase();
      const key = `${item.item_name}||${item.release_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (valid.length === 0) {
      send({ type: 'done', total: 0 });
      return;
    }

    send({ type: 'status', message: `이미지 검색 중... (${valid.length}개)` });

    // ── 3. 이미지 병렬 검색 ──
    await Promise.allSettled(
      valid.map(async item => {
        try {
          const ir  = await fetch('https://google.serper.dev/images', {
            method:  'POST',
            headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ q: `${item.brand} ${item.item_name}`, num: 1 }),
          });
          if (!ir.ok) return;
          const id_ = await ir.json();
          if (id_.images?.[0]) item.image_url = id_.images[0].imageUrl;
        } catch { /* 이미지 없어도 계속 진행 */ }
      })
    );

    // ── 날짜순 정렬 후 전송 ──
    valid
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .forEach(item => send({ type: 'item', data: item }));

    send({ type: 'done', total: valid.length });

  } catch (err) {
    console.error('[hunt] Error:', err.message);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
}
