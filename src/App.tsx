import { MotionConfig } from "motion/react";
import { useEffect, useState } from "react";
import { Background } from "./components/Background";
import { HintBar } from "./components/Hints";
import { LaunchOverlay } from "./components/LaunchOverlay";
import { QuickMenu } from "./components/QuickMenu";
import { Search } from "./components/Search";
import { Toasts } from "./components/Toasts";
import { TAB_ORDER, timeText, TopBar, useClock } from "./components/TopBar";
import { isTauri } from "./api";
import { idleFor, Layer, setBackgroundInput, setWakeHandler, startInput, useInput } from "./input";
import { warmUpSound } from "./sound";
import { boot, gameById, toast, useStore, wireEvents } from "./store";
import { Details } from "./views/Details";
import { Home } from "./views/Home";
import { Library } from "./views/Library";
import { Settings } from "./views/Settings";

/** Pauses CSS motion while a game is in front, so Mantel costs nothing in the background. */
function useIdle() {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const update = () => setIdle(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return idle;
}

const AMBIENT_AFTER = 30_000;

// The tap that wakes the screen must not also press whatever sits under the finger.
let swallowClicksUntil = 0;
window.addEventListener(
  "click",
  (e) => {
    if (Date.now() < swallowClicksUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  },
  true,
);

/** Console-style screensaver: after a quiet spell the chrome dissolves and only the art stays. */
function useAmbient(allowed: boolean) {
  const [ambient, setAmbient] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      if (allowed && idleFor() > AMBIENT_AFTER) setAmbient(true);
    }, 1000);
    return () => clearInterval(t);
  }, [allowed]);
  useEffect(() => {
    if (!allowed) setAmbient(false);
  }, [allowed]);
  useEffect(() => {
    setWakeHandler(() => {
      if (!ambient) return false;
      setAmbient(false);
      return true;
    });
    if (!ambient) return;
    const wakeOnTouch = () => {
      swallowClicksUntil = Date.now() + 600;
      setAmbient(false);
    };
    window.addEventListener("pointerdown", wakeOnTouch, { once: true });
    return () => window.removeEventListener("pointerdown", wakeOnTouch);
  }, [ambient]);
  return ambient;
}

function AmbientCaption() {
  const now = useClock(10_000);
  const game = useStore((s) => gameById(s.focusId));
  return (
    <div className="ambient">
      <div className="ambient-time">{timeText(now)}</div>
      <div className="ambient-sub">{game ? game.name : "Mantel"} · press any button</div>
    </div>
  );
}

export function App() {
  const view = useStore((s) => s.view);
  const detailsId = useStore((s) => s.detailsId);
  const overlay = useStore((s) => s.overlay);
  const accent = useStore((s) => s.accent);
  const idle = useIdle();
  const launching = useStore((s) => s.launching);
  const ambient = useAmbient(view === "home" && !detailsId && !overlay && !launching);

  useEffect(() => {
    startInput();
    requestIdleCallback(() => warmUpSound());
    setBackgroundInput(() => !useStore.getState().running);
    if (isTauri) import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFocus()).catch(() => {});
    const off = wireEvents();
    boot().catch((e) => toast(`Startup failed: ${e}`, "warn"));
    return off;
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  // Shell-level controls; views pass through anything they don't use.
  useInput((a) => {
    const s = useStore.getState();
    switch (a) {
      case "lb":
      case "rb": {
        const n = TAB_ORDER.indexOf(s.view) + (a === "lb" ? -1 : 1);
        if (n < 0 || n >= TAB_ORDER.length) return "edge";
        useStore.setState({ view: TAB_ORDER[n] });
        return;
      }
      case "menu":
        useStore.setState({ overlay: "menu" });
        return;
      case "view":
        useStore.setState({ overlay: "search" });
        return;
      case "b":
        if (s.view === "home") return "silent";
        useStore.setState({ view: "home" });
        return;
      default:
        return "silent";
    }
  }, Layer.base);

  const viewActive = !detailsId && !overlay;
  const bgMode = detailsId ? "page" : view === "home" ? "home" : "dim";

  return (
    <MotionConfig reducedMotion="user">
    <div className={`app view-${view} ${detailsId ? "has-page" : ""} ${idle ? "is-idle" : ""} ${ambient ? "is-ambient" : ""}`}>
      <Background mode={bgMode} />
      <TopBar />
      <div className={`view ${view === "home" ? "is-active" : ""}`}>
        <Home active={viewActive && view === "home"} />
      </div>
      <div className={`view ${view === "library" ? "is-active" : ""}`}>
        <Library active={viewActive && view === "library"} />
      </div>
      <div className={`view ${view === "settings" ? "is-active" : ""}`}>
        <Settings active={viewActive && view === "settings"} />
      </div>
      <Details />
      <QuickMenu />
      <Search />
      <LaunchOverlay />
      {ambient && <AmbientCaption />}
      <Toasts />
      <HintBar />
    </div>
    </MotionConfig>
  );
}
