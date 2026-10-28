// Gamepad + keyboard input, routed to a priority stack of handlers.
import { useEffect, useRef } from "react";
import { sound } from "./sound";

export type Action =
  | "up" | "down" | "left" | "right"
  | "a" | "b" | "x" | "y"
  | "lb" | "rb" | "lt" | "rt"
  | "menu" | "view";

/**
 * Return `false` to let a lower layer handle the action, `"edge"` when movement hit a
 * boundary, `"silent"` to skip the UI sound; anything else counts as handled.
 */
export type Result = void | boolean | "edge" | "silent";
export type Handler = (action: Action, repeat: boolean) => Result;

/** Base shell < view < page (details) < overlay (menus, search, launch). */
export const Layer = { base: 0, view: 10, page: 20, overlay: 30, modal: 40 } as const;

interface Entry {
  seq: number;
  priority: number;
  ref: { current: Handler };
}

let seq = 0;
const entries: Entry[] = [];
const listeners = new Set<() => void>();

export function topPriority(): number {
  return entries.reduce((m, e) => Math.max(m, e.priority), -1);
}

export function onLayersChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useInput(handler: Handler, priority: number, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { seq: ++seq, priority, ref };
    entries.push(entry);
    listeners.forEach((l) => l());
    return () => {
      entries.splice(entries.indexOf(entry), 1);
      listeners.forEach((l) => l());
    };
  }, [active, priority]);
}

const SOUND_FOR: Partial<Record<Action, keyof typeof sound>> = {
  up: "move", down: "move", left: "move", right: "move",
  a: "select", b: "back", lb: "tab", rb: "tab", lt: "tab", rt: "tab",
  menu: "open", view: "open",
};

let lastInput = Date.now();
let wake: () => boolean = () => false;

/** Milliseconds since the player last did anything: buttons, keys, touch, mouse. */
export const idleFor = () => Date.now() - lastInput;

const markActivity = () => {
  lastInput = Date.now();
};

/** Called before routing any input; returning true swallows it (e.g. to wake the screen). */
export function setWakeHandler(fn: () => boolean) {
  wake = fn;
}

export function dispatch(action: Action, repeat = false) {
  lastInput = Date.now();
  if (wake()) return;
  const ordered = [...entries].sort((p, q) => q.priority - p.priority || q.seq - p.seq);
  for (const e of ordered) {
    const r = e.ref.current(action, repeat);
    if (r === false) continue;
    if (r === "edge") sound.edge();
    else if (r !== "silent") {
      const s = SOUND_FOR[action];
      if (s) sound[s]();
    }
    return;
  }
}

// ---- Gamepad -------------------------------------------------------------

const BUTTONS: [number, Action][] = [
  [0, "a"], [1, "b"], [2, "x"], [3, "y"],
  [4, "lb"], [5, "rb"], [6, "lt"], [7, "rt"],
  [8, "view"], [9, "menu"],
  [12, "up"], [13, "down"], [14, "left"], [15, "right"],
];
const REPEATS = new Set<Action>(["up", "down", "left", "right", "lb", "rb", "lt", "rt"]);
const FIRST_REPEAT = 340;
const REPEAT_SLOW = 95;
const REPEAT_FAST = 48;
const STICK = 0.55;

const held = new Map<Action, { since: number; last: number }>();
let lastPad: Gamepad | null = null;
let backgroundOk = () => false;

/**
 * Lets the pad drive Mantel while visible but unfocused (Windows may deny focus at
 * autostart). The shell turns this off while a game runs, so input never leaks.
 */
export function setBackgroundInput(check: () => boolean) {
  backgroundOk = check;
}

function activeActions(): Set<Action> {
  const out = new Set<Action>();
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad || !pad.connected) continue;
    lastPad = pad;
    for (const [i, action] of BUTTONS) {
      const b = pad.buttons[i];
      if (b && (b.pressed || b.value > 0.5)) out.add(action);
    }
    const [x = 0, y = 0] = pad.axes;
    if (x < -STICK) out.add("left");
    if (x > STICK) out.add("right");
    if (y < -STICK) out.add("up");
    if (y > STICK) out.add("down");
  }
  return out;
}

function poll(t: number) {
  const listening = !document.hidden && (document.hasFocus() || backgroundOk());
  const now = listening ? activeActions() : new Set<Action>();
  for (const action of now) {
    const h = held.get(action);
    if (!h) {
      held.set(action, { since: t, last: t });
      dispatch(action, false);
    } else if (REPEATS.has(action) && t - h.since > FIRST_REPEAT) {
      const rate = t - h.since > 1600 ? REPEAT_FAST : REPEAT_SLOW;
      if (t - h.last >= rate) {
        h.last = t;
        dispatch(action, true);
      }
    }
  }
  for (const action of [...held.keys()]) if (!now.has(action)) held.delete(action);
  requestAnimationFrame(poll);
}

export function rumble(strong = 0.35, weak = 0.7, duration = 140) {
  const actuator = (lastPad as (Gamepad & { vibrationActuator?: { playEffect?: Function } }) | null)?.vibrationActuator;
  actuator?.playEffect?.("dual-rumble", { duration, strongMagnitude: strong, weakMagnitude: weak }).catch?.(() => {});
}

// ---- Keyboard -------------------------------------------------------------

const KEYS: Record<string, Action> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "a", " ": "a", Escape: "b", Backspace: "b",
  f: "x", i: "y", q: "lb", e: "rb", PageUp: "lt", PageDown: "rt",
  m: "menu", Tab: "menu", "/": "view",
};
// Keys that still navigate while a text field is focused.
const TEXT_SAFE = new Set(["ArrowUp", "ArrowDown", "Escape", "Enter"]);

function onKey(e: KeyboardEvent) {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing && !TEXT_SAFE.has(e.key)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const action = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  if (e.repeat && !REPEATS.has(action)) return;
  dispatch(action, e.repeat);
}

let started = false;
export function startInput() {
  if (started) return;
  started = true;
  window.addEventListener("keydown", onKey);
  // Touch and mouse never go through dispatch(), but they are activity all the same:
  // without this, a tap woke the screensaver and the next idle check put it straight back.
  for (const type of ["pointerdown", "pointermove", "wheel"] as const) {
    window.addEventListener(type, markActivity, { passive: true, capture: true });
  }
  requestAnimationFrame(poll);
}
