import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Sidebar "sources" show this many by default; the rest sit behind "more sources". */
export const SOURCE_LIMIT = 15;

/** A long list of sources, cut to `limit` with a toggle. The selected one always stays visible, even if it is further down. */
export function SourceList({ items, limit, activeIndex, more, less }: { items: ReactNode[]; limit: number; activeIndex: number; more(n: number): string; less: string }) {
  const [open, setOpen] = useState(false);
  if (items.length <= limit) return <>{items}</>;
  const head = items.slice(0, limit);
  if (!open && activeIndex >= limit) head.push(items[activeIndex]);
  const shown = open ? items : head;
  return (
    <>
      {shown}
      <button className="side-more" onClick={() => setOpen(!open)}>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {open ? less : more(items.length - head.length)}
      </button>
    </>
  );
}
