import { useEffect, useState } from "react";

// A counter that goes up every intervalMs while the tab is visible. A page
// lists it among the dependencies of its data-loading effect to refetch on
// its own — so a denial that a just-applied rule resolves leaves the screen
// without a manual reload, like on the pages that already poll.
export function useAutoRefresh(intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}
