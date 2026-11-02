import { useMemo } from "react";
import { t } from "../i18n";
import { openSignIn, steamPage, useStore } from "../store";
import type { Game } from "../types";
import { Browse, myGames, type Section, type Shelf } from "./Browse";

/** Which paged list a store shelf opens into has the shelf's own id. */
const shelfPager = (list: string): Shelf["pager"] => (start) => steamPage(list, null, start);

/** The player's Steam games and the Steam store. Buying happens on Steam's own page. */
export function Steam({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const home = useStore((s) => s.steamStore);
  const connected = useStore((s) => s.accounts?.steam.connected ?? false);

  const own = useMemo(() => {
    const byId = new Map(games.map((g) => [g.id, g]));
    return (g: Game) => byId.get(g.id) ?? g;
  }, [games]);

  const sections = useMemo<Section[]>(() => {
    const mine = games.filter((g) => g.source === "steam" && !g.hidden);
    const signIn = connected ? undefined : { label: t("Sign in"), text: t("Sign in to see all your games"), run: () => openSignIn("steam") };
    const store: Section = {
      id: "store",
      label: "Store",
      modes: [
        ...(home ? [{ id: "featured", label: "Featured", shelves: home.shelves.filter((s) => s.games.length).map((s) => ({ ...s, games: s.games.map(own), pager: shelfPager(s.id) })) }] : []),
        { id: "all", label: "All games", pager: shelfPager("top") },
        ...(home?.genres ?? []).map((g) => ({ id: `tag:${g.tag}`, label: g.name, pager: (start: number) => steamPage("top", g.tag, start) })),
      ],
    };
    return [myGames("mine", mine, signIn), store];
  }, [games, home, connected, own]);

  return <Browse active={active} sections={sections} own={own} />;
}
