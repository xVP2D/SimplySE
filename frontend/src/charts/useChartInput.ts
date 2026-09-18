import { useEffect, useMemo, useState } from "react";
import { loadChartInput } from "./datasets.ts";
import type { ChartConfig, ChartInput } from "./types.ts";

export interface ChartInputState {
  loading: boolean;
  error: string | null;
  input: ChartInput | null;
}

// Loads the shared input of a chart. Keyed on everything except the chart
// type, so a gallery of forty charts over the same data loads it once. The
// previous input stays on screen while a refresh is in flight.
export function useChartInput(cfg: Pick<ChartConfig, "dataset" | "dim" | "days" | "measure" | "target">, refreshMs = 0): ChartInputState {
  const [state, setState] = useState<ChartInputState>({ loading: true, error: null, input: null });
  const key = [cfg.dataset, cfg.dim, cfg.days, cfg.measure ?? ""].join("|");

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      loadChartInput(cfg)
        .then((input) => {
          if (!cancelled) setState({ loading: false, error: null, input });
        })
        .catch((err: Error) => {
          if (!cancelled) setState((s) => ({ loading: false, error: err.message, input: s.input }));
        });
    };
    setState((s) => ({ ...s, loading: true }));
    run();
    const timer = refreshMs > 0 ? setInterval(() => !document.hidden && run(), refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // cfg is represented by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs]);

  // a KPI target set by the operator replaces the default (the previous period)
  const input = useMemo(() => {
    if (!state.input || cfg.target === undefined) return state.input;
    return { ...state.input, kpi: { ...state.input.kpi, target: cfg.target, targetSource: "config" as const } };
  }, [state.input, cfg.target]);

  return { ...state, input };
}
