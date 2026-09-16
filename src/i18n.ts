import merge from "lodash/merge";
import Mustache from "mustache";
import { getLanguage, moment } from "obsidian";

import { LANGS as LANGS_PRO } from "../pro/src/langs";
import { LANGS as LANGS_BASIC } from "./langs";

const LANGS = merge(LANGS_BASIC, LANGS_PRO);

export type LangType = keyof typeof LANGS;

function normalizeLocale(locale: string): string {
  if (!locale) {
    return "en";
  }
  let lower = `${locale}`.trim();
  // Obsidian also allows pointing at a custom translation file
  // ("pick location of translation file"), in which case the stored value is
  // a path such as "D:\\i18n\\zh-cn.json" -> take the base name instead.
  if (lower.includes("/") || lower.includes("\\")) {
    const parts = lower.split(/[\\/]/);
    lower = parts[parts.length - 1] ?? "";
    lower = lower.replace(/\.json$/i, "");
  }
  lower = lower.toLowerCase().replace(/-/g, "_");
  if (lower.startsWith("zh")) {
    // zh-Hans-CN / zh_CN / zh-cn / zh-Hans -> zh_cn
    // zh-Hant-TW / zh_TW / zh-HK / zh-MO -> zh_tw
    if (
      lower.includes("hant") ||
      lower.includes("tw") ||
      lower.includes("hk") ||
      lower.includes("mo")
    ) {
      return "zh_tw";
    }
    return "zh_cn";
  }
  return lower;
}

/**
 * Best-effort detection of the language Obsidian itself is currently using.
 *
 * 1. `getLanguage()` (Obsidian >= 1.8.7) reads the very same value Obsidian
 *    uses for its own UI, so it is by far the most reliable source.
 * 2. `moment.locale()` is only a *by-product*: Obsidian sets it inside a
 *    best-effort `try {} catch {}` block at startup, so on some platforms
 *    (or when moment is not ready yet) it silently stays "en" even though
 *    the Obsidian UI is in another language. That is why reading moment
 *    alone used to make the whole plugin fall back to English.
 * 3. `navigator.language` is the last resort.
 */
function detectLocale(): string {
  try {
    if (typeof getLanguage === "function") {
      const lang = getLanguage();
      if (lang !== undefined && lang !== null && `${lang}`.trim() !== "") {
        return `${lang}`;
      }
    }
  } catch (e) {
    // Obsidian < 1.8.7 has no getLanguage(), keep going
  }
  try {
    if (moment !== undefined && typeof moment.locale === "function") {
      const lang = moment.locale();
      if (lang) {
        return lang;
      }
    }
  } catch (e) {
    // ignore
  }
  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      return navigator.language;
    }
  } catch (e) {
    // ignore
  }
  return "en";
}
export type LangTypeAndAuto = LangType | "auto";
export type TransItemType = keyof (typeof LANGS)["en"];

export class I18n {
  lang: LangTypeAndAuto;
  readonly saveSettingFunc: (tolang: LangTypeAndAuto) => Promise<void>;
  constructor(
    lang: LangTypeAndAuto,
    saveSettingFunc: (tolang: LangTypeAndAuto) => Promise<void>
  ) {
    this.lang = lang;
    this.saveSettingFunc = saveSettingFunc;
  }
  async changeTo(anotherLang: LangTypeAndAuto) {
    this.lang = anotherLang;
    await this.saveSettingFunc(anotherLang);
  }

  _get(key: TransItemType) {
    let realLang: LangType;
    if (this.lang === "auto") {
      const detected = normalizeLocale(detectLocale()) as LangType;
      realLang = detected in LANGS ? detected : "en";
    } else if (this.lang in LANGS) {
      // honor the user-chosen language
      realLang = this.lang as LangType;
    } else {
      // fall back to English if the configured language is unavailable
      realLang = "en";
    }

    const res: string =
      (LANGS[realLang] as (typeof LANGS)["en"])[key] || LANGS["en"][key] || key;
    return res;
  }

  t(key: TransItemType, vars?: Record<string, string>) {
    if (vars === undefined) {
      return this._get(key);
    }
    return Mustache.render(this._get(key), vars);
  }
}
