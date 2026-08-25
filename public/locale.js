// Local Network Diagnostics — locale following (monitor page only).
//
// PNDS App ≥ v1.3.0 pushes its current UI language into the monitor
// iframe over cross-origin postMessage (network reference "Locale
// Following" — the same delivery machinery as the theme bridge):
//
//   { type: "pnds:locale", version: 1, locale: "en" | "zh-CN" }
//
// Delivery is best-effort, latest-value-wins: the App re-pushes on
// iframe load, on language switches and on window focus regain, so
// applying a message must be idempotent — the locale is simply held as
// the page's current language and every listener re-renders through
// it. Unknown or malformed messages are ignored silently; the page
// never errors.
//
// Only the monitor branch of index.html loads this file. The performer
// page never runs it and always stays English.

(function (root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.PNDS_LOCALE = api;

    // Browser wiring (monitor page): the current locale starts at the
    // page default, optionally seeded by ?lang=<code> for the first
    // frame, then follows every locale message. Monitor scripts read it
    // via current() and re-render from the shared copy tables on every
    // change.
    let current = api.DEFAULT_LOCALE;
    const listeners = [];

    api.current = () => current;

    api.subscribe = (listener) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    };

    const apply = (locale) => {
      if (locale === current) {
        return;
      }

      current = locale;
      root.document.documentElement.lang = locale;

      for (const listener of [...listeners]) {
        listener(locale);
      }
    };

    const initial = api.initialLocale(root.location.search);
    if (initial) {
      apply(initial);
    }

    root.addEventListener("message", (event) => {
      const locale = api.localeFromMessage(event.data);
      if (locale) {
        apply(locale);
      }
    });
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The message protocol (network reference "Locale Following").
  const MESSAGE_TYPE = "pnds:locale";
  const MESSAGE_VERSION = 1;

  // The languages this page ships copy tables for (public/shared.js).
  // Anything else — on the wire or in ?lang= — is ignored, so an App
  // language the page has no table for keeps the default UI.
  const SUPPORTED_LOCALES = ["en", "zh-CN"];

  // The page's own language before any bridge traffic — the historical
  // English UI. A standalone browser session, or an App that never
  // sends the bridge, leaves the page exactly as it always was.
  const DEFAULT_LOCALE = "en";

  // The locale of a locale message, or null for anything the page must
  // ignore (unknown type, unknown version, malformed shape, codes the
  // page has no copy table for). Codes compare exactly — the App sends
  // canonical BCP 47 ("zh-CN", not "zh-cn").
  function localeFromMessage(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    if (data.type !== MESSAGE_TYPE || data.version !== MESSAGE_VERSION) {
      return null;
    }
    if (typeof data.locale !== "string") {
      return null;
    }

    return SUPPORTED_LOCALES.includes(data.locale) ? data.locale : null;
  }

  // ?lang=<code> first-frame initial locale; null keeps the default.
  function initialLocale(search) {
    const match = /[?&]lang=([A-Za-z-]+)/.exec(search || "");
    return match && SUPPORTED_LOCALES.includes(match[1]) ? match[1] : null;
  }

  return {
    localeFromMessage,
    initialLocale,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  };
});
