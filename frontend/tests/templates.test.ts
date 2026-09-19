// The dashboard templates promise "fills one screen, no wasted space": check
// that literally, at every window height they can be applied at.
import test from "node:test";
import assert from "node:assert/strict";
import { BASE_ROWS, DASHBOARD_TEMPLATES, DATA_FAMILIES, MAX_ROWS, familyOf, placeTemplate, rowsForViewport } from "../src/lib/dashboardTemplates.ts";
import { GRID_COLS, LIST_WIDGETS, WIDGET_MIN } from "../src/lib/dashboardGrid.ts";
import { ALL_CHART_IDS, isTileSized } from "../src/charts/ids.ts";
import { DATASETS, PERIODS } from "../src/charts/datasets.ts";
import { dictionaries } from "../src/i18n/translations.ts";

const heights = Array.from({ length: MAX_ROWS - BASE_ROWS + 1 }, (_, i) => BASE_ROWS + i);

test("there are five templates with distinct ids", () => {
  assert.equal(DASHBOARD_TEMPLATES.length, 5);
  assert.equal(new Set(DASHBOARD_TEMPLATES.map((t) => t.id)).size, 5);
});

test("every template tiles the grid exactly, at every height", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    for (const rows of heights) {
      const owner: number[][] = Array.from({ length: rows }, () => Array(GRID_COLS).fill(-1));
      placeTemplate(tpl, rows).forEach((p, i) => {
        assert.ok(p.x >= 0 && p.x + p.w <= GRID_COLS, `${tpl.id}: cell ${i} leaves the grid sideways`);
        assert.ok(p.y >= 0 && p.y + p.h <= rows, `${tpl.id}@${rows}: cell ${i} leaves the grid at the bottom`);
        for (let y = p.y; y < p.y + p.h; y++)
          for (let x = p.x; x < p.x + p.w; x++) {
            assert.equal(owner[y][x], -1, `${tpl.id}@${rows}: cells ${owner[y][x]} and ${i} overlap at ${x},${y}`);
            owner[y][x] = i;
          }
      });
      const holes = owner.flat().filter((v) => v === -1).length;
      assert.equal(holes, 0, `${tpl.id}@${rows}: ${holes} empty grid squares`);
    }
  }
});

test("no widget is ever smaller than its minimum size, at any height", () => {
  for (const tpl of DASHBOARD_TEMPLATES)
    for (const rows of heights)
      for (const p of placeTemplate(tpl, rows)) {
        const min = WIDGET_MIN[p.type];
        assert.ok(p.w >= min.w && p.h >= min.h, `${tpl.id}@${rows}: ${p.type} is ${p.w}x${p.h}, minimum ${min.w}x${min.h}`);
      }
});

test("a template keeps its shape when the window grows: cells stay in the same order", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    const base = placeTemplate(tpl, BASE_ROWS);
    tpl.cells.forEach((c, i) => {
      assert.deepEqual([base[i].y, base[i].h], [c.y, c.h], `${tpl.id}: the base height must reproduce the design`);
    });
    const tall = placeTemplate(tpl, MAX_ROWS);
    for (let i = 0; i < tall.length; i++)
      for (let j = 0; j < tall.length; j++) {
        if (i === j) continue;
        const a = base[i], b = base[j];
        const sameColumns = a.x < b.x + b.w && b.x < a.x + a.w;
        if (sameColumns && a.y + a.h <= b.y) assert.ok(tall[i].y + tall[i].h <= tall[j].y, `${tpl.id}: cell ${i} must stay above cell ${j}`);
      }
  }
});

test("the window height is bounded between one classic screen and the maximum", () => {
  assert.equal(rowsForViewport(4), BASE_ROWS);
  assert.equal(rowsForViewport(23), 23);
  assert.equal(rowsForViewport(80), MAX_ROWS);
});

test("chart cells reference a real chart, dataset, dimension, measure and period", () => {
  for (const tpl of DASHBOARD_TEMPLATES)
    for (const c of tpl.cells) {
      assert.equal(c.type === "chart", c.chart !== undefined, `${tpl.id}: only chart widgets carry a chart config`);
      if (!c.chart) continue;
      const def = DATASETS[c.chart.dataset];
      assert.ok(def, `${tpl.id}: unknown dataset ${c.chart.dataset}`);
      assert.ok(ALL_CHART_IDS.includes(c.chart.chart), `${tpl.id}: unknown chart ${c.chart.chart}`);
      assert.ok(def.dims.includes(c.chart.dim), `${tpl.id}: ${c.chart.dim} is not a dimension of ${def.id}`);
      assert.ok(def.measures.some((m) => m.id === c.chart?.measure), `${tpl.id}: ${c.chart.measure} is not a measure of ${def.id}`);
      assert.ok(PERIODS.includes(c.chart.days), `${tpl.id}: ${c.chart.days} days is not an offered period`);
    }
});

