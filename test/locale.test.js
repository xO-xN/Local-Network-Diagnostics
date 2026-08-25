// Locale following (network reference "Locale Following", App ≥ v1.3.0):
// the App pushes {type:'pnds:locale', version:1, locale:…} into the
// monitor page, which holds the locale as its current language and
// re-renders through the shared bilingual copy tables. These tests
// assert the external contract only — message in, locale state and
// notifications out — never the module's internals.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  localeFromMessage,
  initialLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} = require("../public/locale");

const { copy, diagEvents } = require("../public/shared");
const { decideStatus } = require("../lib/diagnostics");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// The message from the network reference "Locale Following", verbatim.
const SPEC_MESSAGE = {
  type: "pnds:locale",
  version: 1,
  locale: "zh-CN",
};

// ------------------------------------------------------------
// Message → locale
// ------------------------------------------------------------

test("locale message: supported codes parse, others do not", () => {
  assert.equal(localeFromMessage(SPEC_MESSAGE), "zh-CN");
  assert.equal(
    localeFromMessage({ type: "pnds:locale", version: 1, locale: "en" }),
    "en",
  );

  for (const code of ["ja", "zh", "zh-cn", "en-US", ""]) {
    assert.equal(
      localeFromMessage({ type: "pnds:locale", version: 1, locale: code }),
      null,
      `unsupported code ${JSON.stringify(code)} must be ignored`,
    );
  }
});

test("unknown or malformed messages are ignored, not applied", () => {
  const malformed = [
    null,
    undefined,
    42,
    "pnds:locale",
    [],
    {},
    { type: "other", version: 1, locale: "en" },
    { type: "pnds:locale" },
    { type: "pnds:locale", version: 2, locale: "en" },
    { type: "pnds:locale", version: 1 },
    { type: "pnds:locale", version: 1, locale: 7 },
    { type: "pnds:locale", version: 1, locale: ["en"] },
  ];

  for (const data of malformed) {
    assert.equal(localeFromMessage(data), null, `should ignore ${JSON.stringify(data)}`);
  }
});

// ------------------------------------------------------------
// ?lang=<code> first-frame initial locale
// ------------------------------------------------------------

test("?lang= seeds the first frame; absence keeps the default", () => {
  assert.equal(initialLocale("?lang=zh-CN"), "zh-CN");
  assert.equal(initialLocale("?a=1&lang=en"), "en");
  assert.equal(initialLocale("?lang=en&theme=stage"), "en");

  // Unknown codes and missing parameters keep the default locale.
  assert.equal(initialLocale(""), null);
  assert.equal(initialLocale("?"), null);
  assert.equal(initialLocale("?foo=1"), null);
  assert.equal(initialLocale("?lang=ja"), null);
  assert.equal(initialLocale("?lang=zh-cn"), null, "codes compare exactly");
});

// ------------------------------------------------------------
// Browser wiring (the real file, run against a minimal page)
// ------------------------------------------------------------

// Loads public/locale.js the way the monitor page does (browser global,
// no module system) and returns what the page observed: its locale
// state, its document lang and its message listeners.
function loadMonitorPage(search) {
  const documentElement = { lang: "en" };
  const listeners = {};
  const page = {
    document: { documentElement },
    location: { search },
    addEventListener: (type, handler) => {
      (listeners[type] = listeners[type] || []).push(handler);
    },
  };
  page.self = page;

  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "locale.js"), "utf8"),
    vm.createContext(page),
  );

  return { locale: page.PNDS_LOCALE, documentElement, listeners };
}

test("monitor page wiring: defaults to English until a locale arrives", () => {
  const page = loadMonitorPage("");

  // page.locale is window.PNDS_LOCALE — the global the monitor scripts
  // read, so its very presence proves the browser-global wiring.
  assert.equal(typeof page.locale.current, "function");
  assert.equal(page.locale.current(), DEFAULT_LOCALE);
  assert.equal(page.locale.current(), "en");
  assert.equal(page.documentElement.lang, "en", "no rewrite before a locale applies");
});

test("monitor page wiring: message → current locale, lang attribute, subscribers", () => {
  const page = loadMonitorPage("");
  const seen = [];
  page.locale.subscribe((locale) => seen.push(locale));

  assert.equal(page.listeners.message.length, 1, "exactly one message listener");

  page.listeners.message[0]({ data: SPEC_MESSAGE });
  assert.equal(page.locale.current(), "zh-CN");
  assert.equal(page.documentElement.lang, "zh-CN");
  assert.deepEqual(seen, ["zh-CN"]);

  // Back to English (a language switch in the App).
  page.listeners.message[0]({ data: { type: "pnds:locale", version: 1, locale: "en" } });
  assert.equal(page.locale.current(), "en");
  assert.equal(page.documentElement.lang, "en");
  assert.deepEqual(seen, ["zh-CN", "en"]);
});

test("monitor page wiring: ?lang= paints the first frame before any message", () => {
  const page = loadMonitorPage("?lang=zh-CN");

  assert.equal(page.locale.current(), "zh-CN");
  assert.equal(page.documentElement.lang, "zh-CN");
});

