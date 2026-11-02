import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { cancelInstall, gameById, useStore } from "../store";
import { size } from "../util";
import { useHints } from "./Hints";

/** Asks before throwing a download away. Going on is the default: that's what costs nothing. */
export function CancelPrompt() {
  const id = useStore((s) => s.cancelAsk);
  const install = useStore((s) => (s.cancelAsk ? s.installs[s.cancelAsk] : undefined));
  const game = gameById(id);
  const open = !!id && !!install && !!game;
  // 0: cancel the download, 1: keep it.
  const [at, setAt] = useState(1);
  const keep = () => useStore.setState({ cancelAsk: null });
  const discard = () => {
    keep();
    if (game) cancelInstall(game);
  };

  useEffect(() => {
    setAt(1);
    // The download finished or failed while the question was up.
    if (id && !install) keep();
  }, [id, install?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput(
    (a) => {
      switch (a) {
        case "left":
          return at > 0 ? setAt(0) : "edge";
        case "right":
          return at < 1 ? setAt(1) : "edge";
        case "a":
          return at === 0 ? discard() : keep();
        case "b":
          return keep();
        default:
          return "silent";
      }
    },
    Layer.modal + 5,
    open,
  );
  useHints([["a", "Select"], ["b", "Back"]], Layer.modal + 5, open);

  if (!open) return null;
  return (
    <div className="prompt">
      <div className="prompt-card">
        <div className="eyebrow">{game.name}</div>
        <h2 className="pkg-title">{t("Cancel download?")}</h2>
        <p className="prompt-text">{t("About {size} of downloaded data will be discarded.", { size: size(install.downloaded) })}</p>
        <div className="pkg-actions">
          <button className={`btn btn-pill ${at === 0 ? "is-focused" : ""}`} onClick={discard}>{t("Cancel download")}</button>
          <button className={`btn btn-play ${at === 1 ? "is-focused" : ""}`} onClick={keep}>{t("Keep downloading")}</button>
        </div>
      </div>
    </div>
  );
}
