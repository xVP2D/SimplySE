import { useEffect, useRef } from "react";
import { echarts, type ECharts, type EChartsCoreOption } from "./echarts.ts";

// A thin wrapper around one ECharts instance: created on mount, resized with
// its container, disposed on unmount. The option is replaced (not merged) on
// every change, so a chart never keeps stale series from a previous config.
export function EChart({ option, label }: { option: EChartsCoreOption; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const instance = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(node);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={el} role="img" aria-label={label} style={{ width: "100%", height: "100%" }} />;
}
