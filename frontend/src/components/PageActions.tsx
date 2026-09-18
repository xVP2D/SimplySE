import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// The page header (title, description) belongs to the shell, but a page's
// own actions (Customize, Filter, Deploy...) depend on that page's state.
// A page renders <HeaderActions> and its children land in the header's
// action area, right-aligned next to the title.
export const PageActionsContext = createContext<HTMLElement | null>(null);

export function HeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(PageActionsContext);
  return target ? createPortal(children, target) : null;
}
