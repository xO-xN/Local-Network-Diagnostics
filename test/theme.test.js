// Theme following (score project spec §5.3): the App pushes
// {type:'pnds:theme', version:1, …} into the monitor page, which writes
// the palette into its own CSS variables. These tests assert the
// external contract only — message in, CSS variables out — never the
// module's internals.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  variablesFromMessage,
  variablesFromPalette,
  initialVariables,
  THEME_PALETTES,
} = require("../public/theme");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// The example message from spec §5.3, verbatim.
const SPEC_MESSAGE = {
  type: "pnds:theme",
  version: 1,
  theme: "lavender",
  palette: {
    bg: "#eef0f8",
    "sidebar-bg": "#e2e5f3",
    card: "#ffffff",
    pill: "#e8ebf7",
    accent: "#5a4ff3",
    "accent-hover": "#4a3fe0",
    "accent-foreground": "#ffffff",
    text: "#171a2b",
    "text-secondary": "#5d6484",
    danger: "#e11d48",
    "danger-hover": "#c2143c",
    "danger-foreground": "#ffffff",
    warning: "#ffb020",
    "warning-hover": "#f0a20c",
    "warning-foreground": "#171a2b",
  },
};

// ------------------------------------------------------------
// WCAG contrast (independent of the module under test)
// ------------------------------------------------------------

function channel(hex, index) {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  return (
    0.2126 * channel(hex, 0) +
    0.7152 * channel(hex, 1) +
    0.0722 * channel(hex, 2)
  );
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ------------------------------------------------------------
// Message → CSS variables
// ------------------------------------------------------------

test("theme message: palette keys land in the page CSS variables", () => {
  const variables = variablesFromMessage(SPEC_MESSAGE);

  assert.equal(variables["--bg"], "#eef0f8");
  assert.equal(variables["--card"], "#ffffff");
  assert.equal(variables["--text"], "#171a2b");
  assert.equal(variables["--muted"], "#5d6484", "text-secondary → --muted");
  assert.equal(variables["--accent"], "#5a4ff3");
  assert.equal(variables["--danger"], "#e11d48");
  assert.equal(variables["--track"], "#e8ebf7", "pill → --track");
  assert.equal(variables["--red"], "#e11d48", "danger doubles as the Red status");
});

test("theme message: palette keys with no page variable are not written", () => {
  const variables = variablesFromMessage(SPEC_MESSAGE);

  for (const name of Object.keys(variables)) {
    assert.match(name, /^--/, `unexpected variable name ${name}`);
  }
  assert.equal(variables["--sidebar-bg"], undefined);
});

test("theme message: partial palettes write only the present keys", () => {
  const variables = variablesFromMessage({
    type: "pnds:theme",
    version: 1,
    palette: { card: "#000000" },
  });

  assert.equal(variables["--card"], "#000000");
  assert.equal(variables["--bg"], undefined);
  // A black card takes the dark-tuned status set.
  assert.equal(variables["--green"], "#86efac");
});

test("unknown or malformed messages are ignored, not applied", () => {
  const malformed = [
    null,
    undefined,
    42,
    "pnds:theme",
    [],
    {},
    { type: "other", version: 1, palette: {} },
    { type: "pnds:theme" },
    { type: "pnds:theme", version: 2, palette: {} },
    { type: "pnds:theme", version: 1 },
    { type: "pnds:theme", version: 1, palette: "lavender" },
    { type: "pnds:theme", version: 1, palette: [] },
  ];

  for (const data of malformed) {
    assert.equal(variablesFromMessage(data), null, `should ignore ${JSON.stringify(data)}`);
  }
});

// ------------------------------------------------------------
// Idempotency (the App re-pushes on theme switches and focus regain;
// latest value wins, repeated delivery has no side effects)
// ------------------------------------------------------------

test("re-delivery and theme round-trips are idempotent", () => {
  const root = fakeStyleRoot();

  applyVariables(root, variablesFromMessage(SPEC_MESSAGE));
  const afterLavender = new Map(root.properties);

  // Re-push of the same theme (focus regain path).
  applyVariables(root, variablesFromMessage(SPEC_MESSAGE));
  assert.deepEqual(root.properties, afterLavender);

  // A switch away and back lands exactly where it was.
  const sand = { ...SPEC_MESSAGE, theme: "sand", palette: THEME_PALETTES.sand };
  applyVariables(root, variablesFromMessage(sand));
  applyVariables(root, variablesFromMessage(SPEC_MESSAGE));
  assert.deepEqual(root.properties, afterLavender);
});

// ------------------------------------------------------------
// Readability: text and status colors stay legible on every theme
// ------------------------------------------------------------

test("all four App themes keep text, muted and status colors ≥4.5:1 on the card", () => {
  for (const [name, palette] of Object.entries(THEME_PALETTES)) {
    const variables = variablesFromPalette(palette);

    for (const variable of [
      "--text",
      "--muted",
      "--green",
      "--yellow",
      "--gray",
      "--red",
    ]) {
      const ratio = contrast(variables[variable], palette.card);
      assert.ok(
        ratio >= 4.5,
        `${name}: ${variable} ${variables[variable]} on card ${palette.card} reads ${ratio.toFixed(2)}:1`,
      );
    }
  }
});

// ------------------------------------------------------------
// ?theme=<name> first-frame initial values
// ------------------------------------------------------------

test("?theme= paints a first frame; absence keeps the page's own colors", () => {
  assert.equal(initialVariables("?theme=stage")["--bg"], "#0b0c10");
  assert.equal(initialVariables("?a=1&theme=sand")["--bg"], "#474036");
  assert.equal(initialVariables("?theme=brutal")["--accent"], "#ff5722");
  assert.equal(initialVariables("?theme=lavender")["--bg"], "#eef0f8");

  // At least a light/dark fork between themes.
  const light = initialVariables("?theme=lavender");
  const dark = initialVariables("?theme=stage");
  assert.notEqual(light["--bg"], dark["--bg"]);
  assert.notEqual(light["--green"], dark["--green"]);

  // Unknown names and missing parameters change nothing.
  assert.equal(initialVariables(""), null);
  assert.equal(initialVariables("?"), null);
  assert.equal(initialVariables("?foo=1"), null);
  assert.equal(initialVariables("?theme=unknown"), null);
});

// ------------------------------------------------------------
// Browser wiring (the real file, run against a minimal page)
// ------------------------------------------------------------

// Loads public/theme.js the way the monitor page does (browser global,
// no module system) and returns what the page observed: its CSS
// variables and its message listeners.
function loadMonitorPage(search) {
  const root = fakeStyleRoot();
  const listeners = {};
  const page = {
    document: { documentElement: { style: root.style } },
    location: { search },
    addEventListener: (type, handler) => {
      (listeners[type] = listeners[type] || []).push(handler);
    },
  };
  page.self = page;

  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "theme.js"), "utf8"),
    vm.createContext(page),
  );

  return { properties: root.properties, listeners };
}

