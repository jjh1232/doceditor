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

/** 이 slug 가 있는 언어들 — hreflang · 언어 전환에 넘긴다. LOCALES 순서를 지킨다. */
export const langsOf = (slug: string) => LOCALES.filter((l) => GUIDES.some((g) => g.slug === slug && g.lang === l));
