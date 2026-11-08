import { useMemo } from "react";
import { locale, t } from "../i18n";
import { gamePassGames, useStore, xboxPage } from "../store";
import type { Game } from "../types";
import { Browse, type Mode, type Pager, type Shelf } from "./Browse";

/** The store's genres by their English names, which is how its lists are filtered. */
const STORE_GENRES = ["Action & adventure", "Shooter", "Role playing", "Racing & flying", "Strategy", "Simulation", "Sports", "Fighting", "Platformer", "Puzzle & trivia", "Family & kids", "Card & board"];

const storePager = (list: string, genre: string | null = null): Pager => (_, page) => xboxPage(list, genre, page + 1);

/**
 * Xbox: the PC Game Pass catalog on shelves (what's new, what's leaving, what's popular, all of
 * it), then the Microsoft Store's picks, everything and each genre. The Xbox games the player has
 * are in the library. Buying happens in the Xbox app.
 */
export function GamePass({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const catalog = useStore((s) => s.catalog);
  const shelvesOnStore = useStore((s) => s.xboxStore);
  const all = useMemo(() => gamePassGames(games, catalog), [games, catalog]);

  // A store entry gives way to the same game on Game Pass or in the library, which can install or play.
  const own = useMemo(() => {
    const pass = new Map(catalog.map((c, i) => [c.id.replace("gamepass:", "msstore:"), all[i]]));
    const library = new Map(games.filter((g) => g.source === "xbox").map((g) => [g.sourceId.toLowerCase(), g]));
    return (g: Game) => pass.get(g.id) ?? library.get(g.sourceId.toLowerCase()) ?? g;
  }, [games, catalog, all]);

  const modes = useMemo<Mode[]>(() => {
    const tagged = (tag: string) => all.filter((g) => g.tags?.includes(tag));
    const byName = [...all].sort((a, b) => a.name.localeCompare(b.name, locale()));
    const pass: Shelf[] = [
      { id: "new", title: "Recently added", games: tagged("new") },
      { id: "leaving", title: "Leaving soon", games: tagged("leaving") },
      { id: "popular", title: "Most popular", games: tagged("popular") },
      { id: "eaplay", title: "EA Play", games: tagged("eaplay") },
      { id: "all", title: "All of Game Pass", games: byName },
    ];
    return [
      ...(all.length ? [{ id: "pass", label: "Game Pass", shelves: pass.filter((s) => s.games.length) }] : []),
      ...(shelvesOnStore ? [{ id: "featured", label: "Featured", shelves: shelvesOnStore.map((s) => ({ ...s, games: s.games.map(own), pager: storePager(s.id) })) }] : []),
      { id: "all", label: "All games", pager: storePager("popular") },
      ...STORE_GENRES.map((genre) => ({ id: genre, label: genre, pager: storePager("popular", genre) })),
    ];
  }, [all, shelvesOnStore, own]);

  return <Browse active={active} label={t("Store")} modes={modes} own={own} />;
}
