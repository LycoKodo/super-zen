<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->
<!-- TODO: Get a job -->
> [!NOTE]
> **Super Zen** is a fork of Zen with two things from Arc (branch `super-zen`):
>
> - **Little windows** (Arc's "Little Arc"): <kbd>⌘</kbd><kbd>⌥</kbd><kbd>N</kbd> or File › New Little Window opens a small window for a quick look at a page. Its toolbar shows the space the page is headed to, and **Open in _Space_** (<kbd>⌘</kbd><kbd>O</kbd>) moves it into that space. Links from other apps open in one too (`zen.little-window.open-external-links`).
>   On macOS the shortcut works from any app while Super Zen is running: the window floats over the app in use, even a fullscreen one, and closing it goes back to that app (`zen.little-window.global-shortcut`). Arc takes the same shortcut while it runs.
> - **Arc import**: `tools/arc-import/import_arc.py` brings over every Arc profile as its own container, with history, passwords, payment cards, cookies (so you stay signed in), spaces, pinned tabs and favorites.
>
> Sync is plain Firefox Sync, so sign in with your Mozilla account as in Zen. Build: `npm run init`, `npx surfer set brand superzen`, `npm run build`, then `cd engine && ./mach package`.

<img src="./docs/assets/zen-dark.svg" width="100px" align="left">

### `Zen Browser`

[![Downloads](https://img.shields.io/github/downloads/zen-browser/desktop/total.svg)](https://github.com/zen-browser/desktop/releases)
[![Crowdin](https://badges.crowdin.net/zen-browser/localized.svg)](https://crowdin.com/project/zen-browser)
[![Zen Release builds](https://github.com/zen-browser/desktop/actions/workflows/build.yml/badge.svg?branch=stable)](https://github.com/zen-browser/desktop/actions/workflows/build.yml)

Zen is a firefox-based browser with the aim of pushing your productivity to a new level!

<div flex="true">
  <a href="https://zen-browser.app/download">
    Download
  </a>
  •
  <a href="https://zen-browser.app">
    Website
  </a>
  •
  <a href="https://docs.zen-browser.app">
    Documentation
  </a>
  •
  <a href="https://zen-browser.app/release-notes/latest">
    Release Notes
  </a>
</div>

### Firefox Versions

- [`Release`](https://zen-browser.app/download) - Is currently built using Firefox version `158.0`!
- [`Twilight`](https://zen-browser.app/download?twilight) - Is currently built using Firefox version `RC 158.0`!

### Contributing

If you'd like to report a bug, please do so on our [GitHub Issues page](https://github.com/zen-browser/desktop/issues/) and for feature requests, you can use [GitHub Discussions](https://github.com/zen-browser/desktop/discussions).

Zen is an open-source project, and we welcome contributions from the community! Please take a look at the [contribution guidelines](./docs/contribute.md) before getting started!

#### Partners

Thanks to all the partners of Zen for their support and contributions:

<a href="https://blacksmith.sh">
  <img src="./docs/assets/blacksmith-yellow.png" width="350px"/>
</a>
