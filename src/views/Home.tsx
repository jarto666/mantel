import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "../components/Cover";
import { DOWNLOAD, Glyph, SourceIcon } from "../components/Glyph";
import { GameName } from "../components/GameName";
import { useHints } from "../components/Hints";
import { Img } from "../components/Img";
import { AchievementsStat, InstallStat, Stat } from "../components/Stat";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { ease, spring, useRem, useSettled } from "../motion";
import { askCancel, closeRunning, gamePassGames, isCatalog, launch, rescan, setFocus, setSelected, sourceLabel, toggleFavorite, useStore } from "../store";
import type { Game } from "../types";
import { hours, installLabel, lastPlayed, size } from "../util";

const SHELF_SIZE = 18;
const LIBRARY_KEY = "library";
/** Card geometry in rem; mirrors .shelf .cover in CSS. */
const CARD_W = 10.2;
const GAP = 1.25;
const FOCUS_SCALE = 1.32;

/** What Mantel just installed, then recently played, favorites, and the newest installs. */
function shelf(games: Game[], justInstalled: string[]): Game[] {
  const visible = games.filter((g) => !g.hidden && g.installed);
  const installed = justInstalled.flatMap((id) => visible.filter((g) => g.id === id && !g.lastPlayed));
  const recent = visible.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
  const favs = visible.filter((g) => g.favorite);
  const fresh = [...visible].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
  return [...new Set([...installed, ...recent, ...favs, ...fresh])].slice(0, SHELF_SIZE);
}

type Button = "play" | "quit" | "details" | "fav" | "progress" | "cancel";

/** A running game gets a close button beside Resume, so it closes from its own card. */
const buttonsFor = (game: Game | undefined, running: boolean): Button[] =>
  game && !game.installed ? ["progress", "cancel"] : running ? ["play", "quit", "details", "fav"] : ["play", "details", "fav"];

const heroVariants: Variants = {
  enter: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.045 } },
  exit: { opacity: 0, transition: { duration: 0.16 } },
};
const item: Variants = {
  enter: { opacity: 0, x: 28, filter: "blur(6px)" },
  show: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.55, ease } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.16 } },
};

function Hero({ game, running, zone, btn, armed, onPress }: { game: Game; running: boolean; zone: string; btn: number; armed: boolean; onPress: (b: Button) => void }) {
  const played = game.playtimeMinutes;
  const install = useStore((s) => s.installs[game.id]);
  const closing = useStore((s) => s.closing.includes(game.id));
  const buttons = buttonsFor(game, running);
  return (
    <motion.section className="hero" variants={heroVariants} initial="enter" animate="show" exit="exit">
      <motion.div className="hero-eyebrow" variants={item}>
        <SourceIcon source={game.source} />
        <span>{isCatalog(game) ? "PC Game Pass" : sourceLabel(game)}</span>
        {running && <span className="live"><span className="live-dot" />{t("Running")}</span>}
      </motion.div>
      <motion.div className="hero-title" variants={item}>
        <Img srcs={game.art.logo} className="hero-logo" trim fallback={<GameName name={game.name} />} />
      </motion.div>
      <motion.div className="hero-stats" variants={item}>
        {install ? (
          <InstallStat install={install} total={game.sizeBytes} />
        ) : (
          <>
            <Stat value={played ? hours(played) : "—"} unit={played ? (played >= 60 ? t("h") : t("min")) : undefined} label={t("Played")} />
            <Stat value={lastPlayed(game.lastPlayed, game.playtimeMinutes > 0)} label={t("Last played")} />
            {game.achievements && <AchievementsStat a={game.achievements} />}
            <Stat value={size(game.sizeBytes)} label={t("On disk")} />
          </>
        )}
      </motion.div>
      <motion.div className="hero-actions" variants={item}>
        {buttons.map((b, n) => (
          <button
            key={b}
            className={`btn ${b === "play" || b === "progress" ? "btn-play" : b === "quit" && (armed || closing) ? "btn-pill" : "btn-round"} ${b === "progress" ? "has-progress" : ""} ${(b === "cancel" && install?.state === "canceling") || (b === "quit" && closing) ? "is-busy" : ""} ${zone === "hub" && n === btn ? "is-focused" : ""} ${b === "fav" && game.favorite ? "is-on" : ""} ${b === "quit" && armed ? "is-armed" : ""}`}
            aria-label={b === "quit" ? t("Close game") : undefined}
            style={b === "progress" ? ({ "--progress": (install?.percent ?? 100) / 100 } as React.CSSProperties) : undefined}
            onClick={() => onPress(b)}
          >
            {b === "play" ? (
              <>
                <svg viewBox="0 0 24 24"><path d="M8 5.2v13.6L19 12z" /></svg>
                {running ? t("Resume") : t("Play")}
              </>
            ) : b === "progress" ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{DOWNLOAD}</svg>
                {install ? installLabel(install) : t("Installed")}
              </>
            ) : b === "cancel" || b === "quit" ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
                {b === "quit" && closing ? t("Closing…") : b === "quit" && armed ? t("Press A again") : null}
              </>
            ) : b === "details" ? (
              <svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" className="star"><path d="M12 3.5l2.5 5.4 5.9.6-4.4 4 1.3 5.8L12 16.4l-5.3 2.9L8 13.5l-4.4-4 5.9-.6z" /></svg>
            )}
          </button>
        ))}
      </motion.div>
    </motion.section>
  );
}

