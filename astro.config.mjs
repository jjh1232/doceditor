import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
      i18n: {
        defaultLocale: 'en',
        locales: { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' },
      },
    }),
  ],
});