test("monitor page wiring: malformed events never throw or change the locale", () => {
  const page = loadMonitorPage("?lang=zh-CN");

  for (const data of [null, {}, { type: "other" }, "pnds:locale", { type: "pnds:locale", version: 1, locale: "ja" }]) {
    assert.doesNotThrow(() => page.listeners.message[0]({ data }));
  }

  assert.equal(page.locale.current(), "zh-CN");
});

// ------------------------------------------------------------
// Idempotency (the App re-pushes on language switches and focus
// regain; latest value wins, repeated delivery has no side effects)
// ------------------------------------------------------------

test("re-delivery is idempotent; switches land on the latest value", () => {
  const page = loadMonitorPage("");
  const seen = [];
  page.locale.subscribe((locale) => seen.push(locale));

  const deliver = (locale) =>
    page.listeners.message[0]({ data: { type: "pnds:locale", version: 1, locale } });

  // Re-push of the current locale (focus regain path) notifies nobody.
  deliver("en");
  deliver("en");
  assert.deepEqual(seen, []);

  deliver("zh-CN");
  deliver("zh-CN");
  assert.deepEqual(seen, ["zh-CN"]);

  // A switch away and back lands exactly where it was.
  deliver("en");
  deliver("zh-CN");
  assert.deepEqual(seen, ["zh-CN", "en", "zh-CN"]);
  assert.equal(page.locale.current(), "zh-CN");
});

test("unsubscribe stops the notifications", () => {
  const page = loadMonitorPage("");
  const seen = [];
  const off = page.locale.subscribe((locale) => seen.push(locale));

  off();
  page.listeners.message[0]({ data: SPEC_MESSAGE });
  assert.deepEqual(seen, []);
  assert.equal(page.locale.current(), "zh-CN", "state still follows");
});

// ------------------------------------------------------------
// Performer page stays out of the locale bridge
// ------------------------------------------------------------

test("the performer branch never loads the locale listener", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

  // locale.js is written only inside the monitor branch of the port
  // fork, after theme.js and before the monitor script itself.
  const monitorBranch = html.slice(html.indexOf("monitorPort"));
  assert.match(monitorBranch, /locale\.js/);
  assert.ok(
    monitorBranch.indexOf("theme.js") < monitorBranch.indexOf("locale.js"),
    "locale.js loads after theme.js",
  );
  assert.ok(
    monitorBranch.indexOf("locale.js") < monitorBranch.indexOf("monitor.js"),
    "locale.js loads before monitor.js",
  );

  // And the performer script has no hand in locale following.
  const performer = fs.readFileSync(
    path.join(PUBLIC_DIR, "performer.js"),
    "utf8",
  );
  assert.doesNotMatch(performer, /pnds:locale|PNDS_LOCALE/);
});

// ------------------------------------------------------------
// Copy tables (shared.js): every locale renders the same shape
// ------------------------------------------------------------

test("both copy tables share one key shape and non-empty strings", () => {
  assert.deepEqual(keysOf(copy.en), keysOf(copy["zh-CN"]));

  for (const locale of SUPPORTED_LOCALES) {
    for (const value of leafValues(copy[locale])) {
      assert.equal(typeof value, "string", `${locale}: copy values are strings`);
      assert.notEqual(value.trim(), "", `${locale}: copy values are non-empty`);
    }
  }
});

test("every reason key the server can emit has copy in both locales", () => {
  const good = {
    disconnected: false,
    consecutiveTimeouts: 0,
    burstTimeoutRate: 0,
    jitterP95: 5,
    rttP95: 40,
    samples: 1,
  };

  // One input per decideStatus rule plus the StatusMachine warm-up —
  // together these produce every reason key the wire can carry.
  const inputs = [
    good,
    { ...good, disconnected: true },
    { ...good, consecutiveTimeouts: 3 },
    { ...good, burstTimeoutRate: 0.06 },
    { ...good, jitterP95: 26 },
    { ...good, rttP95: 101 },
    { ...good, consecutiveTimeouts: 1 },
    { ...good, rttP95: 60 },
  ];

  const emitted = new Set(["warmup"]);
  for (const input of inputs) {
    emitted.add(decideStatus(input).reason);
  }

  for (const locale of SUPPORTED_LOCALES) {
    for (const reason of emitted) {
      assert.ok(
        copy[locale].reasons[reason],
        `${locale}: missing copy for reason "${reason}"`,
      );
    }
  }
});

test("the Red status copy stays explicit in every locale", () => {
  assert.equal(copy.en.status.red, "Not suitable for performance");
  assert.equal(copy["zh-CN"].status.red, "不适合现场演出");
});

test("event-log types have copy in both locales", () => {
  for (const type of Object.values(diagEvents)) {
    assert.ok(copy.en.events[type], `en: missing event copy for "${type}"`);
    assert.ok(copy["zh-CN"].events[type], `zh-CN: missing event copy for "${type}"`);
  }
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

// Key shape of a nested plain-object structure (leaf values → null, so
// only the shape compares).
function keysOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = keysOf(value[key]);
  }
  return out;
}

function* leafValues(value) {
  if (value === null || typeof value !== "object") {
    yield value;
    return;
  }
  for (const child of Object.values(value)) {
    yield* leafValues(child);
  }
}