test("monitor page wiring: message → documentElement CSS variables", () => {
  const page = loadMonitorPage("");

  assert.equal(page.listeners.message.length, 1, "exactly one message listener");

  page.listeners.message[0]({ data: SPEC_MESSAGE });
  assert.equal(page.properties.get("--bg"), "#eef0f8");
  assert.equal(page.properties.get("--accent"), "#5a4ff3");

  // The listener set before the first paint when ?theme= was present.
  const prePainted = loadMonitorPage("?theme=stage");
  assert.equal(prePainted.properties.get("--bg"), "#0b0c10");
});

test("monitor page wiring: malformed events never throw or write", () => {
  const page = loadMonitorPage("?theme=stage");
  const before = new Map(page.properties);

  for (const data of [null, {}, { type: "other" }, "pnds:theme"]) {
    assert.doesNotThrow(() => page.listeners.message[0]({ data }));
  }

  assert.deepEqual(page.properties, before);
});

// ------------------------------------------------------------
// Performer page stays out of the theme bridge
// ------------------------------------------------------------

test("the performer branch never loads the theme listener", () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

  // theme.js is written only inside the monitor branch of the port
  // fork, before the monitor script itself.
  const monitorBranch = html.slice(html.indexOf("monitorPort"));
  assert.match(monitorBranch, /theme\.js/);
  assert.ok(
    monitorBranch.indexOf("theme.js") < monitorBranch.indexOf("monitor.js"),
    "theme.js loads before monitor.js",
  );

  // And the performer script has no hand in theming.
  const performer = fs.readFileSync(
    path.join(PUBLIC_DIR, "performer.js"),
    "utf8",
  );
  assert.doesNotMatch(performer, /pnds:theme|PNDS_THEME/);
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function fakeStyleRoot() {
  const properties = new Map();
  return {
    properties,
    style: { setProperty: (name, value) => properties.set(name, value) },
  };
}

function applyVariables(root, variables) {
  for (const name of Object.keys(variables)) {
    root.style.setProperty(name, variables[name]);
  }
}
