import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "../components/Cover";
import { Glyph, SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { useGridColumns, useHandler, useOverflowing, useScrollFocus, useWindow } from "../hooks";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { spring } from "../motion";
import { launch, setFocus, toggleFavorite, useStore } from "../store";
import type { Game, Source } from "../types";
import { playtime, SOURCE_NAME } from "../util";

interface Filter {
  id: string;
  label: string;
  source?: Source;
  apply: (games: Game[]) => Game[];
}

const BASE_FILTERS: Filter[] = [
  { id: "all", label: "All", apply: (g) => g },
  { id: "fav", label: "Favorites", apply: (g) => g.filter((x) => x.favorite) },
  {
    id: "recent",
    label: "Recent",
    apply: (g) => g.filter((x) => x.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)),
  },
  {
    id: "most",
    label: "Most played",
    apply: (g) => g.filter((x) => x.playtimeMinutes > 0).sort((a, b) => b.playtimeMinutes - a.playtimeMinutes),
  },
];

export function Library({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const running = useStore((s) => s.running);
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const installed = useMemo(() => visible.filter((g) => g.installed), [visible]);

  const filters = useMemo(() => {
    const present = new Set(installed.map((g) => g.source));
    const missing = visible.length - installed.length;
    const bySource: Filter[] = (Object.keys(SOURCE_NAME) as Source[])
      .filter((s) => present.has(s))
      .map((s) => ({ id: s, label: SOURCE_NAME[s], source: s, apply: (g) => g.filter((x) => x.source === s) }));
    const notInstalled: Filter[] = missing
      ? [{ id: "uninstalled", label: "Not installed", apply: () => visible.filter((g) => !g.installed) }]
      : [];
    return [...BASE_FILTERS, ...notInstalled, ...(present.size > 1 ? bySource : [])];
  }, [visible, installed]);

  const [filterIndex, setFilterIndex] = useState(0);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<"l" | "r" | "u" | "d">("r");
  const f = Math.min(filterIndex, filters.length - 1);
  const list = useMemo(() => filters[f].apply([...installed]), [filters, f, installed]);
  const i = Math.min(index, Math.max(0, list.length - 1));
  const game = list[i];

  const track = useRef<HTMLDivElement>(null);
  const railOver = useOverflowing(track, `${f}:${filters.length}`);
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(grid, filters[f].id);
  const end = useRef<HTMLDivElement>(null);
  const shown = useWindow(list.length, i, cols, filters[f].id, end);
  useScrollFocus(scroller, `${f}:${i}`);

  useEffect(() => {
    if (active && game) setFocus(game);
  }, [active, game]);

  const pick = useHandler((g: Game) => {
    const n = list.indexOf(g);
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
          if (i % cols === cols - 1 || i >= list.length - 1) return "edge";
          setDir("r");
          return setIndex(i + 1);
        case "up":
          if (i < cols) return "edge";
          setDir("u");
          return setIndex(i - cols);
        case "down": {
          const lastRow = Math.floor((list.length - 1) / cols);
          if (Math.floor(i / cols) >= lastRow) return "edge";
          setDir("d");
          return setIndex(Math.min(i + cols, list.length - 1));
        }
        case "lt":
          return switchFilter(-1);
        case "rt":
          return switchFilter(1);
        case "a":
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
    [["a", game && !game.installed ? "Install" : "Play"], ["y", "Details"], ["x", game?.favorite ? "Unfavorite" : "Favorite"], [["lt", "rt"], "Filter"], ["view", "Search"]],
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
                    <span>{flt.id === "all" && n === f ? t("All games") : t(flt.label)}</span>
                    {n === f && <span className="filter-count">{list.length}</span>}
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
        <div className="grid" ref={grid} key={filters[f].id} data-dir={dir}>
          {list.slice(0, shown).map((g, n) => (
            <Cover
              key={g.id}
              game={g}
              focused={n === i}
              running={running?.id === g.id}
              lazy
              onClick={pick}
            />
          ))}
        </div>
        <div ref={end} />
        {list.length === 0 && (
          <div className="grid-empty">
            {filters[f].id === "fav"
              ? t("Press X on any game to add it to favorites")
              : filters[f].id === "recent" || filters[f].id === "most"
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
