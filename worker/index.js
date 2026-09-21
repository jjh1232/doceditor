/**
 * prelaps.com/doceditor/* 를 dist/(Astro 빌드 결과) 에 잇는 얇은 층 + 루트의 언어 분기.
 *
 * Workers Assets 에는 "이 경로 아래에 자산을 붙인다" 는 설정이 없다.
 * 자산의 파일 경로가 곧 URL 경로라서, 그냥 두면
 * prelaps.com/doceditor/_astro/x.css 가 dist/doceditor/_astro/x.css 를 찾는다.
 * 그래서 접두사를 여기서 떼어낸다. (race/worker/index.js 와 같은 구조)
 *
 * 이 파일 자체는 변환 없이 그대로 올라간다. 페이지는 astro build 가 dist/ 에 만든다.
 */

/** 정식 호스트. */
const CANONICAL_HOST = 'prelaps.com';

/** prelaps.com 에서 이 도구가 사는 자리. */
const PREFIX = '/doceditor';

/**
 * 실제로 있는 언어판. 순서가 곧 우선순위다.
 *
 * **여기에 없는 폴더를 미리 적으면 안 된다** — 그 언어의 브라우저 방문자 전원이
 * 없는 주소로 302 를 맞는다. 언어를 늘릴 때는 src/i18n/config.ts 의 LOCALES ·
 * src/locales/<언어>.json · 허브 tools.ts 를 같이 움직인다 (hreflang·sitemap 은 빌드가 따라온다).
 */
const LANGS = ['ko', 'en', 'ja'];

/**
 * 언어를 특정하지 못했을 때 보낼 곳.
 * **`x-default` 와 같은 값이어야 한다** — 한국어가 주 방문자층인 것과는 다른 질문이다.
 * 둘을 한 값으로 묶었다가 허브와 도구의 신호가 엇갈린 적이 있다 (헌법 §5).
 */
const FALLBACK = 'en';

/** GA4 측정 ID. prelaps.com 전체가 한 속성이다. */
const GA_ID = 'G-NQ5XY9JPJ4';

/**
 * 애널리틱스 스니펫은 HTML 파일이 아니라 **여기 한 곳에만** 있다.
 * 페이지마다 붙여두면 언어판을 하나 늘릴 때 조용히 빠뜨리고, 빠진 건 화면에 안 보인다.
 *
 * 도구가 「업로드 없음」류의 약속을 내건다면 한 가지가 더 걸린다 — 밖으로 나가는 것이
 * 방문 통계·광고뿐이라는 경계가 이 파일 한 곳에만 있어야, 나중에 "여기도 뭔가
 * 붙어 있었나" 를 찾아다니지 않는다.
 */
const GA_SNIPPET = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${GA_ID}');
</script>
`;

/**
 * 애드센스 퍼블리셔 ID (`ca-pub-…`). **발급 전에는 빈 문자열로 둔다.**
 *
 * 비어 있으면 아래에서 스니펫을 아예 만들지 않는다. 플레이스홀더를 그대로 올리면
 * 남의 client 로 광고 요청이 나가고, 하필 그 상태가 심사에 걸린다.
 *
 * ⚠ 이 값은 저장소마다 따로 있다 — 허브 `Base.astro` 와 도구 Worker 전부.
 *   저장소가 갈려 있어 한곳에 모을 수가 없다. 새 도구에서 이걸 빠뜨리면
 *   그 도구의 페이지에만 광고가 안 나오는데, 화면상 아무 표시가 없어 눈으로는 못 잡는다.
 */
const ADSENSE_ID = 'ca-pub-3724742785414572';

/** ID 가 없으면 빈 문자열 — 아무것도 끼우지 않는다. */
const ADSENSE_SNIPPET = ADSENSE_ID
  ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_ID}" crossorigin="anonymous"></script>
`
  : '';

/**
 * HTML 응답의 </head> 직전에 GA·애드센스 스니펫을 끼운다.
 * HTML 이 아니면 손대지 않는다 — CSS·JS 까지 HTMLRewriter 에 태우면 낭비다.
 *
 * 로컬(`npm run serve`)이나 file:// 더블클릭에는 Worker 가 없어서 이 주입도 없다.
 * 개발 중 클릭이 실제 방문자 수치에 섞이지 않는다는 뜻이라 이건 이득이다.
 */
function withHeadScripts(response) {
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  return new HTMLRewriter()
    .on('head', { element: (el) => el.append(GA_SNIPPET + ADSENSE_SNIPPET, { html: true }) })
    .transform(response);
}

