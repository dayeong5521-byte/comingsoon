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

    // ── 1. 한국어 + 영어 동시 검색 → 결과 합산 ──────────────
    // 입력 언어 관계없이 항상 양쪽 검색 → "애플" = "apple" 동일 결과
    const queries = [
      { q: `${keyword} 출시일 발매일 출시예정 ${CY} ${CY + 1}`, gl: 'kr', hl: 'ko' },
      { q: `${keyword} release date upcoming announced ${CY} ${CY + 1}`, gl: 'us', hl: 'en' },
    ];

    const searchResults = await Promise.all(queries.map(opt =>
      fetch('https://google.serper.dev/search', {
        method:  'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: opt.q, gl: opt.gl, hl: opt.hl, num: 10 }),
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ));

    const [sdKr, sdEn] = searchResults;

    // 중복 URL 제거 후 합산
    const seenUrls = new Set();
    const allOrganics = [...(sdKr?.organic || []), ...(sdEn?.organic || [])]
      .filter(o => {
        if (!o?.link || seenUrls.has(o.link)) return false;
        seenUrls.add(o.link);
        return true;
      });

    if (!allOrganics.length) throw new Error('검색 결과가 없습니다.');

    // 컨텍스트 구성
    let context = '';
    const ab = sdKr?.answerBox || sdEn?.answerBox;
    if (ab?.answer || ab?.snippet)
      context += `[직접답변] ${ab.answer || ab.snippet}\n\n`;
    const stories = [...(sdKr?.topStories || []), ...(sdEn?.topStories || [])].slice(0, 4);
    if (stories.length)
      context += stories.map(s => `[뉴스] ${s.title} ${s.date || ''}`).join('\n') + '\n\n';
    context += allOrganics.map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || ''}\nURL: ${o.link}${o.date ? '\nDate: '+o.date : ''}`
    ).join('\n\n');

    send({ type: 'status', message: 'AI 분석 중...' });

    // ── 2. Gemini 호출 ──────────────────────────────────
    // gemini-2.5-flash-preview-05-20: 현재 안정 버전
    const GEMINI_URL =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_KEY}`;

    const prompt =
      `You extract upcoming release information. The user searched for: "${keyword}"\n\n` +
      `STRICT RULES:\n` +
      `1. ONLY include items DIRECTLY about "${keyword}". Reject anything unrelated.\n` +
      `2. release_date must be ${TODAY} or later, in YYYY-MM-DD format.\n` +
      `3. Vague dates: spring=${CY}-04-01, summer=${CY}-07-01, fall=${CY}-10-01, winter=${CY}-12-01.\n` +
      `4. If only a year is known with no other hint, SKIP that item (do not guess 12-31).\n` +
      `5. brand = official brand/maker. item_name = specific product or event name.\n` +
      `6. Return ONLY a raw JSON array — no markdown, no text, no code fences.\n` +
      `7. If nothing qualifies, return: []\n\n` +
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
          generationConfig: { temperature: 0, maxOutputTokens: 2048 },
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

    // thinking 파트 제외 후 실제 텍스트 추출
    const parts = gd.candidates?.[0]?.content?.parts || [];
    const txt   = parts.filter(p => !p.thought).map(p => p.text || '').join('').trim();

    // JSON 파싱
    const cleaned = txt.replace(/```json|```/gi, '').trim();
    const start   = cleaned.indexOf('[');
    const end     = cleaned.lastIndexOf(']') + 1;
    if (start === -1 || end === 0) throw new Error('AI가 올바른 형식을 반환하지 않았습니다.');

    let items;
    try { items = JSON.parse(cleaned.slice(start, end)); }
    catch { throw new Error('AI 응답 JSON 파싱 실패'); }

    // 유효 아이템 필터 — YYYY-MM-DD 형식 + 오늘 이후만
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const valid = items.filter(item => {
      if (!item.release_date || !DATE_RE.test(item.release_date)) return false;
      if (item.release_date < TODAY) return false;
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
