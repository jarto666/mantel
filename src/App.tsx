import { MotionConfig } from "motion/react";
import { memo, useEffect, useMemo, useState } from "react";
import { Background } from "./components/Background";
import { Boundary } from "./components/Boundary";
import { CancelPrompt } from "./components/CancelPrompt";
import { HintBar } from "./components/Hints";
import { LaunchOverlay } from "./components/LaunchOverlay";
import { QuickMenu } from "./components/QuickMenu";
import { Search } from "./components/Search";
import { Toasts } from "./components/Toasts";
import { UpdateOffer, UpdateScreen } from "./components/Update";
import { tabOrder, timeText, TopBar, useClock } from "./components/TopBar";
import { isTauri } from "./api";
import { usePageHidden } from "./hooks";
import { idleFor, Layer, setBackgroundInput, setWakeHandler, startInput, useInput } from "./input";
import { warmUpSound } from "./sound";
import { setLanguage, t } from "./i18n";
import { boot, gameById, toast, useStore, wireEvents } from "./store";
import { installLabel } from "./util";
import { Details } from "./views/Details";
import { GamePass } from "./views/GamePass";
import { Home } from "./views/Home";
import { Library } from "./views/Library";
import { Settings } from "./views/Settings";
import { Setup } from "./views/Setup";
import { Steam } from "./views/Steam";

const AMBIENT_AFTER = 30_000;

// These follow the store themselves; a tab changing is no reason to render all of them again.
const HomeTab = memo(Home);
const LibraryTab = memo(Library);
const SteamTab = memo(Steam);
const XboxTab = memo(GamePass);
const SettingsTab = memo(Settings);
const Page = memo(Details);
const Menu = memo(QuickMenu);
const SearchOverlay = memo(Search);

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
  const install = useStore((s) => Object.values(s.installs)[0]);
  const installing = gameById(install?.id ?? null);
  return (
    <div className="ambient">
      <div className="ambient-time">{timeText(now)}</div>
      {install && installing && <div className="ambient-sub">{installing.name} · {installLabel(install)}</div>}
      <div className="ambient-sub">{install && game?.id === install.id ? t("press any button") : `${game ? game.name : "Mantel"} · ${t("press any button")}`}</div>
    </div>
  );
}

export function App() {
  // Set before anything below renders; the key then remounts the interface in the new language.
  const languageSetting = useStore((s) => s.settings?.language ?? "");
  const lang = useMemo(() => setLanguage(languageSetting), [languageSetting]);
  const view = useStore((s) => s.view);
  const detailsId = useStore((s) => s.detailsId);
  const overlay = useStore((s) => s.overlay);
  const accent = useStore((s) => s.accent);
  // Pauses CSS motion while a game is in front, so Mantel costs nothing in the background.
  const idle = usePageHidden();
  const launching = useStore((s) => s.launching);
  const setup = useStore((s) => s.setupStep !== null);
  // The screensaver shows the games' art; with none (Home's empty state) there's nothing to show.
  const hasGames = useStore((s) => s.games.some((g) => g.installed && !g.hidden) || Object.keys(s.installs).length > 0);
  const updateShown = useStore((s) => s.updateOffer !== null || s.updating !== null);
  const ambient = useAmbient(view === "home" && !detailsId && !overlay && !launching && !setup && hasGames && !updateShown);

  useEffect(() => {
    startInput();
    requestIdleCallback(() => warmUpSound());
    setBackgroundInput(() => !useStore.getState().running.length);
    if (isTauri) import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setFocus()).catch(() => {});
    const off = wireEvents();
    boot().catch((e) => toast(t("Startup failed: {error}", { error: String(e) }), "warn"));
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
        const order = tabOrder();
        const n = order.indexOf(s.view) + (a === "lb" ? -1 : 1);
        if (n < 0 || n >= order.length) return "edge";
        useStore.setState({ view: order[n], detailsId: null });
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
    <div key={lang} className={`app view-${view} ${detailsId ? "has-page" : ""} ${idle ? "is-idle" : ""} ${ambient ? "is-ambient" : ""} ${setup ? "has-setup" : ""}`}>
      <Boundary>
      <Background mode={bgMode} />
      <TopBar />
      <div className={`view ${view === "home" ? "is-active" : ""}`}>
        <HomeTab active={viewActive && view === "home"} />
      </div>
      <div className={`view ${view === "library" ? "is-active" : ""}`}>
        <LibraryTab active={viewActive && view === "library"} />
      </div>
      <div className={`view ${view === "steam" ? "is-active" : ""}`}>
        <SteamTab active={viewActive && view === "steam"} />
      </div>
      <div className={`view ${view === "gamepass" ? "is-active" : ""}`}>
        <XboxTab active={viewActive && view === "gamepass"} />
      </div>
      <div className={`view ${view === "settings" ? "is-active" : ""}`}>
        <SettingsTab active={viewActive && view === "settings"} />
      </div>
      <Page />
      <Menu />
      <SearchOverlay />
      <LaunchOverlay />
      <CancelPrompt />
      <Setup />
      <UpdateOffer />
      <UpdateScreen />
      {ambient && <AmbientCaption />}
      <Toasts />
      <HintBar />
      </Boundary>
    </div>
    </MotionConfig>
  );
}
