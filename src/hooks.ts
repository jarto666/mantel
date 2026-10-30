import { useEffect, useState, type RefObject } from "react";

/** True while the window is minimized or covered, e.g. by a game. */
export function usePageHidden() {
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

/**
 * Keeps the `.is-focused` descendant of the scroll container `ref` in view whenever
 * `dep` changes. Scrolls only that container: `scrollIntoView` would also scroll every
 * ancestor, including the fixed shell.
 */
export function useScrollFocus(
  ref: RefObject<HTMLElement | null>,
  dep: unknown,
  { axis = "y", align = "nearest" }: { axis?: "x" | "y"; align?: "center" | "nearest" } = {},
) {
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>(".is-focused");
    if (!box || !el) return;
    const b = box.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    const [start, size, boxStart, boxSize, scroll] =
      axis === "y" ? [e.top, e.height, b.top, b.height, box.scrollTop] : [e.left, e.width, b.left, b.width, box.scrollLeft];
    const offset = start - boxStart;
    const pad = boxSize * 0.18;
    let target: number | null = null;
    if (align === "center") target = scroll + offset - (boxSize - size) / 2;
    else if (offset < pad) target = scroll + offset - pad;
    else if (offset + size > boxSize - pad) target = scroll + offset + size - boxSize + pad;
    if (target !== null) box.scrollTo({ [axis === "y" ? "top" : "left"]: Math.max(0, target), behavior: "smooth" });
  }, [ref, dep, axis, align]);
}
