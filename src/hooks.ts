import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject, type WheelEvent } from "react";

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

/** Wheel travel that moves one card: about one notch of a mouse wheel. */
const WHEEL_STEP = 100;
/** How far a press can wander and still be a tap. */
const TAP_SLOP = 12;

/**
 * Touch and mouse for a row the d-pad moves through a card at a time. Dragging it moves one card
 * for every `step` pixels, and so does turning the wheel over it, a notch a card. `move` takes -1
 * or 1 and says whether there was a card that way. A drag doesn't click the card it ends on.
 */
export function useSwipe(move: (d: -1 | 1) => boolean, step: number) {
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const wheel = useRef({ sum: 0, at: 0 });
  const steps = (n: number, d: -1 | 1) => {
    for (let k = 0; k < n; k++) if (!move(d)) return false;
    return true;
  };
  const end = (e: PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { id: e.pointerId, x: e.clientX, moved: false };
      dragged.current = false;
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      if (!d.moved) {
        if (Math.abs(dx) < TAP_SLOP) return;
        d.moved = dragged.current = true;
        // The drag stays with the row when the finger leaves it.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // A pointer that's already gone: the drag ends with it.
        }
      }
      const n = Math.trunc(dx / step);
      if (!n) return;
      d.x += n * step;
      // The cards go the way the finger does: dragging right brings in the ones on the left.
      if (!steps(Math.abs(n), n > 0 ? -1 : 1)) d.x = e.clientX;
    },
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (e: MouseEvent) => {
      if (!dragged.current) return;
      dragged.current = false;
      e.stopPropagation();
    },
    onDragStart: (e: MouseEvent) => e.preventDefault(),
    onWheel: (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const px = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      const w = wheel.current;
      // A pause starts a new turn of the wheel.
      if (e.timeStamp - w.at > 250) w.sum = 0;
      w.at = e.timeStamp;
      w.sum += px;
      const n = Math.trunc(w.sum / WHEEL_STEP);
      if (!n) return;
      w.sum -= n * WHEEL_STEP;
      if (!steps(Math.abs(n), n > 0 ? 1 : -1)) w.sum = 0;
    },
  };
}
