// api/hunt.js — Jina 제거, Serper snippet 직접 사용 (속도 대폭 개선)
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
    send({ type: 'status', message: `'${keyword}' 검색 중...` });

    // 1. Serper 검색 — snippet + title + date 포함
    const sr = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q  : `${keyword} release date ${CY} ${CY + 1}`,
        gl : 'us', hl: 'en', num: 10
      }),
    });
    const sd = await sr.json();
    if (!sd.organic) throw new Error('Serper API 오류');

    // Serper 결과에서 컨텍스트 조합 (Jina 없이)
    const context = sd.organic.map((o, i) =>
      `[${i+1}] ${o.title}\n${o.snippet || ''}\nURL: ${o.link}\n${o.date ? 'Date: '+o.date : ''}`
    ).join('\n\n');

    send({ type: 'status', message: 'AI 분석 중...' });

    // 2. Gemini 한 번만 호출
    const gr = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text:
            `Extract ALL upcoming release/event dates for "${keyword}" from the search results below.\n` +
            `Today is ${TODAY}. Only include dates >= ${TODAY}.\n` +
            `If date is vague (season/month), estimate a specific date.\n` +
            `Return ONLY a raw JSON array, no markdown.\n\n` +
            `Format: [{"brand":"Name","item_name":"Product","release_date":"YYYY-MM-DD","description":"한 줄 설명","image_url":"","link":"URL"}]\n\n` +
            `Search results:\n${context}`
          }] }],
          generationConfig: { temperature: 0.1 },
          safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
        }),
      }
    );
    const gd = await gr.json();
    if (gd.error) throw new Error(`Gemini: ${gd.error.message}`);

    const txt   = gd.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const start = txt.indexOf('['), end = txt.lastIndexOf(']') + 1;
    if (start === -1 || end === 0) throw new Error('결과를 파싱할 수 없습니다.');

    const items = JSON.parse(txt.slice(start, end));
    const valid = items.filter(item => {
      if (!item.release_date || item.release_date < TODAY) return false;
      if (!item.brand?.trim()) item.brand = keyword.toUpperCase();
      const key = `${item.item_name}||${item.release_date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    send({ type: 'status', message: `이미지 검색 중... (${valid.length}개)` });

    // 3. 이미지 검색 병렬
    await Promise.allSettled(
      valid.map(async item => {
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
    valid
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .forEach(item => send({ type: 'item', data: item }));

    send({ type: 'done', total: valid.length });

  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
}
