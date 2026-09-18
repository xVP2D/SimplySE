// Shared types of the chart system. Kept free of runtime imports so the pure
// shaping code (shape.ts) can be exercised directly under Node.

export type DatasetId = "denials" | "commands" | "alerts" | "fleet";
export type Bucket = "hour" | "day" | "week";
export type Polarity = "lowerBetter" | "higherBetter" | "neutral";

// One row of GET /api/history/{dataset}: `t` (bucket start, unix seconds,
// absent without a time bucket), one field per grouping dimension, and the
// dataset's measures.
export interface HistoryRow {
  t?: number;
  [key: string]: string | number | undefined;
}

export interface HistoryResponse {
  dataset: string;
  days: number;
  bucket: string;
  group: string[];
  rows: HistoryRow[];
  truncated: boolean;
}

// A history row normalised for shaping. `value` is the chosen measure;
// `weight` is what it is weighted by when averaged (the sample count for the
// fleet, the count itself for additive datasets).
export interface Row {
  t: number | null;
  dims: Record<string, string>;
  value: number;
  weight: number;
  raw?: Record<string, number>; // every numeric field of the history row, by name
}

export interface MeasureDef {
  id: string;
  labelKey: string;
  field: string; // field of the history row holding the measure
  additive: boolean; // summed across groups (counts) vs averaged (scores)
  unit: "count" | "percent";
  polarity: Polarity;
  scale?: number; // multiplier applied to the raw field (0..1 -> percent)
}

export interface DatasetDef {
  id: DatasetId;
  labelKey: string;
  dims: string[];
  defaultDim: string;
  measures: MeasureDef[];
  // Variables per (agent, bucket) for the statistical and correlation charts.
  variables: { id: string; labelKey: string }[];
  variableGroup: string[];
  variableFrom: (rows: Row[]) => number[];
}

export interface ChartConfig {
  dataset: DatasetId;
  chart: string;
  dim: string;
  days: number;
  measure?: string;
  target?: number;
}

export interface TreeNode {
  name: string;
  value: number;
  children?: TreeNode[];
}

// Everything a chart type may need, computed once per (dataset, dimension,
// period) and shared by every chart type.
export interface ChartInput {
  meta: {
    dataset: DatasetId;
    measure: MeasureDef;
    dim: string;
    dim2: string;
    dim3: string;
    days: number;
    bucket: Bucket;
    variableNames: string[]; // i18n keys
    truncated: boolean;
  };
  empty: boolean;
  categories: { name: string; value: number; weight: number }[]; // biggest first
  time: {
    ts: number[];
    series: { name: string; values: number[] }[]; // biggest first, tail merged as "other"
    total: number[];
  };
  matrix: { rows: string[]; cols: string[]; values: number[][]; weights: number[][] };
  hierarchy: TreeNode[];
  samples: { name: string; values: number[] }[];
  points: { group: string; t: number; x: number; y: number; size: number }[];
  variables: { names: string[]; rows: number[][] };
  kpi: {
    value: number;
    previous: number | null;
    target: number;
    spark: number[];
    min: number;
    max: number;
    mean: number;
    buckets: number;
    previousByCategory: Record<string, number>;
  };
}

export const OTHER = "::other::"; // sentinel replaced by the translated "Others" label at render time
