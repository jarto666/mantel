import { useMemo } from "react";
import { locale, t } from "../i18n";
import { gamePassGames, openSignIn, useStore, xboxPage } from "../store";
import type { Game } from "../types";
import { Browse, genreModes, myGames, type Pager, type Section, type Shelf } from "./Browse";

/** The store's genres by their English names, which is how its lists are filtered. */
const STORE_GENRES = ["Action & adventure", "Shooter", "Role playing", "Racing & flying", "Strategy", "Simulation", "Sports", "Fighting", "Platformer", "Puzzle & trivia", "Family & kids", "Card & board"];

const storePager = (list: string, genre: string | null = null): Pager => (_, page) => xboxPage(list, genre, page + 1);

/**
 * Xbox: the PC Game Pass catalog with its picks on shelves (what's new, what's leaving, what's
 * popular), then every game and each genre, the Xbox games the player has, and the Microsoft
 * Store. Buying happens in the Xbox app.
 */
export function GamePass({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const catalog = useStore((s) => s.catalog);
  const signedIn = useStore((s) => !!s.accounts?.xboxGamertag);
  const shelvesOnStore = useStore((s) => s.xboxStore);
  const all = useMemo(() => gamePassGames(games, catalog), [games, catalog]);

  // A store entry gives way to the same game on Game Pass or in the library, which can install or play.
  const own = useMemo(() => {
    const pass = new Map(catalog.map((c, i) => [c.id.replace("gamepass:", "msstore:"), all[i]]));
    const library = new Map(games.filter((g) => g.source === "xbox").map((g) => [g.sourceId.toLowerCase(), g]));
    return (g: Game) => pass.get(g.id) ?? library.get(g.sourceId.toLowerCase()) ?? g;
  }, [games, catalog, all]);

  const sections = useMemo<Section[]>(() => {
    const tagged = (tag: string) => all.filter((g) => g.tags?.includes(tag));
    const shelves: Shelf[] = [
      { id: "installed", title: "Installed games", games: all.filter((g) => g.installed) },
      { id: "new", title: "Recently added", games: tagged("new") },
      { id: "leaving", title: "Leaving soon", games: tagged("leaving") },
      { id: "popular", title: "Most popular", games: tagged("popular") },
      { id: "eaplay", title: "EA Play", games: tagged("eaplay") },
    ];
    const byName = [...all].sort((a, b) => a.name.localeCompare(b.name, locale()));
    const pass: Section = {
      id: "pass",
      label: "Game Pass",
      count: all.length,
      modes: [{ id: "featured", label: "Featured", shelves: shelves.filter((s) => s.games.length) }, { id: "all", label: "All games", games: byName }, ...genreModes(all)],
    };
    const mine = games.filter((g) => g.source === "xbox" && !g.hidden);
    const signIn = signedIn ? undefined : { label: t("Sign in"), text: t("Sign in to see all your games"), run: () => openSignIn("xbox") };
    const store: Section = {
      id: "store",
      label: "Store",
      modes: [
        ...(shelvesOnStore ? [{ id: "featured", label: "Featured", shelves: shelvesOnStore.map((s) => ({ ...s, games: s.games.map(own), pager: storePager(s.id) })) }] : []),
        { id: "all", label: "All games", pager: storePager("popular") },
        ...STORE_GENRES.map((genre) => ({ id: genre, label: genre, pager: storePager("popular", genre) })),
      ],
    };
    return [...(all.length ? [pass] : []), myGames("mine", mine, signIn), store];
  }, [games, all, signedIn, shelvesOnStore, own]);

  return <Browse active={active} sections={sections} own={own} />;
}
