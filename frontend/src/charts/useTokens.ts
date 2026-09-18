import { useEffect, useState } from "react";
import { readTokens, type ChartTokens } from "./tokens.ts";

// Chart colours follow the theme. The toggle lives in the top bar and flips
// data-theme on <html>, so this watches that attribute rather than keeping
// its own copy of the theme.
export function useTokens(): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(() => readTokens());
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTokens(readTokens());
    return () => observer.disconnect();
  }, []);
  return tokens;
}