test("a chart is given room to be read: number tiles may be small, every other chart needs 4x5", () => {
  for (const tpl of DASHBOARD_TEMPLATES)
    for (const c of tpl.cells) {
      if (!c.chart) continue;
      if (isTileSized(c.chart.chart)) assert.ok(c.w >= 3 && c.h >= 3, `${tpl.id}: ${c.chart.chart} tile too small`);
      else assert.ok(c.w >= 4 && c.h >= 5, `${tpl.id}: ${c.chart.chart} is squeezed into ${c.w}x${c.h}`);
    }
});

test("a template never repeats itself: same stat or list twice, or the same chart twice", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    const keys = tpl.cells.map((c) => (c.chart ? `chart:${JSON.stringify(c.chart)}` : c.type));
    assert.equal(new Set(keys).size, keys.length, `${tpl.id} shows the same thing twice`);
  }
});

test("list widgets get a row count that fits their height, and only they get one", () => {
  for (const tpl of DASHBOARD_TEMPLATES)
    for (const rows of heights)
      for (const p of placeTemplate(tpl, rows)) {
        if (!LIST_WIDGETS.includes(p.type)) {
          assert.equal(p.limit, undefined, `${tpl.id}: ${p.type} must not have a limit`);
          continue;
        }
        assert.ok(p.limit !== undefined && p.limit >= 2, `${tpl.id}@${rows}: ${p.type} shows fewer than two rows`);
        // a taller cell never shows fewer rows
        const taller = placeTemplate(tpl, MAX_ROWS).find((q) => q.type === p.type)!;
        assert.ok((taller.limit ?? 0) >= (placeTemplate(tpl, BASE_ROWS).find((q) => q.type === p.type)!.limit ?? 0));
      }
});

test("the templates are different from one another", () => {
  const shapes = DASHBOARD_TEMPLATES.map((t) => JSON.stringify(t.cells));
  assert.equal(new Set(shapes).size, DASHBOARD_TEMPLATES.length);
});

test("every template is named and described in each language", () => {
  for (const [locale, dict] of Object.entries(dictionaries)) {
    const block = (dict as any).dashboard.template;
    for (const key of ["title", "intro", "apply"]) assert.ok(typeof block[key] === "string" && block[key].length > 0, `${locale}: dashboard.template.${key}`);
    for (const tpl of DASHBOARD_TEMPLATES) {
      assert.ok(block[tpl.id]?.name?.length > 0, `${locale}: name of ${tpl.id}`);
      assert.ok(block[tpl.id]?.desc?.length > 0, `${locale}: description of ${tpl.id}`);
    }
    for (const key of ["templatesButton", "templatesHint", "undoLayout", "undoLayoutHint"])
      assert.ok(typeof (dict as any).dashboard[key] === "string", `${locale}: dashboard.${key}`);
  }
});

test("every template shows all four families of data: denials, deployments, alerts and the fleet", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    const seen = new Set(tpl.cells.map(familyOf));
    for (const family of DATA_FAMILIES) assert.ok(seen.has(family), `${tpl.id} shows nothing about ${family}`);
  }
});

test("the top band of every template is one headline tile per family", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    const band = tpl.cells.filter((c) => c.y === 0);
    assert.equal(band.length, 4, `${tpl.id}: the band has ${band.length} tiles`);
    assert.deepEqual(new Set(band.map(familyOf)), new Set(DATA_FAMILIES), `${tpl.id}: the band misses a family`);
  }
});

test("the lower row of a template never shows one family twice", () => {
  for (const tpl of DASHBOARD_TEMPLATES) {
    const upper = tpl.cells.filter((c) => c.y === 3);
    const lower = tpl.cells.filter((c) => c.y === 9);
    assert.equal(upper.length + lower.length + 4, tpl.cells.length, `${tpl.id}: cells outside the three rows`);
    // the upper row is the template's theme: the lower one never repeats the theme's family twice
    const families = lower.map(familyOf);
    assert.equal(new Set(families).size, families.length, `${tpl.id}: a family appears twice in the lower row`);
  }
});

test("the chart widget of a family reads that family's dataset", () => {
  const dataset = { denials: "denials", deployments: "commands", alerts: "alerts", fleet: "fleet" } as const;
  for (const tpl of DASHBOARD_TEMPLATES)
    for (const c of tpl.cells)
      if (c.chart) assert.equal(c.chart.dataset, dataset[familyOf(c)]);
});

test("the charts page's blurb never drifts from the real number of chart types", () => {
  for (const [locale, dict] of Object.entries(dictionaries)) {
    const text = (dict as any).navDesc.charts as string;
    assert.ok(text.includes(String(ALL_CHART_IDS.length)), `${locale}: navDesc.charts says a stale count (real total: ${ALL_CHART_IDS.length})`);
  }
});
