// api/hunt.js — 병렬 처리로 속도 개선
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
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const seen = new Set();

  try {
    send({ type: 'status', message: `'${keyword}' 웹 수색 중...` });

    // 1. Serper 검색
    const sr = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        q: `${keyword} release date schedule ${CY} ${CY + 1}`,
        gl: 'us', hl: 'en', num: 8
      }),
    });
    const sd = await sr.json();
    if (!sd.organic) throw new Error('Serper API 오류. 키를 확인해주세요.');
    const links = sd.organic.map(o => o.link);

    send({ type: 'status', message: `${links.length}개 페이지 병렬 분석 중...` });

    // 2. ✅ 병렬 처리 — 모든 링크를 동시에 처리
    const results = await Promise.allSettled(
      links.map(async (link) => {
        try {
          // Jina Reader 타임아웃 8초
          const pr = await fetch(`https://r.jina.ai/${link}`, {
            signal: AbortSignal.timeout(8000)
          });
          const pc = await pr.text();

          const gr = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text:
                  `Extract future release/event data for "${keyword}" from today ${TODAY} onwards.\n` +
                  `Rules: 1) Only dates >= ${TODAY} 2) Estimate specific dates if vague 3) Return ONLY raw JSON array, no markdown\n` +
                  `Format: [{"brand":"Name","item_name":"Product","release_date":"YYYY-MM-DD","description":"one sentence","image_url":"","link":"${link}"}]\n` +
                  `Context:\n${pc.slice(0, 7000)}`
                }] }],
                generationConfig: { temperature: 0.1 },
                safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
              }),
            }
          );
          const gd = await gr.json();
          if (gd.error) return [];

          const txt   = gd.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          const start = txt.indexOf('['), end = txt.lastIndexOf(']') + 1;
          if (start === -1 || end === 0) return [];

          return JSON.parse(txt.slice(start, end));
        } catch {
          return [];
        }
      })
    );

    // 3. 결과 수집 + 이미지 검색 (병렬)
    const allExtracted = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
          if (!item.release_date || item.release_date < TODAY) continue;
          if (!item.brand?.trim()) item.brand = keyword.toUpperCase();
          const key = `${item.item_name}||${item.release_date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allExtracted.push(item);
        }
      }
    }

    // 이미지 검색도 병렬
    await Promise.allSettled(
      allExtracted.map(async (item) => {
        try {
          const ir  = await fetch('https://google.serper.dev/images', {
            method:  'POST',
            headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
            body:    JSON.stringify({ q: `${item.brand} ${item.item_name}`, num: 1 }),
          });
          const id_ = await ir.json();
          if (id_.images?.[0]) item.image_url = id_.images[0].imageUrl;
        } catch {}
      })
    );

    // 날짜순 정렬 후 전송
    allExtracted
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .forEach(item => {
        send({ type: 'item', data: item });
      });

    send({ type: 'done', total: allExtracted.length });

  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
}
