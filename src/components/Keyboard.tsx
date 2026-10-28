import { useState } from "react";
import { sound } from "../sound";
import type { Result } from "../input";

const ROWS = [
  "1234567890".split(""),
  "qwertyuiop".split(""),
  "asdfghjkl:".split(""),
  "zxcvbnm-'.".split(""),
];
const SPECIAL = ["space", "back", "done"] as const;
type Special = (typeof SPECIAL)[number];

/**
 * Gamepad on-screen keyboard. The parent owns the text and routes input through
 * `handle`, so this works inside any input layer.
 */
export function useKeyboard(opts: {
  onType: (ch: string) => void;
  onBackspace: () => void;
  onDone: () => void;
  /** Called when moving up past the first row; return true if focus left the keyboard. */
  onExitUp?: () => boolean;
}) {
  const [row, setRow] = useState(1);
  const [col, setCol] = useState(0);
  const [upper, setUpper] = useState(false);

  const press = (key: string | Special) => {
    if (key === "space") opts.onType(" ");
    else if (key === "back") opts.onBackspace();
    else if (key === "done") opts.onDone();
    else opts.onType(upper ? key.toUpperCase() : key);
  };

  const rowLen = (r: number) => (r === ROWS.length ? SPECIAL.length : 10);
  // The bottom row has 3 wide keys spanning the 10 columns.
  const toSpecialCol = (c: number) => (c < 4 ? 0 : c < 7 ? 1 : 2);
  const fromSpecialCol = (c: number) => [1, 5, 8][c];

  const handle = (a: string): Result => {
    switch (a) {
      case "left":
        if (col === 0) return "edge";
        setCol(col - 1);
        return;
      case "right":
        if (col >= rowLen(row) - 1) return "edge";
        setCol(col + 1);
        return;
      case "up":
        if (row === 0) return opts.onExitUp?.() ? undefined : "edge";
        if (row === ROWS.length) setCol(fromSpecialCol(col));
        setRow(row - 1);
        return;
      case "down":
        if (row === ROWS.length) return "edge";
        if (row === ROWS.length - 1) setCol(toSpecialCol(col));
        setRow(row + 1);
        return;
      case "a":
        press(row === ROWS.length ? SPECIAL[col] : ROWS[row][col]);
        return "silent";
      case "x":
        opts.onBackspace();
        sound.back();
        return "silent";
      case "y":
        opts.onType(" ");
        sound.move();
        return "silent";
      case "lt":
        setUpper((u) => !u);
        return;
      default:
        return false;
    }
  };

  const view = (active: boolean) => (
    <div className={`osk ${active ? "is-active" : ""}`}>
      {ROWS.map((keys, r) => (
        <div className="osk-row" key={r}>
          {keys.map((k, c) => (
            <button
              key={k}
              className={`osk-key ${active && row === r && col === c ? "is-focused" : ""}`}
              onClick={() => {
                setRow(r);
                setCol(c);
                press(k);
              }}
            >
              {upper ? k.toUpperCase() : k}
            </button>
          ))}
        </div>
      ))}
      <div className="osk-row">
        {SPECIAL.map((k, c) => (
          <button
            key={k}
            className={`osk-key wide ${k} ${active && row === ROWS.length && col === c ? "is-focused" : ""}`}
            onClick={() => {
              setRow(ROWS.length);
              setCol(c);
              press(k);
            }}
          >
            {k === "space" ? "Space" : k === "back" ? "Delete" : "Done"}
          </button>
        ))}
      </div>
    </div>
  );

  return { handle, view, press };
}
