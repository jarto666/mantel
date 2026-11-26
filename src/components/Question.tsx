import { useEffect, useState } from "react";
import { t } from "../i18n";
import { backdrop, Layer, useInput } from "../input";
import { useStore } from "../store";
import { useHints } from "./Hints";

/** Above any page or menu that asked. */
const PRIORITY = Layer.modal + 5;

/**
 * A yes-or-no before something rare that can't be taken back. Leaving things as they are is the
 * default answer, since that's what costs nothing; B and a tap beside the card give it too.
 */
export function Question({
  open,
  eyebrow,
  title,
  text,
  yes,
  no,
  danger,
  onYes,
  onNo,
}: {
  open: boolean;
  eyebrow: string;
  title: string;
  text?: string;
  yes: string;
  no: string;
  /** The yes destroys something, and is red. */
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  // 0: yes, 1: no.
  const [at, setAt] = useState(1);
  useEffect(() => {
    if (open) setAt(1);
  }, [open, title]);

  useInput(
    (a) => {
      switch (a) {
        case "left":
          return at > 0 ? setAt(0) : "edge";
        case "right":
          return at < 1 ? setAt(1) : "edge";
        case "a":
          return at === 0 ? onYes() : onNo();
        case "b":
          return onNo();
        default:
          return "silent";
      }
    },
    PRIORITY,
    open,
  );
  useHints([["a", "Select"], ["b", "Back"]], PRIORITY, open);

  if (!open) return null;
  return (
    <div className="prompt" {...backdrop}>
      <div className="prompt-card">
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="pkg-title">{title}</h2>
        {text && <p className="prompt-text">{text}</p>}
        <div className="pkg-actions">
          <button className={`btn btn-pill ${danger ? "is-danger" : ""} ${at === 0 ? "is-focused" : ""}`} onClick={onYes}>{yes}</button>
          <button className={`btn btn-play ${at === 1 ? "is-focused" : ""}`} onClick={onNo}>{no}</button>
        </div>
      </div>
    </div>
  );
}

/** Asks what `askFirst` was given. */
export function AskFirst() {
  const ask = useStore((s) => s.question);
  const dismiss = () => useStore.setState({ question: null });
  return (
    <Question
      open={!!ask}
      eyebrow={ask?.eyebrow ?? ""}
      title={ask?.title ?? ""}
      text={ask?.text}
      yes={ask?.yes ?? ""}
      no={t("Cancel")}
      danger={ask?.danger}
      onYes={() => {
        dismiss();
        ask?.run();
      }}
      onNo={dismiss}
    />
  );
}
