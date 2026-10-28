# Contributing to Mantel

Thanks for helping. Bug reports with your handheld model, the store involved and the
log (`%APPDATA%\com.playmantel.launcher\mantel.log`) are the most useful thing you can
send.

## Pull requests

- `npm run dev` runs the UI in a browser with a sample library; most UI work needs nothing
  else. Changes that touch game scanning or launching need a Windows machine to test.
- Keep every screen usable with a controller alone.
- Before opening a PR: `npm run build` and `cargo test --manifest-path src-tauri/Cargo.toml`.

## License of contributions

Mantel is licensed under GPL-3.0-or-later. By submitting a contribution you agree that it
is licensed under the same terms, and you also grant the maintainer permission to
distribute your contribution under other licenses as part of Mantel. This keeps options
such as a differently licensed build open without having to track down every
contributor.
