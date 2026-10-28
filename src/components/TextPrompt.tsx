import { useEffect, useRef, useState } from "react";
import { Layer, useInput } from "../input";
import { useHints } from "./Hints";
import { useKeyboard } from "./Keyboard";

/** Full-screen text entry with the gamepad keyboard; a physical keyboard works too. */
export function TextPrompt({
  title,
  hint,
  initial,
  onDone,
}: {
  title: string;
  hint: string;
  initial: string;
  onDone: (v: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const kb = useKeyboard({
    onType: (ch) => setText((t) => t + ch),
    onBackspace: () => setText((t) => t.slice(0, -1)),
    onDone: () => onDone(text.trim()),
  });
  // Above any modal that opened it.
  const priority = Layer.modal + 5;
  useInput((a) => {
    if (a === "b") return onDone(null);
    if (a === "menu") return onDone(text.trim());
    const r = kb.handle(a);
    return r === false ? "silent" : r;
  }, priority);
  useHints([["a", "Type"], ["x", "Delete"], ["menu", "Save"], ["b", "Cancel"]], priority);
  return (
    <div className="prompt">
      <div className="prompt-card">
        <div className="eyebrow">{title}</div>
        <input ref={input} className="prompt-input" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <p className="prompt-hint">{hint}</p>
        {kb.view(true)}
      </div>
    </div>
  );
}
