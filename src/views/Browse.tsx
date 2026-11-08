import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cover } from "../components/Cover";
import { Glyph } from "../components/Glyph";
import { useHints, type Hint } from "../components/Hints";
import { useGridColumns, useHandler, useOverflowing, useScrollFocus, useWindow } from "../hooks";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { spring } from "../motion";
import { launch, setFocus, useStore } from "../store";
import type { Game, StorePage } from "../types";

/** A list too long to have here, fetched as the player gets to it. */
export type Pager = (start: number, page: number) => Promise<StorePage>;

export interface Shelf {
  id: string;
  title: string;
  games: Game[];
  /** Where the whole list comes from, when the shelf only has its start. */
  pager?: Pager;
  /** A way on from this shelf, as a tile after its games. */
  action?: { label: string; text: string; run: () => void };
}

/** A filter: shelves of picks, or a grid of games. */
export interface Mode {
  id: string;
  label: string;
  shelves?: Shelf[];
  games?: Game[];
  pager?: Pager;
}

/** Covers on a shelf; a tile past them opens the whole list. */
const SHELF_SHOWN = 12;

type Tile = { kind: "game"; game: Game } | { kind: "all" } | { kind: "action" };

/** Each game once: two store entries can stand for the same game the player has. */
export function uniqueGames(games: Game[]): Game[] {
  const seen = new Set<string>();
  return games.filter((g) => !seen.has(g.id) && !!seen.add(g.id));
}

function tilesOf(shelf: Shelf): Tile[] {
  const tiles: Tile[] = uniqueGames(shelf.games).slice(0, SHELF_SHOWN).map((game) => ({ kind: "game", game }));
  if (shelf.pager || shelf.games.length > SHELF_SHOWN) tiles.push({ kind: "all" });
  if (shelf.action) tiles.push({ kind: "action" });
  return tiles;
}

/** Pages of a list, kept per list so that coming back to it doesn't start over. */
function usePages(key: string, pager: Pager | undefined) {
  const pages = useRef(new Map<string, { games: Game[]; loaded: number; more: boolean; busy: boolean; failed: boolean }>());
  const [, redraw] = useState(0);
  const load = useCallback(() => {
    if (!pager) return;
    const page = pages.current.get(key) ?? { games: [], loaded: 0, more: true, busy: false, failed: false };
    pages.current.set(key, page);
    if (page.busy || !page.more) return;
    page.busy = true;
    page.failed = false;
    redraw((n) => n + 1);
    pager(page.games.length, page.loaded)
      .then((next) => {
        const seen = new Set(page.games.map((g) => g.id));
        const fresh = next.games.filter((g) => !seen.has(g.id));
        page.games = [...page.games, ...fresh];
        page.loaded += 1;
        // A page with nothing new would ask for the same page again.
        page.more = next.more && fresh.length > 0;
      })
      .catch(() => {
        page.failed = true;
        page.more = false;
      })
      .finally(() => {
        page.busy = false;
        redraw((n) => n + 1);
      });
  }, [key, pager]);
  useEffect(() => {
    if (pager && !pages.current.has(key)) load();
  }, [key, pager, load]);
  const page = pages.current.get(key);
  return { games: page?.games ?? [], more: page?.more ?? false, busy: page?.busy ?? !!pager, failed: page?.failed ?? false, load };
}

