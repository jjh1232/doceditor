import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import { LOCALES, type Locale } from './config';

/**
 * 도구 하위 글 — /doceditor/<언어>/<slug>. 원문은 src/guides/<언어>/<slug>.md 다.
 *
 * 글 하나가 검색어 하나를 맡는다(「맥북 hwp」, 「open hwp file on iphone」, 「jtd 開く」 …).
 * mojibake 가 증상별 글로 네이버 순위를 딴 방식을 그대로 가져온 것이다.
 *
 * **같은 slug 는 언어가 달라도 같은 글이다.** hreflang 은 그 slug 가 있는 언어끼리만 묶는다 —
 * 한 언어에만 있는 글도 만들 수 있지만, 그때는 그 글의 hreflang 이 그 언어 하나뿐이다.
 */
export interface Guide {
  lang: Locale;
  slug: string;
  title: string;
  description: string;
  /** 목록 순서 */
  order: number;
  /** 원문 파일 (사이트맵 lastmod 용) */
  file: string;
  Content: AstroComponentFactory;
}

interface MdModule {
  frontmatter: { title: string; description: string; order?: number };
  Content: AstroComponentFactory;
}

const modules = import.meta.glob<MdModule>('../guides/*/*.md', { eager: true });

export const GUIDES: Guide[] = Object.entries(modules)
  .map(([file, m]) => {
    const [, lang, slug] = file.match(/guides\/([^/]+)\/([^/]+)\.md$/)!;
    if (!(LOCALES as readonly string[]).includes(lang)) throw new Error(`모르는 언어의 글: ${file}`);
    const { title, description, order = 99 } = m.frontmatter;
    if (!title || !description) throw new Error(`title·description 이 빠진 글: ${file}`);
    return { lang: lang as Locale, slug, title, description, order, file: file.replace('../', 'src/'), Content: m.Content };
  })
  .sort((a, b) => a.order - b.order);

export const guidesOf = (lang: Locale) => GUIDES.filter((g) => g.lang === lang);

/**
 * 색인하는 글의 언어. **2026-10-27 부터 한국어만.**
 * en·ja 글은 유입이 없고(구글 서치콘솔 「발견됨 - 색인 안 됨」, 네이버는 한국어만), 도구 본 페이지보다
 * 글이 훨씬 많은 사이트로 보이게 만들었다. 지우지 않고 noindex 로 둔다 — 링크·언어 전환은 산다.
 * 다시 색인하려면 여기에 언어를 넣는다(사이트맵 filter 도 이 값을 본다).
 */
export const INDEXED_GUIDE_LANGS: readonly Locale[] = ['ko'];
export const isIndexedGuide = (lang: Locale) => INDEXED_GUIDE_LANGS.includes(lang);

/** 이 slug 가 있는 언어들 — hreflang · 언어 전환에 넘긴다. LOCALES 순서를 지킨다. */
export const langsOf = (slug: string) => LOCALES.filter((l) => GUIDES.some((g) => g.slug === slug && g.lang === l));
