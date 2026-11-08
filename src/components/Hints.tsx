import { useEffect, useId } from "react";
import { create } from "zustand";
import { t } from "../i18n";
import { dispatch, type Action } from "../input";
import { Glyph, type Button } from "./Glyph";

/** What clicking a hint presses. Directions and pairs have no single press. */
const PRESS: Partial<Record<Button, Action>> = { a: "a", b: "b", x: "x", y: "y", lb: "lb", rb: "rb", lt: "lt", rt: "rt", menu: "menu", view: "view" };

/** A button, or a pair that do the same thing in opposite directions. */
export type Hint = [Button | [Button, Button], string];

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
      {top.items.map(([b, label]) => {
        const glyphs = (Array.isArray(b) ? b : [b]).map((one) => <Glyph key={one} b={one} />);
        // With a mouse or a finger, a hint is the button it names: Back, Close, Skip.
        const action = Array.isArray(b) ? undefined : PRESS[b];
        return action ? (
          <button className="hint is-pressable" key={String(b) + label} onClick={() => dispatch(action)}>
            {glyphs}
            {t(label)}
          </button>
        ) : (
          <span className="hint" key={String(b) + label}>
            {glyphs}
            {t(label)}
          </span>
        );
      })}
    </div>
  );
}