function ShelfRow({ shelf, focused, col, runningId, onPick }: { shelf: Shelf; focused: boolean; col: number; runningId?: string; onPick: (n: number) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  useScrollFocus(rail, `${focused}:${col}`, { axis: "x" });
  const tiles = tilesOf(shelf);
  const pickCover = useHandler((game: Game) => onPick(tiles.findIndex((t) => t.kind === "game" && t.game === game)));
  return (
    <section className={`gp-shelf ${focused ? "is-active" : ""}`}>
      <h2 className="gp-shelf-title">
        {t(shelf.title)}
        {!shelf.pager && <span className="gp-shelf-count">{shelf.games.length}</span>}
      </h2>
      <div className="gp-rail" ref={rail}>
        {tiles.map((tile, n) =>
          tile.kind === "game" ? (
            <Cover key={tile.game.id} game={tile.game} focused={focused && n === col} running={runningId === tile.game.id} lazy installMark={false} storeMark={false} onClick={pickCover} />
          ) : (
            <div key={tile.kind} className={`cover library-card store-tile ${focused && n === col ? "is-focused" : ""}`} onClick={() => onPick(n)}>
              <div className="cover-frame">
                {tile.kind === "all" ? (
                  <div className="library-card-inner">
                    <svg viewBox="0 0 24 24">
                      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
                      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
                      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
                      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
                    </svg>
                    {!shelf.pager && <span className="library-card-count">{shelf.games.length}</span>}
                    <span className="library-card-label">{t("See all")}</span>
                  </div>
                ) : (
                  <div className="library-card-inner store-tile-action">
                    <span className="store-tile-text">{shelf.action!.text}</span>
                    <span className="library-card-label">{shelf.action!.label}</span>
                  </div>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/**
 * A store: picks on shelves that open into full lists, then everything and each genre as grids.
 * What the player already has lives in the library; here games that are installed play and the
 * rest open their page.
 */
export function Browse({ active, label, modes, own }: { active: boolean; label: string; modes: Mode[]; own?: (game: Game) => Game }) {
  const running = useStore((s) => s.running);
  const [modeIndex, setModeIndex] = useState(0);
  const m = Math.min(modeIndex, modes.length - 1);
  const mode = modes[m];
  /** A shelf opened into its full list. */
  const [opened, setOpened] = useState<Shelf | null>(null);

  const listing = opened ?? (mode.shelves ? null : mode);
  const shelvesKey = mode.id;
  const listKey = `${shelvesKey}:${opened?.id ?? ""}`;
  const pages = usePages(listKey, listing?.pager);
  const fromPages = useMemo(() => (listing?.pager ? uniqueGames(own ? pages.games.map(own) : pages.games) : null), [listing, pages.games, own]);
  const grid = listing ? fromPages ?? listing.games ?? [] : null;

  // Shelves: which one, and the place on each.
  const shelves = mode.shelves ?? [];
  const [rowOf, setRowOf] = useState<Record<string, number>>({});
  const [cols, setCols] = useState<Record<string, number>>({});
  const r = Math.min(rowOf[shelvesKey] ?? 0, Math.max(0, shelves.length - 1));
  const shelf = shelves[r] as Shelf | undefined;
  const colKey = (s: Shelf) => `${mode.id}:${s.id}`;
  const tiles = shelf ? tilesOf(shelf) : [];
  const c = shelf ? Math.min(cols[colKey(shelf)] ?? 0, Math.max(0, tiles.length - 1)) : 0;
  const tile = grid ? undefined : tiles[c];
  // Grids: one index.
  const [index, setIndex] = useState(0);
  const i = Math.min(index, Math.max(0, (grid?.length ?? 1) - 1));

  const game = grid ? grid[i] : tile?.kind === "game" ? tile.game : undefined;
  const shelvesBox = useRef<HTMLDivElement>(null);
  const gridBox = useRef<HTMLDivElement>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const gridCols = useGridColumns(gridEl, `${listKey}:${grid?.length ? 1 : 0}`);
  const shown = useWindow(grid?.length ?? 0, i, gridCols, listKey, end);
  useScrollFocus(shelvesBox, `${shelvesKey}:${r}`);
  useScrollFocus(gridBox, `${listKey}:${i}`);

  useEffect(() => {
    if (active && game) setFocus(game);
  }, [active, game]);

  // The next page comes as the player nears the end of what's here.
  const nearEnd = !!listing?.pager && !!grid && shown >= grid.length - gridCols * 2;
  useEffect(() => {
    if (nearEnd && pages.more && !pages.busy) pages.load();
  }, [nearEnd, pages]);

  const toMode = (n: number) => {
    setModeIndex(n);
    setOpened(null);
    setIndex(0);
  };
  const switchMode = (d: number) => {
    const next = m + d;
    if (next < 0 || next >= modes.length) return "edge" as const;
    toMode(next);
  };
  const setCol = (n: number) => shelf && setCols((s) => ({ ...s, [colKey(shelf)]: n }));
  const open = (g: Game) => (g.installed ? launch(g) : useStore.setState({ detailsId: g.id }));
  const openShelf = (s: Shelf) => {
    setOpened(s);
    setIndex(0);
  };
  const activate = (s: Shelf, kind: Tile["kind"]) => (kind === "all" ? openShelf(s) : s.action?.run());
  const pickInGrid = useHandler((g: Game) => {
    const n = grid?.indexOf(g) ?? -1;
    if (n === i) open(g);
    else if (n >= 0) setIndex(n);
  });

  useInput(
    (a) => {
      switch (a) {
        case "lt":
          return switchMode(-1);
        case "rt":
          return switchMode(1);
        case "b":
          if (!opened) return false;
          setOpened(null);
          return;
        case "a":
          if (tile && tile.kind !== "game" && shelf) return activate(shelf, tile.kind);
          if (!game) return "edge";
          open(game);
          return game.installed ? "silent" : undefined;
        case "y":
          if (game) useStore.setState({ detailsId: game.id });
          return;
      }
      if (grid) {
        switch (a) {
          case "left":
            return i % gridCols === 0 ? "edge" : setIndex(i - 1);
          case "right":
            return i % gridCols === gridCols - 1 || i >= grid.length - 1 ? "edge" : setIndex(i + 1);
          case "up":
            return i < gridCols ? "edge" : setIndex(i - gridCols);
          case "down":
            return Math.floor(i / gridCols) >= Math.floor((grid.length - 1) / gridCols) ? "edge" : setIndex(Math.min(i + gridCols, grid.length - 1));
          default:
            return false;
        }
      }
      switch (a) {
        case "left":
          return c > 0 ? setCol(c - 1) : "edge";
        case "right":
          return c < tiles.length - 1 ? setCol(c + 1) : "edge";
        case "up":
          return r > 0 ? setRowOf((s) => ({ ...s, [shelvesKey]: r - 1 })) : "edge";
        case "down":
          return r < shelves.length - 1 ? setRowOf((s) => ({ ...s, [shelvesKey]: r + 1 })) : "edge";
        default:
          return false;
      }
    },
    Layer.view,
    active,
  );

  const hints: Hint[] = [];
  if (game?.installed) hints.push(["a", "Play"], ["y", "Details"]);
  else if (game) hints.push(["a", "Details"]);
  else if (tile) hints.push(["a", "Select"]);
  hints.push([["lt", "rt"], "Filter"]);
  if (opened) hints.push(["b", "Back"]);
  else hints.push(["view", "Search"]);
  useHints(hints, Layer.view, active);

  const rail: Mode[] = opened ? [{ id: opened.id, label: opened.title, games: grid ?? [] }] : modes;
  const railAt = opened ? 0 : m;
  const track = useRef<HTMLDivElement>(null);
  const railOver = useOverflowing(track, `${listKey}:${rail.length}`);

  return (
    <main className="library gamepass">
      <div className="library-head">
        <div className="library-eyebrow">{label}</div>
        <div className="filter-rail">
          <Glyph b="lt" />
          <div className={`filter-track ${railOver ? "is-overflowing" : ""}`} ref={track}>
            <AnimatePresence initial={false} mode="popLayout">
              {rail.map((md, n) =>
                n < railAt - 1 ? null : (
                  <motion.button
                    layout
                    key={md.id}
                    className={`filter ${n === railAt ? "is-active" : n < railAt ? "is-prev" : ""}`}
                    initial={{ opacity: 0, x: 60 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -80 }}
                    transition={spring.rail}
                    onClick={() => !opened && toMode(n)}
                  >
                    <span>{t(md.label)}</span>
                    {n === railAt && md.games && !listing?.pager && <span className="filter-count">{md.games.length}</span>}
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

      {mode.shelves && (
        <div className={`gp-shelves ${opened ? "is-covered" : ""}`} ref={shelvesBox}>
          {shelves.map((s, n) => (
            <ShelfRow
              key={s.id}
              shelf={s}
              focused={n === r}
              col={n === r ? c : cols[colKey(s)] ?? 0}
              runningId={running?.id}
              onPick={(k) => {
                const picked = tilesOf(s)[k];
                if (n === r && k === c) return picked.kind === "game" ? open(picked.game) : activate(s, picked.kind);
                setRowOf((st) => ({ ...st, [shelvesKey]: n }));
                setCols((st) => ({ ...st, [colKey(s)]: k }));
              }}
            />
          ))}
        </div>
      )}
      {grid &&
        (grid.length ? (
          <div className="grid-scroll" ref={gridBox} key={listKey}>
            <div className="grid" ref={gridEl}>
              {grid.slice(0, shown).map((g, n) => (
                <Cover key={g.id} game={g} focused={n === i} running={running?.id === g.id} lazy installMark={false} storeMark={false} onClick={pickInGrid} />
              ))}
            </div>
            <div ref={end} />
          </div>
        ) : (
          <div className="grid-empty" key="empty">
            {pages.busy ? t("Loading…") : pages.failed ? t("Couldn't reach the store") : t("Nothing here yet")}
          </div>
        ))}

      {game && (
        <div className="library-focus" key={game.id}>
          <span className="library-focus-name">{game.name}</span>
          <span className="library-focus-meta">
            {game.genres?.[0]}
            {game.price && (
              <>
                {game.genres?.[0] && <span className="meta-dot" />}
                {t(game.price)}
              </>
            )}
            {game.installed && (
              <>
                {(game.genres?.[0] || game.price) && <span className="meta-dot" />}
                {t("Installed")}
              </>
            )}
          </span>
        </div>
      )}
    </main>
  );
}
