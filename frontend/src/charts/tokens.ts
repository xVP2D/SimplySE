// Colour tokens for charts. Series colours come from the validated
// categorical palette (fixed order, never cycled: checked with the dataviz
// validator against SimplySE's own light and dark surfaces); everything else
// is read from the app's CSS variables so charts follow the theme.

export interface ChartTokens {
  mode: "light" | "dark";
  text: string;
  muted: string;
  grid: string;
  surface: string;
  sunken: string;
  accent: string;
  accentSoft: string;
  series: string[];
  seq: string[]; // sequential ramp, weakest -> strongest (one hue)
  divLow: string; // diverging: negative pole
  divMid: string; // neutral midpoint
  divHigh: string; // positive pole
  good: string;
  bad: string;
  warn: string;
  font: string;
  mono: string;
}

const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

const SEQ = {
  light: ["#e1f0ef", "#a9d6d3", "#5fb1ae", "#26878a", "#0b6a70"],
  dark: ["#123c40", "#1b6367", "#2b8f92", "#47b7b5", "#5ccfcb"],
};

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function readTokens(): ChartTokens {
  const mode = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const dark = mode === "dark";
  return {
    mode,
    text: cssVar("--color-text", dark ? "#e3eeec" : "#12262a"),
    muted: cssVar("--color-neutral-500", dark ? "#8ea3a3" : "#566669"),
    grid: cssVar("--color-divider", dark ? "#244047" : "#d3dddb"),
    surface: cssVar("--color-surface", dark ? "#10262a" : "#ffffff"),
    sunken: cssVar("--color-sunken", dark ? "#0a181b" : "#e6ecea"),
    accent: cssVar("--color-accent", dark ? "#5ccfcb" : "#0b6a70"),
    accentSoft: cssVar("--color-accent-soft", dark ? "#14424a" : "#d8ecea"),
    series: SERIES[mode],
    seq: SEQ[mode],
    divLow: dark ? "#d95926" : "#eb6834",
    divMid: dark ? "#383835" : "#f0efec",
    divHigh: dark ? "#3987e5" : "#2a78d6",
    good: cssVar("--color-accent", dark ? "#5ccfcb" : "#0b6a70"),
    bad: cssVar("--color-danger", dark ? "#f08a76" : "#b4432f"),
    warn: cssVar("--color-amber", dark ? "#f0b24b" : "#9a5a05"),
    font: cssVar("--font-body", "system-ui, sans-serif"),
    mono: cssVar("--font-mono", "ui-monospace, monospace"),
  };
}
