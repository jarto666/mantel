import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { AddApp } from "../components/AddGame";
import { useHints, type Hint } from "../components/Hints";
import { Img } from "../components/Img";
import { useScrollFocus } from "../hooks";
import { errorText, locale, t } from "../i18n";
import { Layer, useInput } from "../input";
import { closeRunning, launch, setFocus, setSelected, toast, useStore } from "../store";
import type { Game } from "../types";

type Tile = { kind: "add" } | { kind: "app"; app: Game };

const PLUS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const CROSS = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

/** An app on its own colour: icon in the middle, name below. */
function AppTile({ app, focused, running, armed, removing, closing, onClick }: { app: Game; focused: boolean; running: boolean; armed: boolean; removing: boolean; closing: boolean; onClick: () => void }) {
  return (
    <div className={`app-tile ${focused ? "is-focused" : ""}`} onClick={onClick}>
      <div className="app-tile-frame" style={{ "--tile": app.color ?? undefined } as React.CSSProperties}>
        <Img srcs={app.art.icon} className="app-tile-icon" trim fallback={<span className="app-tile-letter">{app.name.slice(0, 1)}</span>} />
        {/* Open, as a dock marks it: a dot, no clock. */}
        {running && !armed && !closing && !removing && <span className="app-tile-open" />}
        {(armed || closing || removing) && <span className={`app-tile-ask ${closing ? "is-busy" : ""}`}>{closing ? t("Closing…") : removing ? t("Press X again") : t("Press Y again")}</span>}
      </div>
      <div className="app-tile-name">{app.name}</div>
    </div>
  );
}

function AddTile({ focused, onClick }: { focused: boolean; onClick: () => void }) {
  return (
    <div className={`app-tile app-add ${focused ? "is-focused" : ""}`} onClick={onClick}>
      <div className="app-tile-frame">
        {PLUS}
      </div>
      <div className="app-tile-name">{t("Add app")}</div>
    </div>
  );
}

/**
 * Programs and sites, apart from the games: music, video, chat, browsers. Laid out like Home:
 * the selected app big on its own colour, a shelf below. They launch, switch and close like
 * games; time in them isn't playtime.
 */
