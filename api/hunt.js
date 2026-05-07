export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;

  if (!GEMINI_KEY || !SERPER_KEY)
    return res.status(500).json({ error: 'API 키가 서버에 없습니다.' });

  const { keyword } = req.body;
  if (!keyword?.trim())
    return res.status(400).json({ error: '키워드를 입력해주세요.' });

  const TODAY   = new Date().toISOString().split('T')[0];
  const CY      = new Date().getFullYear();

  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send  = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const seen  = new Set();

  try {
    send({ type: 'status', message: `'${keyword}' 웹 수색 중...` });

    const sr = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: `${keyword} release date schedule ${CY} ${CY+1}`, gl:'us', hl:'en', num:8 }),
    });
    const sd = await sr.json();
    if (!sd.organic) throw new Error('Serper API 오류');
    const links = sd.organic.map(o => o.link);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      send({ type: 'status', message: `[${i+1}/${links.length}] 딥 리딩 중...` });

      try {
        const pr  = await fetch(`https://r.jina.ai/${link}`, { signal: AbortSignal.timeout(12000) });
        const pc  = await pr.text();

        const gr  = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text:
              `Extract future releases for "${keyword}" from today ${TODAY}.\n` +
              `Rules: 1) Only dates >= ${TODAY} 2) Estimate vague dates 3) ONLY raw JSON array\n` +
              `Format: [{"brand":"","item_name":"","release_date":"YYYY-MM-DD","description":"","image_url":"","link":"${link}"}]\n` +
              `Context:\n${pc.slice(0, 7000)}`
            }] }],
            generationConfig: { temperature: 0.1 },
            safetySettings:   [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
          }),
        });
        const gd  = await gr.json();
        if (gd.error) { send({ type: 'status', message: `Gemini 오류: ${gd.error.message}` }); continue; }

        const txt   = gd.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const start = txt.indexOf('['), end = txt.lastIndexOf(']') + 1;
        if (start === -1 || end === 0) continue;

        const items = JSON.parse(txt.slice(start, end));

        for (const item of items) {
          if (!item.release_date || item.release_date < TODAY) continue;
          if (!item.brand?.trim()) item.brand = keyword.toUpperCase();

          const key = `${item.item_name}||${item.release_date}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // 이미지 검색
          try {
            const ir  = await fetch('https://google.serper.dev/images', {
              method:  'POST',
              headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ q: `${item.brand} ${item.item_name}`, num: 1 }),
            });
            const id_ = await ir.json();
            if (id_.images?.[0]) item.image_url = id_.images[0].imageUrl;
          } catch {}

          send({ type: 'item',   data: item });
          send({ type: 'status', message: `✓ 확보: ${item.item_name}` });
        }
      } catch {}

      if (i < links.length - 1)
        await new Promise(r => setTimeout(r, 1000));
    }

    send({ type: 'done', total: seen.size });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
}
