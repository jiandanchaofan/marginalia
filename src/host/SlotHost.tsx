import { Component, type ReactNode } from "react";
import { slotItems, useRegistry } from "./registry";
import type { SlotContext, SlotItem, SlotName } from "./sdk";

/** A module's component that throws is shown as nothing (and logged); the rest of the window carries on. */
class Guard extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn(`module slot ${this.props.id} failed`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The items modules put in one place of the interface; renders nothing when there are none. */
export function SlotHost({ slot, ctx, render }: { slot: SlotName; ctx: SlotContext; render?: (item: SlotItem, body: ReactNode) => ReactNode }) {
  useRegistry();
  const items = slotItems(slot);
  if (!items.length) return null;
  return (
    <>
      {items.map((item) => {
        const body = (
          <Guard id={`${slot}/${item.id}`}>
            <item.component ctx={ctx} />
          </Guard>
        );
        return <span key={`${slot}/${item.id}`}>{render ? render(item, body) : body}</span>;
      })}
    </>
  );
}
