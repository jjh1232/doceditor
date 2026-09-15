/**
 * 언어 설정. 언어를 늘리는 지점은 여기 한 곳 + src/locales/<언어>.json 하나.
 * (허브 prelaps-home/src/i18n/config.ts 와 같은 모양이다)
 */
export const SITE = 'https://prelaps.com';

/** 도구의 경로 접두사. astro.config 의 base 와 같아야 한다. */
export const BASE = '/doceditor';

/** 배열 순서가 hreflang · 언어 전환 순서가 된다. */
export const LOCALES = ['ko', 'en', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * hreflang x-default. 언어를 특정하지 못한 방문자를 보낼 곳이라 영어다.
 * 루트 /doceditor 이 Accept-Language 로 302 하는 것(worker)과는 다른 질문에 답하는 값이다.
 */
export const XDEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
};

/** og:locale */
export const OG_LOCALE: Record<Locale, string> = { ko: 'ko_KR', en: 'en_US', ja: 'ja_JP' };
