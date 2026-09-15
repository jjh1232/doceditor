'use strict';
/*
 * 배포 후 라이브 검증.   npm run verify   (npm run verify -- --wait 20  전파를 기다렸다가)
 *
 * 빌드가 멀쩡해도 라우트가 안 걸리거나, 접두사가 안 붙거나, 엣지가 옛 것을 들고 있는 일이 있다.
 * 상태 코드만 보면 안 되는 이유 — 헌법이 기록한 사고들:
 *   · 리다이렉트 Location 에 접두사가 빠지면 도구 밖으로 튕긴다.
 *   · 루트 언어 302 에 `Cache-Control: no-store` 가 없으면 첫 방문자의 언어가 전원에게 나간다.
 * **허브와 이웃 도구도 같이 찍는다.** 라우트가 잘못 겹치면 거기가 먼저 죽는다.
 *
 * 이 도구는 Astro · 끝 슬래시 없음이다 (헌법 §4). 순수 HTML 템플릿의 verify 와 주소 모양이 다르다.
 */
const TOOL = 'doceditor';
const ORIGIN = 'https://prelaps.com';
const LANGS = ['ko', 'en', 'ja'];
const XDEFAULT = 'en';

/**
 * 이름이 고정인 자산. CSS·JS 는 Astro 가 해시를 붙여(_astro/…) 이름이 매번 바뀌므로
 * 여기 적지 않고, 아래에서 한국어판 HTML 이 실제로 가리키는 파일을 찾아 찌른다.
 */
const ASSETS = ['sitemap-index.xml', 'sitemap-0.xml', 'og.png'];

let fails = 0;
const rows = [];
const ok = (name, detail) => rows.push(['ok ', name, detail]);
const bad = (name, detail) => { fails++; rows.push(['✗  ', name, detail]); };

/** 엣지 캐시를 피한다. 방금 올린 것을 보려는 것이지 캐시를 보려는 게 아니다. */
const bust = (u) => u + (u.includes('?') ? '&' : '?') + 'cb=' + Math.random().toString(36).slice(2);
/** Location 에서 캐시 회피용 쿼리와 오리진을 걷어 비교하기 쉽게 만든다. */
const clean = (loc) => (loc || '').replace(/[?&]cb=[^&]*/, '').replace(ORIGIN, '');

async function get(url, headers = {}) {
  const res = await fetch(bust(url), { method: 'GET', redirect: 'manual', headers });
  return {
    status: res.status,
    location: res.headers.get('location'),
    cache: res.headers.get('cache-control'),
    text: () => res.text(),
  };
}

