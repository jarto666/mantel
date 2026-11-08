import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "../components/Cover";
import { Glyph, SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { useGridColumns, useHandler, useOverflowing, useScrollFocus, useWindow } from "../hooks";
import { locale, t } from "../i18n";
import { Layer, useInput } from "../input";
import { spring } from "../motion";
import { launch, openSignIn, setFocus, toggleFavorite, useStore } from "../store";
import type { Game, Source } from "../types";
import { playtime, SOURCE_NAME } from "../util";

/** A store whose games the library only shows in full after signing in. */
type Account = "steam" | "xbox";

interface Filter {
  id: string;
  label: string;
  source?: Source;
  games: Game[];
  /** Stores to sign in to, as tiles after the games. */
  signIn: Account[];
}

type Tile = { kind: "game"; game: Game } | { kind: "sign-in"; store: Account };

/**
 * Everything the player has, from every store: what's installed first, then picks, what's on
 * the accounts and not installed, and each store on its own. The store tabs only sell.
 */
export function Library({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const running = useStore((s) => s.running);
  const sources = useStore((s) => s.settings?.sources);
  const steamIn = useStore((s) => !!s.accounts?.steam.connected);
  const xboxIn = useStore((s) => !!s.accounts?.xboxGamertag);
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const installed = useMemo(() => visible.filter((g) => g.installed), [visible]);

  const filters = useMemo(() => {
    const name = (a: Game, b: Game) => a.name.localeCompare(b.name, locale());
    const missing = visible.filter((g) => !g.installed).sort(name);
    const signedOut: Account[] = [...(sources?.steam && !steamIn ? (["steam"] as const) : []), ...(sources?.xbox && !xboxIn ? (["xbox"] as const) : [])];
    const stores = new Set<Source>([...visible.map((g) => g.source), ...signedOut]);
    const list: Filter[] = [
      { id: "installed", label: "Installed games", games: installed, signIn: [] },
      { id: "fav", label: "Favorites", games: installed.filter((x) => x.favorite), signIn: [] },
      { id: "recent", label: "Recent", games: installed.filter((x) => x.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)), signIn: [] },
      { id: "most", label: "Most played", games: installed.filter((x) => x.playtimeMinutes > 0).sort((a, b) => b.playtimeMinutes - a.playtimeMinutes), signIn: [] },
    ];
    if (missing.length || signedOut.length) list.push({ id: "uninstalled", label: "Not installed", games: missing, signIn: signedOut });
    // One store would only show the whole library again.
    if (stores.size > 1)
      for (const s of Object.keys(SOURCE_NAME) as Source[]) {
        if (!stores.has(s)) continue;
        const own = installed.filter((g) => g.source === s);
        const rest = missing.filter((g) => g.source === s);
        list.push({ id: s, label: SOURCE_NAME[s], source: s, games: [...own, ...rest], signIn: signedOut.filter((a) => a === s) });
      }
    return list;
  }, [visible, installed, sources, steamIn, xboxIn]);

  const [filterIndex, setFilterIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<"l" | "r" | "u" | "d">("r");
  const f = Math.min(filterIndex, filters.length - 1);
  const filter = filters[f];
  const tiles = useMemo<Tile[]>(() => [...filter.games.map((game) => ({ kind: "game" as const, game })), ...filter.signIn.map((store) => ({ kind: "sign-in" as const, store }))], [filter]);
  const i = Math.min(index, Math.max(0, tiles.length - 1));
  const tile = tiles[i] as Tile | undefined;
  const game = tile?.kind === "game" ? tile.game : undefined;

  const track = useRef<HTMLDivElement>(null);
  const railOver = useOverflowing(track, `${f}:${filters.length}`);
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(grid, filter.id);
  const end = useRef<HTMLDivElement>(null);
  const shown = useWindow(tiles.length, i, cols, filter.id, end);
  useScrollFocus(scroller, `${f}:${i}`);

  useEffect(() => {
    if (active && game) setFocus(game);
  }, [active, game]);

  const pick = useHandler((g: Game) => {
    const n = tiles.findIndex((x) => x.kind === "game" && x.game === g);
    if (n === i) launch(g);
    else if (n >= 0) setIndex(n);
  });

  const switchFilter = (d: number) => {
    const next = f + d;
    if (next < 0 || next >= filters.length) return "edge" as const;
    setFilterIndex(next);
    setIndex(0);
  };

  useInput(
    (a) => {
      switch (a) {
        case "left":
          if (i % cols === 0) return "edge";
          setDir("l");
          return setIndex(i - 1);
        case "right":
          if (i % cols === cols - 1 || i >= tiles.length - 1) return "edge";
          setDir("r");
          return setIndex(i + 1);
        case "up":
          if (i < cols) return "edge";
          setDir("u");
          return setIndex(i - cols);
        case "down": {
          const lastRow = Math.floor((tiles.length - 1) / cols);
          if (Math.floor(i / cols) >= lastRow) return "edge";
          setDir("d");
          return setIndex(Math.min(i + cols, tiles.length - 1));
        }
        case "lt":
          return switchFilter(-1);
        case "rt":
          return switchFilter(1);
        case "a":
          if (tile?.kind === "sign-in") return openSignIn(tile.store);
          if (!game) return "edge";
          launch(game);
          return "silent";
        case "y":
          if (game) useStore.setState({ detailsId: game.id });
          return;
        case "x":
          if (game) toggleFavorite(game);
          return;
        default:
          return false;
      }
    },
    Layer.view,
    active,
  );
  useHints(
    tile?.kind === "sign-in"
      ? [["a", "Sign in"], [["lt", "rt"], "Filter"], ["view", "Search"]]
      : [["a", game && !game.installed ? "Install" : "Play"], ["y", "Details"], ["x", game?.favorite ? "Unfavorite" : "Favorite"], [["lt", "rt"], "Filter"], ["view", "Search"]],
    Layer.view,
    active,
  );

  const more = visible.length - installed.length;

  return (
    <main className="library">
      <div className="library-head">
        <div className="library-eyebrow">{t("Game Library")} · {installed.length === 1 ? t("1 installed") : t("{n} installed", { n: installed.length })}{more > 0 ? ` · ${more === 1 ? t("1 more on your accounts") : t("{n} more on your accounts", { n: more })}` : ""}</div>
        <div className="filter-rail">
          <Glyph b="lt" />
          <div className={`filter-track ${railOver ? "is-overflowing" : ""}`} ref={track}>
            <AnimatePresence initial={false} mode="popLayout">
              {filters.map((flt, n) =>
                n < f - 1 ? null : (
                  <motion.button
                    layout
                    key={flt.id}
                    className={`filter ${n === f ? "is-active" : n < f ? "is-prev" : ""}`}
                    initial={{ opacity: 0, x: 60 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -80 }}
                    transition={spring.rail}
                    onClick={() => {
                      setFilterIndex(n);
                      setIndex(0);
                    }}
                  >
                    {flt.source && <SourceIcon source={flt.source} />}
                    <span>{t(flt.label)}</span>
                    {n === f && <span className="filter-count">{flt.games.length}</span>}
                  </motion.button>
                ),
              )}
            </AnimatePresence>
          </div>
          <motion.span layout className="filter-rail-end" transition={spring.rail}>
            <Glyph b="rt" />
          </motion.span>
        </div>
      </div>
      <div className="grid-scroll" ref={scroller}>
        <div className="grid" ref={grid} key={filter.id} data-dir={dir}>
          {tiles.slice(0, shown).map((x, n) =>
            x.kind === "game" ? (
              <Cover key={x.game.id} game={x.game} focused={n === i} running={running?.id === x.game.id} lazy onClick={pick} />
            ) : (
              <div key={`sign-in:${x.store}`} className={`cover library-card store-tile ${n === i ? "is-focused" : ""}`} onClick={() => (n === i ? openSignIn(x.store) : setIndex(n))}>
                <div className="cover-frame">
                  <div className="library-card-inner store-tile-action">
                    <SourceIcon source={x.store} />
                    <span className="store-tile-text">{t("Sign in to see all your games")}</span>
                    <span className="library-card-label">{SOURCE_NAME[x.store]}</span>
                  </div>
                </div>
              </div>
            ),
          )}
        </div>
        <div ref={end} />
        {tiles.length === 0 && (
          <div className="grid-empty">
            {filter.id === "fav"
              ? t("Press X on any game to add it to favorites")
              : filter.id === "recent" || filter.id === "most"
                ? t("Play something and it will show up here")
                : t("Nothing here")}
          </div>
        )}
      </div>
      {game && (
        <div className="library-focus" key={game.id}>
          <span className="library-focus-name">{game.name}</span>
          <span className="library-focus-meta">
            <SourceIcon source={game.source} />
            {t(SOURCE_NAME[game.source])}
            <span className="meta-dot" />
            {playtime(game.playtimeMinutes)}
          </span>
        </div>
      )}
    </main>
  );
}
