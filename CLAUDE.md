# doceditor — 설치 없이 여는 문서 편집기 (prelaps.com/doceditor)

hwp · hwpx 양식을 설치 없이 브라우저에서 채워 같은 형식으로 저장한다. 一太郎(.jtd)는 판별까지.
**Astro 로 만든 첫 도구다** (헌법 §4 「새 도구는 Astro 로」). 도메인 공통 규칙은 `D:\SUBsite\CLAUDE.md`.

```
npm run dev           개발 서버 (localhost:4321/doceditor/ko)
npm run build         dist/ 생성 — 언어별 ko.html · en.html · ja.html · 404.html · sitemap
npm run check         타입 검사. locales/*.json 키 누락이 여기서 잡힌다
npm run test:engine   다운로드 폴더의 hwp·hwpx 로 읽기·저장 왕복
npm run test:e2e <파일> [ko|en|ja]   실제 크롬으로 열기→입력→저장→다시 열어 확인 (astro preview --port 4329 필요)
npx wrangler dev      Worker 까지 붙여 로컬 확인 (curl -H 'Host: prelaps.com' …/doceditor/ko)
npm run deploy        build + wrangler deploy
```

## 구조

```
astro.config.mjs            base '/doceditor' · trailingSlash 'never' · build.format 'file'
wrangler.jsonc              assets ./dist · html_handling drop-trailing-slash · routes /doceditor, /doceditor/*
worker/index.js             접두사 제거 · /doceditor 302(Accept-Language) · 슬래시·.html 301 · /doceditor/404 → 404
src/layouts/Tool.astro      head · 헤더 · 언어 전환 · 푸터 · canonical/hreflang 자동 (한 벌)
src/pages/[lang]/index.astro  → /doceditor/ko · /doceditor/en · /doceditor/ja
src/pages/404.astro         noindex
src/components/Editor.astro  파일 놓는 곳 + 편집 화면. 모든 형식을 받고 내용으로 판별
src/scripts/editor.js       편집 화면 동작 (DOM). 문구는 #editor-strings JSON 에서
src/scripts/engine.js       파일 엔진 (DOM 모름). 원본은 여기 하나
src/locales/{ko,en,ja}.json 문구. en.json 이 키 기준
test/engine/                엔진 테스트 (engine.js 를 직접 import)
docs/포맷.md                hwp · hwpx · 一太郎 실측 기록
```

## 지키는 것

- **끝 슬래시 없음.** astro.config 세 줄 + wrangler `html_handling` 이 세트다. 한쪽만 바꾸면
  canonical 이 리다이렉트되는 주소가 된다. `/doceditor/ko/`·`/doceditor/ko.html` 은 Worker 가 301 한다
  (자산 층의 307 은 임시라 검색엔진에 영구 주소를 못 알린다).
- **설명 글은 템플릿에 직접.** 자바스크립트로 나중에 넣으면 크롤러가 못 본다.
- **엔진에 사람이 읽을 문구를 두지 않는다.** 코드만 던지고 문구는 locales 에서 고른다.
- **언어 전환은 링크다.** 상태로 글자만 바꾸면 한 언어만 색인된다.
- 페이지를 늘릴 때는 `getStaticPaths` 목록과 그 페이지의 설명 글만 추가한다. hreflang·sitemap 은 따라온다.

## 진행 상황 (2026-09-15)

- [x] Astro 뼈대 · 언어 3판 · 404 · sitemap · Worker(로컬 wrangler dev 로 주소 동작 확인)
- [x] 엔진 이식 + 테스트 통과
- [x] 편집 화면 이식 → `src/scripts/editor.js` + `src/components/Editor.astro` + `src/styles/editor.css`.
      문구는 locales 의 `editor.*` (한·영·일). 실제 브라우저 끝에서 끝까지(`npm run test:e2e <파일> <언어>`)
      ko·en·ja × hwp, en × hwpx 통과. 옮기면서 「끝 공백 줄이 손 안 대도 고친 칸으로 잡혀 저장 때 다시 쓰이던」 버그를 고쳤다
- [x] 一太郎 읽기·채우기 — 길이를 지키는 덮어쓰기 (docs/포맷.md). 엔진 테스트 · e2e ja/ko × jtd 통과
- [x] 이름 form → doceditor · og.png(`npm run og` → public/og.png) · verify.cjs 를 끝 슬래시 없음에 맞춤
- [x] 페이지 본문 보강 (제목에 「뷰어·온라인」 검색어)
- [x] **2026-09-16 배포** — 도구 Worker → 허브(tools.ts · locales · privacy#doceditor · robots.txt Sitemap) → `npm run verify` 24항목 통과.
      라우트는 `prelaps.com/doceditor*` 하나 (wrangler.jsonc 주석 참고 — 둘로 나누면 쿼리 붙은 루트가 404).
      라우터 TOOLS 는 필요 없다
- [ ] 저장한 jtd 를 실제 一太郎ビューア 로 열어 보기 (아직 사람 확인 없음 — 바이트 단위 검증만)
- [ ] 검색엔진: 서치콘솔 · 네이버 서치어드바이저에 `https://prelaps.com/doceditor/sitemap-index.xml` 제출
