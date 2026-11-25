import { useEffect } from "react";
import { t } from "../i18n";
import { cancelInstall, gameById, useStore } from "../store";
import { size } from "../util";
import { Question } from "./Question";

/** Asks before throwing a download away. */
export function CancelPrompt() {
  const id = useStore((s) => s.cancelAsk);
  const install = useStore((s) => (s.cancelAsk ? s.installs[s.cancelAsk] : undefined));
  const game = gameById(id);
  const keep = () => useStore.setState({ cancelAsk: null });

  // The download finished or failed while the question was up.
  useEffect(() => {
    if (id && !install) keep();
  }, [id, install?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Question
      open={!!id && !!install && !!game}
      eyebrow={game?.name ?? ""}
      title={t("Cancel download?")}
      text={install && t("About {size} of downloaded data will be discarded.", { size: size(install.downloaded) })}
      yes={t("Cancel download")}
      no={t("Keep downloading")}
      danger
      onYes={() => {
        keep();
        if (game) cancelInstall(game);
      }}
      onNo={keep}
    />
  );
}
