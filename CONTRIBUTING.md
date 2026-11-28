# Contributing to Mantel

Thanks for helping.

## Bugs and ideas

- **Bugs** go to [Issues](https://github.com/jarto666/mantel/issues/new/choose). The form
  asks for what helps most: the Mantel version, your handheld, how Mantel runs and the log
  (`%APPDATA%\com.playmantel.launcher\mantel.log`).
- **Ideas** go to [Discussions → Ideas](https://github.com/jarto666/mantel/discussions/categories/ideas),
  one idea per post. Upvote the ones you want. Ideas are looked at before each release, most
  wanted first, and the ones picked become issues.
- **Questions** go to [Discussions → Q&A](https://github.com/jarto666/mantel/discussions/categories/q-a).

Mantel aims to be a good console-style home on a handheld out of the box: good defaults
rather than an option for everything. Ideas that make playing with a controller better come
first. Ones that add settings for the look are weighed against keeping Mantel simple.

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
