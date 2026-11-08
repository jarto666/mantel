import { useMemo } from "react";
import { t } from "../i18n";
import { steamPage, useStore } from "../store";
import type { Game } from "../types";
import { Browse, type Mode, type Shelf } from "./Browse";

/** Which paged list a store shelf opens into has the shelf's own id. */
const shelfPager = (list: string): Shelf["pager"] => (start) => steamPage(list, null, start);

/** The Steam store; the player's Steam games are in the library. Buying happens on Steam's own page. */
export function Steam({ active }: { active: boolean }) {
  const games = useStore((s) => s.games);
  const home = useStore((s) => s.steamStore);

  const own = useMemo(() => {
    const byId = new Map(games.map((g) => [g.id, g]));
    return (g: Game) => byId.get(g.id) ?? g;
  }, [games]);

  const modes = useMemo<Mode[]>(
    () => [
      ...(home ? [{ id: "featured", label: "Featured", shelves: home.shelves.filter((s) => s.games.length).map((s) => ({ ...s, games: s.games.map(own), pager: shelfPager(s.id) })) }] : []),
      { id: "all", label: "All games", pager: shelfPager("top") },
      ...(home?.genres ?? []).map((g) => ({ id: `tag:${g.tag}`, label: g.name, pager: (start: number) => steamPage("top", g.tag, start) })),
    ],
    [home, own],
  );

  return <Browse active={active} label={t("Store")} modes={modes} own={own} />;
}