export function Apps({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const running = useStore((s) => s.running);
  const closingIds = useStore((s) => s.closing);
  const apps = useMemo(
    () =>
      games
        .filter((g) => g.kind === "app" && !g.hidden)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.name.localeCompare(b.name, locale())),
    [games],
  );
  const tiles = useMemo<Tile[]>(() => [...apps.map((app) => ({ kind: "app" as const, app })), { kind: "add" }], [apps]);
  const [index, setIndex] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  // Taking an app off the tab asks twice too.
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The buttons over the shelf, as on Home.
  const [zone, setZone] = useState<"tiles" | "hub">("tiles");
  const [btn, setBtn] = useState(0);
  const i = Math.min(index, tiles.length - 1);
  const tile = tiles[i];
  const app = tile.kind === "app" ? tile.app : undefined;
  const isRunning = !!app && running.some((r) => r.id === app.id);
  const closing = !!app && closingIds.includes(app.id);
  const buttons: ("open" | "quit")[] = app && isRunning ? ["open", "quit"] : ["open"];

  const shelf = useRef<HTMLDivElement>(null);
  useScrollFocus(shelf, `apps:${i}`, { axis: "x" });

  useEffect(() => {
    if (!active) return;
    setSelected(app?.id ?? null);
    if (app) setFocus(app);
  }, [active, app]);
  useEffect(() => {
    setArmed(null);
    setRemoving(null);
  }, [i, isRunning, zone, btn]);
  useEffect(() => {
    if (!isRunning) setBtn(0);
  }, [isRunning]);

  const open = (n: number) => {
    const x = tiles[n];
    if (x.kind === "add") return setAdding(true);
    launch(x.app);
  };
  const remove = async (a: Game) => {
    if (removing !== a.id) return setRemoving(a.id);
    setRemoving(null);
    try {
      useStore.setState({ games: await api.removeApp(a.id) });
      toast(t("Removed {name} from Apps", { name: a.name }), "good");
    } catch (e) {
      toast(errorText(e), "warn");
    }
  };
  const close = (a: Game) => {
    if (closingIds.includes(a.id)) return;
    if (armed !== a.id) return setArmed(a.id);
    setArmed(null);
    closeRunning(a.id);
  };

  useInput(
    (a) => {
      if (zone === "hub") {
        switch (a) {
          case "left":
            return btn > 0 ? setBtn(btn - 1) : "edge";
          case "right":
            return btn < buttons.length - 1 ? setBtn(btn + 1) : "edge";
          case "down":
          case "b":
            return setZone("tiles");
          case "a":
            if (buttons[btn] === "quit" && app) return close(app);
            open(i);
            return app ? "silent" : undefined;
          case "y":
            return app && isRunning ? close(app) : "edge";
          default:
            return false;
        }
      }
      switch (a) {
        case "left":
          return i === 0 ? "edge" : setIndex(i - 1);
        case "right":
          return i >= tiles.length - 1 ? "edge" : setIndex(i + 1);
        case "up":
          setBtn(0);
          return setZone("hub");
        case "a":
          open(i);
          return app ? "silent" : undefined;
        case "y":
          return app && isRunning ? close(app) : "edge";
        case "x":
          return app && !isRunning ? void remove(app) : "edge";
        default:
          return false;
      }
    },
    Layer.view,
    active && !adding,
  );
  const hints: Hint[] = !app
    ? [["a", "Add app"], ["view", "Search"]]
    : zone === "hub" && buttons[btn] === "quit"
      ? closing
        ? [["b", "Back"]]
        : [["a", armed ? "Confirm" : "Close app"], ["b", "Back"]]
      : isRunning
        ? closing
          ? [["a", "Resume"], ["view", "Search"]]
          : [["a", "Resume"], ["y", armed ? "Confirm" : "Close app"], ["view", "Search"]]
        : [["a", "Open"], ["x", removing ? "Confirm" : "Remove"], ["view", "Search"]];
  useHints(hints, Layer.view, active && !adding);

  const tileList = tiles.map((x, n) =>
    x.kind === "app" ? (
      <AppTile
        key={x.app.id}
        app={x.app}
        focused={zone === "tiles" && n === i}
        running={running.some((r) => r.id === x.app.id)}
        armed={armed === x.app.id && zone === "tiles"}
        removing={removing === x.app.id}
        closing={closingIds.includes(x.app.id)}
        onClick={() => {
          setZone("tiles");
          if (n === i) open(n);
          else setIndex(n);
        }}
      />
    ) : (
      <AddTile
        key="add"
        focused={zone === "tiles" && n === i}
        onClick={() => {
          setZone("tiles");
          if (n === i) open(n);
          else setIndex(n);
        }}
      />
    ),
  );

  const quitArmed = !!app && armed === app.id && zone === "hub";
  return (
    <main className="apps-scene">
      <div className="apps-ambient" key={app?.id ?? "add"} style={{ "--tile": app?.color ?? "#3a3f52" } as React.CSSProperties}>
        {app && <Img srcs={app.art.icon} className="apps-ghost" trim />}
      </div>
      <section className="apps-hero" key={`hero:${app?.id ?? "add"}`}>
        <div className="apps-hero-icon" style={{ "--tile": app?.color ?? undefined } as React.CSSProperties}>
          {app ? <Img srcs={app.art.icon} trim fallback={<span className="app-tile-letter">{app.name.slice(0, 1)}</span>} /> : PLUS}
          {/* Open: a dot on its icon, so nothing below moves. */}
          {isRunning && <span className="apps-hero-open" />}
        </div>
        <h1 className="apps-hero-name">{app ? app.name : t("Add an app")}</h1>
        <div className="apps-hero-meta">
          {app ? app.site : t("Programs, Microsoft Store apps and websites")}
        </div>
        <div className="hero-actions">
          {buttons.map((b, n) => (
            <button
              key={b}
              className={`btn ${b === "open" ? "btn-play" : quitArmed || closing ? "btn-pill" : "btn-round"} ${zone === "hub" && n === btn ? "is-focused" : ""} ${b === "quit" && quitArmed ? "is-armed" : ""} ${b === "quit" && closing ? "is-busy" : ""}`}
              onClick={() => {
                setZone("hub");
                setBtn(n);
                if (b === "quit" && app) close(app);
                else open(i);
              }}
            >
              {b === "open" ? (
                <>
                  {app ? <svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" /></svg> : PLUS}
                  {!app ? t("Add") : isRunning ? t("Resume") : t("Open")}
                </>
              ) : (
                <>
                  {CROSS}
                  {closing ? t("Closing…") : quitArmed ? t("Press A again") : null}
                </>
              )}
            </button>
          ))}
        </div>
      </section>
      <div className="apps-shelf" ref={shelf}>
        {tileList}
      </div>
      {adding && <AddApp onClose={() => setAdding(false)} />}
    </main>
  );
}
