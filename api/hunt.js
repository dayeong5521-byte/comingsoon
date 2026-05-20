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
    // ────────────────────────────────────────────
    send({ type:'status', message:'페이지 내용 수집 중...' });

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

    // 컨텍스트
