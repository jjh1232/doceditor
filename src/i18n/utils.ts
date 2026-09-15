import en from '../locales/en.json';
import ko from '../locales/ko.json';
import ja from '../locales/ja.json';
import { BASE, LOCALES, SITE, XDEFAULT_LOCALE, type Locale } from './config';

/**
 * en.json 이 키 목록의 기준이다. ko·ja 에 키가 빠지면 `npm run check` 에서 타입 에러가 난다.
 * (빠진 키는 화면에 undefined 로 나오고, 그건 눈으로만 잡힌다)
 */
type Dictionary = typeof en;
const dictionaries = { en, ko, ja } satisfies Record<Locale, Dictionary>;

export type TranslationKey = keyof Dictionary;

export function useTranslations(lang: Locale) {
  const dict = dictionaries[lang];
  return (key: TranslationKey): string => dict[key];
}

/**
 * 언어 없는 경로 → 실제 경로. 끝 슬래시를 붙이지 않는다 (trailingSlash: 'never').
 *   localizePath('ko')          → '/doceditor/ko'
 *   localizePath('ja', '/jtd')  → '/doceditor/ja/jtd'
 */
export function localizePath(lang: Locale, path = ''): string {
  return `${BASE}/${lang}${path}`;
}

export function absoluteUrl(path: string): string {
  return new URL(path, SITE).href;
}

/**
 * 한 페이지가 가져야 할 hreflang 전체 목록. **모든 언어판이 같은 목록을 갖는다** —
 * 하나라도 빠지면 구글이 통째로 무시한다. x-default 는 영어.
 * `langs` 는 그 페이지가 실제로 있는 언어만 넘긴다(형식별 페이지는 일부 언어만 있을 수 있다).
 */
export function hreflangLinks(path = '', langs: readonly Locale[] = LOCALES) {
  const links = langs.map((lang) => ({ hreflang: lang as string, href: absoluteUrl(localizePath(lang, path)) }));
  const xdef = langs.includes(XDEFAULT_LOCALE) ? XDEFAULT_LOCALE : langs[0];
  links.push({ hreflang: 'x-default', href: absoluteUrl(localizePath(xdef, path)) });
  return links;
}

/** [lang] 라우트 공통. 템플릿 1개 → 언어 수만큼 HTML. */
export function localeStaticPaths() {
  return LOCALES.map((lang) => ({ params: { lang }, props: { lang } }));
}

/**
 * 편집 화면 문구 묶음. locales 의 `editor.*` 키에서 접두사를 뗀 객체다.
 * 페이지가 빌드 때 JSON 으로 박아 두고 editor.js 가 읽는다 (스크립트에 문장을 두지 않는다).
 */
export function editorStrings(lang: Locale): Record<string, string> {
  const dict = dictionaries[lang] as Record<string, string>;
  return Object.fromEntries(
    Object.entries(dict).filter(([k]) => k.startsWith('editor.')).map(([k, v]) => [k.slice(7), v]),
  );
}
