import { useEffect, useId } from "react";
import { create } from "zustand";
import { Glyph, type Button } from "./Glyph";

export type Hint = [Button, string];

const useHintStore = create<{ stacks: Record<string, { priority: number; items: Hint[] }> }>(() => ({ stacks: {} }));

/** Registers the hints for a screen; the bar shows the highest-priority set. */
export function useHints(items: Hint[], priority: number, active = true) {
  const id = useId();
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!active) return;
    useHintStore.setState((s) => ({ stacks: { ...s.stacks, [id]: { priority, items } } }));
    return () =>
      useHintStore.setState((s) => {
        const { [id]: _, ...rest } = s.stacks;
        return { stacks: rest };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, priority, active]);
}

export function HintBar() {
  const stacks = useHintStore((s) => s.stacks);
  const top = Object.values(stacks).sort((a, b) => b.priority - a.priority)[0];
  if (!top) return null;
  return (
    <div className="hintbar" key={JSON.stringify(top.items)}>
      {top.items.map(([b, label]) => (
        <span className="hint" key={b + label}>
          <Glyph b={b} />
          {label}
        </span>
      ))}
    </div>
  );
}