async function main() {
  const waitArg = process.argv.indexOf('--wait');
  if (waitArg > -1) {
    const sec = Number(process.argv[waitArg + 1]) || 15;
    console.log(`자산 전파를 ${sec}초 기다린다…`);
    await new Promise((r) => setTimeout(r, sec * 1000));
  }

  // ── 언어 없는 루트: Accept-Language 로 302 ───────────────
  for (const [header, want] of [...LANGS.map((l) => [l, l]), ['de', XDEFAULT]]) {
    const r = await get(`${ORIGIN}/${TOOL}`, { 'accept-language': header });
    const to = clean(r.location);
    const name = `/${TOOL}  (Accept-Language: ${header})`;
    if (r.status !== 302) bad(name, `${r.status} — 302 여야 한다 (301 은 브라우저가 영구 캐시한다)`);
    else if (to !== `/${TOOL}/${want}`) bad(name, `→ ${to} — /${TOOL}/${want} 여야 한다 (끝 슬래시 없음)`);
    else if (!/no-store/.test(r.cache || '')) bad(name, `Cache-Control 이 '${r.cache}' — no-store 여야 한다`);
    else ok(name, `302 → ${to}`);
  }

  // ── 언어판: 200 · canonical 자기 자신 · <html lang> ─────
  for (const lang of LANGS) {
    const url = `${ORIGIN}/${TOOL}/${lang}`;
    const name = `/${TOOL}/${lang}`;
    const r = await get(url);
    if (r.status !== 200) { bad(name, `${r.status}`); continue; }
    const html = await r.text();
    const canon = (html.match(/rel="canonical" href="([^"]+)"/) || [])[1];
    const alts = [...html.matchAll(/rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]).sort().join(',');
    if (canon !== url) bad(name, `canonical 이 ${canon}`);
    else if (!new RegExp(`<html lang="${lang}"`).test(html)) bad(name, `<html lang> 이 ${lang} 이 아니다`);
    else if (alts !== [...LANGS, 'x-default'].sort().join(',')) bad(name, `hreflang 목록이 ${alts}`);
    else ok(name, '200 · canonical 자기 자신 · hreflang 전체');
  }

  // ── 끝 슬래시·.html 변형은 canonical 로 301 ───────────────
  // 자산 층이 주는 307(임시)이 아니라 Worker 의 301 이어야 검색엔진이 영구 주소를 안다.
  for (const v of ['/ko/', '/ko.html']) {
    const r = await get(`${ORIGIN}/${TOOL}${v}`);
    const to = clean(r.location);
    if (r.status === 301 && to === `/${TOOL}/ko`) ok(`/${TOOL}${v}`, `301 → ${to}`);
    else bad(`/${TOOL}${v}`, `${r.status} → ${to} — /${TOOL}/ko 로 301 이어야 한다`);
  }

  // ── 해시가 붙은 CSS·JS: 한국어판이 가리키는 그대로 ──────
  // base('/doceditor') 가 안 붙으면 도메인 루트의 /_astro/… 를 찾아 화면이 조용히 깨진다.
  {
    const html = await (await get(`${ORIGIN}/${TOOL}/ko`)).text();
    const refs = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"]*_astro\/[^"]+)"/g)].map((m) => m[1]))];
    if (!refs.length) ok('_astro 자산', '외부 파일 참조 없음 (전부 인라인)');
    for (const ref of refs) {
      if (!ref.startsWith(`/${TOOL}/_astro/`)) { bad(ref, `/${TOOL} 접두사가 없다 — astro.config 의 base`); continue; }
      const r = await get(ORIGIN + ref);
      if (r.status === 200) ok(ref, '200'); else bad(ref, `${r.status}`);
    }
  }

  // ── 이름이 고정인 자산 ───────────────────────────────────
  for (const a of ASSETS) {
    const r = await get(`${ORIGIN}/${TOOL}/${a}`);
    if (r.status === 200) ok(`/${TOOL}/${a}`, '200'); else bad(`/${TOOL}/${a}`, `${r.status}`);
  }

  // ── 없는 주소 · 404 페이지 주소는 404 ────────────────────
  // 200 이면 soft 404 다. 화면상 아무 표시가 없어 눈으로는 못 잡는다.
  for (const p of ['/this-does-not-exist', '/404']) {
    const r = await get(`${ORIGIN}/${TOOL}${p}`);
    if (r.status === 404) ok(`/${TOOL}${p}`, '404');
    else bad(`/${TOOL}${p}`, `${r.status} — soft 404. wrangler not_found_handling · worker 의 /404 처리를 볼 것`);
  }

  // ── 허브와 이웃 도구가 안 죽었는지 ───────────────────────
  // 이웃 도구는 순수 HTML 이라 끝 슬래시 주소다.
  for (const p of [...LANGS.map((l) => `/${l}`), '/robots.txt', '/mojibake/', '/race/ko/']) {
    const r = await get(ORIGIN + p);
    if (r.status === 200) ok(`(이웃) ${p}`, '200'); else bad(`(이웃) ${p}`, `${r.status} — 라우트가 겹쳤나`);
  }

  // ── 허브 robots.txt 가 이 사이트맵을 가리키는지 ──────────
  {
    const txt = await (await get(`${ORIGIN}/robots.txt`)).text();
    const want = `${ORIGIN}/${TOOL}/sitemap-index.xml`;
    if (txt.includes(want)) ok('robots.txt → sitemap', want);
    else bad('robots.txt → sitemap', `${want} 이 없다 — 허브 public/robots.txt 에 한 줄`);
  }

  const w = Math.max(...rows.map((r) => r[1].length));
  console.log('');
  for (const [mark, name, detail] of rows) console.log(`  ${mark} ${name.padEnd(w)}  ${detail}`);
  console.log('');
  if (fails) { console.log(`실패 ${fails}건`); process.exit(1); }
  console.log(`라이브 검증 통과 — ${rows.length}개 항목`);
}

main().catch((err) => {
  console.error('검증을 돌리지 못했다:', err.message);
  process.exit(1);
});
