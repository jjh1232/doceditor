import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * 페이지 소스가 마지막으로 바뀐 날을 Date 로 돌려준다. 여러 개를 주면 가장 최근.
 *
 * ⚠ 빌드 시각(new Date())을 쓰면 안 된다. 배포할 때마다 전 페이지가 「오늘 바뀜」이
 *   되고, 구글은 그게 사실이 아닌 것을 알아채면 **이 사이트의 lastmod 를 통째로
 *   무시한다.** 없는 것만 못한 상태가 되므로 git 이 아는 실제 날짜를 쓴다.
 *
 * 커밋 안 된 수정이 있는 파일은 **파일 수정 시각**을 쓴다. 오늘로 찍으면 안 된다 —
 * 커밋만 안 했을 뿐 내용은 며칠 전에 올라간 경우가 있고, 그때 오늘로 적으면
 * 구글이 다시 긁어보고 바뀐 게 없다는 것을 알게 된다. 그게 반복되면 무시당한다.
 * git 을 못 쓰는 환경이면 undefined 를 돌려 lastmod 를 아예 안 넣는다.
 * 틀린 날짜보다 없는 편이 낫다.
 */
const lastmodCache = new Map();
function lastmodOf(...files) {
  let newest;
  for (const f of files) {
    if (!lastmodCache.has(f)) {
      let iso;
      try {
        const dirty = execSync('git status --porcelain -- "' + f + '"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        iso = dirty
          ? statSync(f).mtime.toISOString().slice(0, 10)
          : execSync('git log -1 --format=%cs -- "' + f + '"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        iso = '';
      }
      lastmodCache.set(f, iso ? new Date(iso + 'T00:00:00Z') : null);
    }
    const d = lastmodCache.get(f);
    if (d && (!newest || d > newest)) newest = d;
  }
  return newest;
}

/**
 * doceditor — prelaps.com/doceditor 아래의 양식 채우기 도구. (헌법 §4 「새 도구는 Astro 로」)
 *
 * ⚠ 아래 세 줄 + wrangler 의 html_handling 이 세트다. 한쪽만 바꾸면
 *   canonical 이 가리키는 주소가 리다이렉트되는 주소가 된다.
 *     base 는 자산 경로(/doceditor/_astro/…)에도 붙는다 — 그래서 상대 경로가 필요 없다.
 *     trailingSlash 'never' + format 'file'  →  /doceditor/ko  →  dist/ko.html
 */
export default defineConfig({
  site: 'https://prelaps.com',
  base: '/doceditor',
  trailingSlash: 'never',
  build: { format: 'file' },

  integrations: [
    sitemap({
      // 언어 없는 /doceditor 은 302 통로라 사이트맵에 넣지 않는다. 404 도 뺀다.
      filter: (page) => /\/doceditor\/(ko|en|ja)(\/|$)/.test(page),
      // 각 URL 에 그 페이지가 실제로 바뀐 날을 붙인다. 없으면 구글이
      // 「언제 다시 볼지」를 스스로 정하고, 신규 도메인에서는 몇 주씩 걸린다.
      // 화면 글은 대부분 locales/*.json 에 있으므로 그쪽도 같이 본다.
      serialize(item) {
        const m = new URL(item.url).pathname.match(/^\/doceditor\/(ko|en|ja)$/);
        if (!m) return item;
        const d = lastmodOf('src/pages/[lang]/index.astro', `src/locales/${m[1]}.json`);
        if (d) item.lastmod = d;
        return item;
      },

      i18n: {
        defaultLocale: 'en',
        locales: { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' },
      },
    }),
  ],
});
