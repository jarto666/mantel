# Mantel: development playbook

For anyone changing this repo, people and coding agents alike. Mantel is a free, GPL-3.0, console-style game launcher for Windows handhelds, built with Tauri 2, Rust, React and plain CSS. The main target is the ROG Xbox Ally X; development happens on a Mac. See [CONTRIBUTING.md](CONTRIBUTING.md) for outside contributions.

- `src/`: the UI. `store.ts` holds state, `views/` the screens, `locales/` the translations, `mock.ts` the sample data for `npm run dev`.
- `src-tauri/src/`: the backend. `library/` scans stores, `accounts.rs` handles sign-in, `install.rs` and `steam_install.rs` install, `xbox_store.rs` and `steam_store.rs` browse.
- `site/`: playmantel.com, on Vercel, deployed from `main`.
- `tools/ally.sh`: the dev loop against the device.

## What every change includes

Nobody should have to ask for these.

- **Translations.** Every new UI string is English source through `t()`, and goes into `src/locales/{fr,de,es,ru}.ts` in the same change. Fixed backend errors show through `errorText`, so they are translated too. Keep each language's existing tone and typography.
- **A controller path.** Every screen works with a controller alone: focus visible, hints correct, B goes back. Focus rings and shadows must not be clipped by a scroll box or a mask.
- **The same behaviour in every store.** Xbox and Steam offer the same sections and actions: My games, Store, filters, search, install, and telling what you own. Where a store can't do something, the page says what to do instead, and the release notes mention it.
- **Tests** for logic that can be tested, next to the code, the way the existing Rust tests are.
- **Docs when users would notice.** README, `site/index.html`, `site/llms.txt` and `site/llms-full.txt`. A new outside host also goes in `site/privacy.html`.

## Checks

```bash
npm run build
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Some Rust tests compile only on Windows, so CI (`.github/workflows/check.yml`) is the one that runs them.

Report what was verified and how: in the browser on sample data, on the device, or only in CI. A step not tried stays listed as not tried. What the UI does on a real device can't be assumed from the browser, because WebView2 and real store data differ.

## Dev loop

`npm run dev` runs the UI in a browser on sample data, which is enough for most UI work.

On the device, over the SSH alias `ally`:

| Command | What it does |
|---|---|
| `tools/ally.sh build-dev` | Windows build that loads the UI from the Mac, with DevTools on the Ally's port 9222 |
| `tools/ally.sh build` | Release build with the UI baked in |
| `tools/ally.sh deploy [dev]` | Copies the build to `C:\Mantel` and restarts it on the Ally's screen |
| `tools/ally.sh tunnel` | Forwards port 9222 to the Mac |
| `tools/ally.sh logs` | Follows `mantel.log` |
| `tools/ally.sh build-dev update-test [quiet]` | Dev build that calls itself 0.0.1, so it's offered the latest release and installs it as players do; `quiet` runs the installer without its window. Run the UI with `VITE_UPDATE_TEST=1`. Installing replaces the Ally's Mantel with that release |

Known traps:

- Editing `src/store.ts` with a dev build open leaves an empty UI until the page reloads.
- The content policy in `tauri.conf.json` applies only to release builds. Anything the page fetches or shows from a new host works in a dev build and fails in a release, so add the host there and test it in a release build.
- After a version bump, a local build keeps the old version until the build script reruns: `touch src-tauri/tauri.conf.json src-tauri/build.rs src-tauri/src/lib.rs`.
- Reduced motion gives every property a tiny transition, so reading a size right after setting it returns the old value. An element measured that way needs `transition-property: none`.
- In zsh, quote globs such as `'*.ts'`. A failed key-press command once launched a game on the device, so check the UI's state before sending input.

## Performance

Mantel runs on a handheld next to games, and frame drops show.

- No `backdrop-filter` on anything repeated per cover.
- No transitions on custom properties on `:root`: they restyle the whole document every frame.
- Hidden tabs use `content-visibility: hidden`. Covers are memoized with stable handlers.
- Compare frame traces before and after a change to anything shown on every tab.

## Working on the device

- Check that no game is running before restarting Mantel.
- Passwords, sign-ins, licences, purchases and system settings belong to the device's owner. Ask them to do it; never type credentials.
- Move data aside rather than deleting it.
- Never put a real library, account name or token in a screenshot, log, commit or issue. Public screenshots come from sample data.
- Look at every public screenshot before it ships: all covers loaded, no placeholder cards, no demo text. New site images get a new `?v=` too, as `/assets` is cached for a week.

## Outside services

- Requests say they are Mantel. Never imitate a browser or another app to get past a check.
- Use public or documented endpoints, and not partner-only ones such as the Store's `publisherQuery`.
- A service that fails must leave the app working: fall back, and cache answers so that one screen doesn't send a flood of requests.
- The Store's `IsInUserCollection` is asked one product at a time; batched answers aren't reliable. A bundle has no packages of its own, so its ownership and install go through the game inside it.

## Estimates and plans

Read the code before estimating. Separate what exists from what is new, and don't list finished work as remaining. Say what changes for the player, in plain words, before any internal names. The maintainer reads Russian.

## Git

- Commit and push only when asked. Branch first if on `main`.
- Commits use the repo's configured identity, `jarto666@gmail.com`.
- Never print or commit the updater key or any token.

## Release

1. Bump `version` in `package.json`, and the lock file with it. Tauri reads it from there.
2. Push a tag `v*`. `.github/workflows/release.yml` builds a **draft** release.
3. Check the draft: asset names and `latest.json` must show the new version.
4. Write the notes as what players get, under New, Better, Fixed and Good to know, and put them on the draft.
5. Publishing the draft is what updates installed copies. Do it only with the maintainer's go-ahead.
6. Merge the release PR with a merge commit, not a squash, so the tag stays on `main`. That also deploys the site, so do it together with publishing.