function LibraryCard({ count, focused, onClick }: { count: number; focused: boolean; onClick: () => void }) {
  return (
    <div className={`cover library-card ${focused ? "is-focused" : ""}`} onClick={onClick}>
      <div className="cover-frame">
        <div className="library-card-inner">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
          </svg>
          <span className="library-card-count">{count}</span>
          <span className="library-card-label">{t("Game Library")}</span>
        </div>
      </div>
    </div>
  );
}

export function Home({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const loaded = useStore((s) => s.loaded);
  const scanning = useStore((s) => s.scanning);
  const running = useStore((s) => s.running);
  const justInstalled = useStore((s) => s.justInstalled);
  const catalog = useStore((s) => s.catalog);
  // Just the ids: the progress itself ticks every moment, and only the tile and the hero show it.
  const installing = useStore((s) => Object.keys(s.installs).join());
  // Games on their way open the shelf, as tiles that fill up. Once a scan finds one in the
  // library, that copy takes its place.
  const list = useMemo(() => {
    const ids = new Set(installing.split(","));
    const onItsWay = [...gamePassGames(games, catalog.filter((g) => ids.has(g.id))), ...games.filter((g) => !g.installed && ids.has(g.id))];
    for (const g of onItsWay) ids.add(g.id);
    return [...onItsWay, ...shelf(games, justInstalled).filter((g) => !ids.has(g.id))];
  }, [catalog, installing, games, justInstalled]);
  const total = useMemo(() => games.filter((g) => !g.hidden && g.installed).length, [games]);
  const rem = useRem();

  // Focus follows a game, not a slot: the shelf reorders when something gets played.
  const [wantKey, setFocusKey] = useState<string | null>(null);
  // A finished install's tile hands focus to the library's copy.
  const focusKey = useMemo(() => {
    const from = catalog.find((g) => g.id === wantKey);
    return from && !list.some((g) => g.id === from.id) ? gamePassGames(games, [from])[0].id : wantKey;
  }, [wantKey, catalog, list, games]);
  const [dir, setDir] = useState(1);
  const [zone, setZone] = useState<"rail" | "hub">("rail");
  const [btn, setBtn] = useState(0);

  const keyAt = (i: number) => (i >= list.length ? LIBRARY_KEY : list[i].id);
  const found = focusKey === LIBRARY_KEY ? list.length : list.findIndex((g) => g.id === focusKey);
  const c = found >= 0 ? found : 0; // list.length = the library card
  const game: Game | undefined = list[c];
  const heroGame = useSettled(game, 70);
  // A game focused again while its hero is still fading out would get that same element back,
  // with its logo, stats and buttons stuck faded: every showing gets a key of its own.
  const showing = useRef<{ id: string | null; n: number }>({ id: null, n: 0 });
  if (heroGame && heroGame.id !== showing.current.id) showing.current = { id: heroGame.id, n: showing.current.n + 1 };
  const isRunning = !!game && running.some((r) => r.id === game.id);
  const buttons = buttonsFor(game, isRunning);
  const onItsWay = !!game && !game.installed;
  // Closing asks twice: the first press turns the button into "Press A again", the second
  // closes the game, and the button says so until it's gone.
  const [armed, setArmed] = useState(false);
  const closing = useStore((s) => !!game && s.closing.includes(game.id));
  useEffect(() => setArmed(false), [game?.id, isRunning]);
  // Once the game is gone its button goes too: focus goes back to Play.
  useEffect(() => {
    if (!isRunning) setBtn(0);
  }, [isRunning]);

  useEffect(() => {
    if (!active) return;
    setSelected(game?.id ?? null);
    if (game) setFocus(game);
  }, [active, game]);

  const openLibrary = () => useStore.setState({ view: "library" });
  // A game still installing opens its page: there's nothing to launch yet.
  const activate = (g: Game) => (g.installed ? launch(g) : useStore.setState({ detailsId: g.id }));
  const press = (b: Button) => {
    if (!game) return;
    if (b !== "quit") setArmed(false);
    if (b === "play") launch(game);
    if (b === "details" || b === "progress") useStore.setState({ detailsId: game.id });
    if (b === "fav") toggleFavorite(game);
    if (b === "cancel") askCancel(game);
    if (b === "quit") {
      if (closing) return;
      if (!armed) return setArmed(true);
      setArmed(false);
      closeRunning(game.id);
    }
  };
  const move = (d: number) => {
    const next = c + d;
    if (next < 0 || next > list.length) return "edge" as const;
    setDir(d);
    setFocusKey(keyAt(next));
  };

  useInput(
    (a) => {
      if (!list.length) {
        if (a === "a") return void rescan();
        return false;
      }
      if (zone === "hub") {
        if (a !== "a") setArmed(false);
        switch (a) {
          case "left":
            return btn > 0 ? setBtn(btn - 1) : "edge";
          case "right":
            return btn < buttons.length - 1 ? setBtn(btn + 1) : "edge";
          case "down":
          case "b":
            return setZone("rail");
          case "up":
            return "edge";
          case "a":
            press(buttons[btn]);
            return buttons[btn] === "play" ? "silent" : undefined;
          case "y":
            return press("details");
          case "x":
            return onItsWay ? "edge" : press("fav");
          default:
            return false;
        }
      }
      switch (a) {
        case "left":
          return move(-1);
        case "right":
          return move(1);
        case "up":
          if (!game) return "edge";
          setBtn(0);
          return setZone("hub");
        case "down":
          return "edge";
        case "a":
          if (!game) return openLibrary();
          activate(game);
          return onItsWay ? undefined : "silent";
        case "y":
          return game ? press("details") : "edge";
        case "x":
          return game && !onItsWay ? press("fav") : "edge";
        default:
          return false;
      }
    },
    Layer.view,
    active,
  );
  useHints(
    !list.length
      ? [["a", "Scan again"], ["menu", "Control center"]]
      : !game
        ? [["a", "Open library"], ["view", "Search"], ["menu", "Control center"]]
        : onItsWay
          ? [["a", "Details"], ["view", "Search"], ["menu", "Control center"]]
          : zone === "hub" && buttons[btn] === "quit"
            ? closing
              ? [["y", "Details"], ["menu", "Control center"]]
              : [["a", armed ? "Confirm" : "Close game"], ["y", "Details"], ["menu", "Control center"]]
          : [["a", isRunning ? "Resume" : "Play"], ["y", "Details"], ["x", game.favorite ? "Unfavorite" : "Favorite"], ["view", "Search"], ["menu", "Control center"]],
    Layer.view,
    active,
  );

  if (loaded && !list.length) {
    return (
      <main className="home">
        <div className="empty-state">
          <div className="eyebrow">{scanning ? t("Looking for games…") : t("Nothing here yet")}</div>
          <h1>{t("No games found")}</h1>
          <p>
            {t("Mantel reads your Steam, Epic Games, GOG, Xbox / Game Pass and Ubisoft Connect libraries. Install something in any of them, or add your own in Settings.")}
          </p>
          <span className="btn btn-play is-focused"><Glyph b="a" />{t("Scan again")}</span>
        </div>
      </main>
    );
  }

  // The focused card sits first, under the hero; the edge of the previous one peeks in from the left.
  const step = (CARD_W + GAP) * rem;
  const extra = CARD_W * (FOCUS_SCALE - 1) * rem;
  const xOf = (i: number) => (i - c) * step + (i > c ? extra : 0);

  return (
    <main className={`home zone-${zone}`}>
      <div className="hero-layer">
      <AnimatePresence mode="popLayout" initial={false}>
        {heroGame && (
          <Hero
            key={`${heroGame.id}:${showing.current.n}`}
            game={heroGame}
            running={running.some((r) => r.id === heroGame.id)}
            zone={zone}
            btn={btn}
            armed={armed}
            onPress={(b) => {
              setZone("hub");
              setBtn(buttons.indexOf(b));
              press(b);
            }}
          />
        )}
      </AnimatePresence>
      </div>

      <div className="shelf" data-dir={dir > 0 ? "r" : "l"}>
        <motion.div className="shelf-glow" animate={{ x: 0 }} transition={spring.rail} />
        {[...list, null].map((g, i) => {
          const focused = i === c;
          // Only the edge of the previous card shows, dimmed, so the shelf shows it goes on that way.
          const peek = i === c - 1;
          const hidden = i < c - 1 || xOf(i) > 125 * rem;
          const opacity = hidden ? 0 : peek ? (zone === "hub" ? 0.2 : 0.4) : zone === "hub" && !focused ? 0.45 : 1;
          return (
            <motion.div
              key={g?.id ?? "library"}
              className="shelf-slot"
              initial={false}
              animate={{ x: xOf(i), scale: focused ? FOCUS_SCALE : 1, opacity }}
              transition={spring.rail}
            >
              {g ? (
                <Cover
                  game={g}
                  focused={focused && zone === "rail"}
                  running={running.some((r) => r.id === g.id)}
                  className={focused ? "is-current" : ""}
                  lazy={i > 10}
                  onClick={() => {
                    setZone("rail");
                    if (focused) activate(g);
                    else {
                      setDir(i > c ? 1 : -1);
                      setFocusKey(keyAt(i));
                    }
                  }}
                />
              ) : (
                <LibraryCard count={total} focused={focused && zone === "rail"} onClick={openLibrary} />
              )}
            </motion.div>
          );
        })}
      </div>
    </main>
  );
}