/** Accept-Language 헤더에서 우리가 가진 언어를 고른다. q 값 순서대로 본다. */
function pickLang(header, country) {
  // Accept-Language 가 **아예 없는** 요청은 사람이 아니라 대개 봇이다.
  // 그때만 접속 국가를 본다.
  //
  // 네이버 Yeti 가 여기 걸렸다 — 등록된 주소가 prelaps.com 인데 헤더가 없어
  // 영어판으로 302 되고 있었다(2026-09-21 실측). 한국어 검색엔진이 이 사이트의
  // 대표 페이지를 영어로 보는 셈이다.
  //
  // 헤더가 있는 방문자의 동작은 하나도 안 바뀐다. 독일어 사용자처럼 헤더는
  // 있는데 우리 언어에 안 맞는 경우도 그대로 영어다 — 그쪽은 x-default 가
  // 답해야 하는 질문이고, 여기서 바뀌는 것은 「헤더가 없다」 하나뿐이다.
  // 구글봇은 대개 미국에서 오므로 계속 영어를 받는다.
  if (!header) return country === 'KR' ? 'ko' : FALLBACK;
  const wanted = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q.split('=')[1]) : 1 };
    })
    // q 가 숫자가 아니거나 0 이면(= 명시적 거부) 후보에서 뺀다.
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of wanted) {
    const base = tag.split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return FALLBACK;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 접두사가 없는 요청은 손대지 않는다.
    // 라우트가 prelaps.com/doceditor/* 라서 원래 여기 올 수 없지만, 라우트 설정이
    // 바뀌었을 때 조용히 경로를 망가뜨리지 않도록 막아둔다. 앞 N글자를 무조건 자르면
    // /styles.css 가 "s" 가 되어 404 가 난다.
    // /doceditorxyz 처럼 접두사로 「시작만」 하는 경로는 우리 것이 아니다. 앞 N글자를 무조건 자르면 안 된다.
    const ours = url.pathname === PREFIX || url.pathname.startsWith(PREFIX + "/");
    if (url.hostname !== CANONICAL_HOST || !ours) {
      return withHeadScripts(await env.ASSETS.fetch(request));
    }

    // /doceditor/en -> /en   자산은 dist/ 루트 기준이다 (html_handling 이 /en 을 en.html 로 잇는다).
    const path = url.pathname.slice(PREFIX.length) || '/';

    // ── 루트는 언어판으로 넘긴다 ────────────────────────────
    //
    // 301 이 아니라 **302** 다. 301 이면 브라우저가 영구 캐시해서 방문자가 언어를
    // 되돌릴 수 없다. 그리고 `Cache-Control: no-store` 가 없으면 Cloudflare 가
    // 첫 방문자의 언어를 뒤따라오는 전원에게 준다 — 엣지는 `Accept-Encoding` 외의
    // `Vary` 를 무시하기 때문이다. (헌법 §5)
    //
    // /doceditor/ko 같은 언어판 주소 자체는 절대 건드리지 않는다.
    // 건드리면 언어 전환 UI 가 죽는다.
    if (path === '/' || path === '') {
      const lang = pickLang(request.headers.get('accept-language'), request.cf?.country);
      return new Response(null, {
        status: 302,
        headers: {
          // 끝 슬래시 없음 (canonical 과 같은 모양). 슬래시를 붙이면 한 번 더 리다이렉트된다.
          // 쿼리는 들고 간다 — ?utm_source= 를 버리면 유입 경로가 GA 에 안 남는다.
          location: `${PREFIX}/${lang}${url.search}`,
          'cache-control': 'no-store',
          vary: 'Accept-Language',
        },
      });
    }

    // 404 안내 페이지 자체(/doceditor/404, /doceditor/404.html)를 주소로 열면 200 으로 나간다.
    // 없는 주소와 같은 취급으로 status 404 를 돌려준다.
    if (/^\/404(\.html)?\/?$/.test(path)) {
      const page = await env.ASSETS.fetch(new Request(new URL('/404', url), request));
      return withHeadScripts(new Response(page.body, { status: 404, headers: page.headers }));
    }

    // 끝 슬래시·.html 이 붙은 주소는 canonical(끝 슬래시 없음)로 **301**.
    // 자산 층도 알아서 돌려보내지만 307(임시)이라, 검색엔진에 「이쪽이 영구 주소」 라고 못 알린다.
    const clean = path.replace(/\/+$/, '').replace(/\.html$/, '');
    if (clean !== path && clean !== "" && !clean.endsWith("/index")) {
      return new Response(null, {
        status: 301,
        headers: { location: PREFIX + clean + url.search },
      });
    }

    url.pathname = path;
    const response = await env.ASSETS.fetch(new Request(url, request));

    // 자산 층이 돌려주는 리다이렉트의 Location 은 dist/ 루트 기준이라 접두사가 빠져 있다.
    // 그대로 흘려보내면 도구 밖으로 튕긴다 — /doceditor/ko/index.html 의 Location 이
    // /ko/ 로 나가서 허브의 한국어 페이지로 가버린다.
    const location = response.headers.get('location');
    if (!location) return withHeadScripts(response);

    const to = new URL(location, url);
    const headers = new Headers(response.headers);
    headers.set('location', PREFIX + to.pathname + to.search + to.hash);

    // 리다이렉트라 body 는 비어 있다. 상태 코드는 자산 층 것을 그대로 쓴다.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
