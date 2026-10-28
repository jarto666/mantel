import { useEffect, useState } from "react";
import type { Transition } from "motion/react";

/** Shared springs: one physical feel across the whole shell. */
export const spring = {
  /** Shelves and grids: quick, no overshoot. */
  rail: { type: "spring", stiffness: 420, damping: 42, mass: 0.9 } as Transition,
  /** Focus pop on a single element: a touch of bounce. */
  pop: { type: "spring", stiffness: 520, damping: 30 } as Transition,
  /** Big, slow surfaces: pages, cards flying in. */
  soft: { type: "spring", stiffness: 160, damping: 24 } as Transition,
};

export const ease = [0.2, 0.8, 0.2, 1] as const;

/** Current root font size in px; the layout is authored in rem and scales with the screen. */
export function useRem() {
  const read = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const [rem, setRem] = useState(read);
  useEffect(() => {
    const onResize = () => setRem(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return rem;
}

/** Follows `value`, but only after it has been stable for `ms` (skips frames while scrolling fast). */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
