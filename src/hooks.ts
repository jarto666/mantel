import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

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

/** Columns of the CSS grid `ref`, so up/down moves straight. */
export function useGridColumns(ref: RefObject<HTMLElement | null>, grid?: unknown) {
  const [cols, setCols] = useState(7);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // "none" while the tab it's on is hidden.
      const tracks = getComputedStyle(el).gridTemplateColumns.split(" ").filter((t) => t && t !== "none").length;
      if (tracks) setCols(tracks);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, grid]);
  return cols;
}

/**
 * How many of `total` grid items to render: rows down to a little past the focused one, and
 * more as `end` (a marker after the grid) scrolls into view by touch. A catalog of hundreds of
 * covers then costs what one screenful does. Starts over when `reset` changes.
 */
export function useWindow(total: number, focus: number, cols: number, reset: unknown, end: RefObject<HTMLElement | null>) {
  const first = cols * 6;
  const [count, setCount] = useState(first);
  useEffect(() => setCount(first), [reset, first]);
  const wanted = (Math.floor(focus / cols) + 4) * cols;
  useEffect(() => {
    if (wanted > count) setCount(wanted);
  }, [wanted, count]);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setCount((c) => c + cols * 4), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [end, cols]);
  return Math.min(total, Math.max(count, wanted));
}

/** Whether a box's content is wider than the box, which is what a fade at its edge is for. */
export function useOverflowing(box: RefObject<HTMLElement | null>, content: unknown) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const check = () => setOver(el.scrollWidth > el.clientWidth + 1);
    check();
    const seen = new ResizeObserver(check);
    seen.observe(el);
    // Items are still animating into place right after a change.
    const settled = setTimeout(check, 500);
    return () => {
      seen.disconnect();
      clearTimeout(settled);
    };
  }, [box, content]);
  return over;
}

/** A function that keeps its identity and runs the latest version, so it doesn't undo a child's memo. */
export function useHandler<A extends unknown[], R>(fn: (...args: A) => R) {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
