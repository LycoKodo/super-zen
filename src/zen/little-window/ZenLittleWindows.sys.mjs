// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  UrlbarProvider: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

const GLOBAL_SHORTCUT_PREF = "zen.little-window.global-shortcut";
const PRELOAD_PREF = "zen.little-window.preload";
const SEARCH_FIRST_PREF = "zen.little-window.search-first";
const POSITION_PREF = "zen.little-window.position";
const SEARCH_BAR_POSITION_PREF = "zen.little-window.search-bar-position";

/**
 * What little windows share across windows: opening them, where they open,
 * and on macOS, the shortcut that opens one from any app, like Little Arc.
 * The windows themselves are run by ZenLittleWindow.mjs.
 */
class nsZenLittleWindows {
  #globalShortcut = null;
  // The app that was in use when a window was opened from it, by window, to
  // go back to once it closes.
  #previousApps = new WeakMap();
  // Windows that are up but not shown yet, see #showSmoothly.
  #unrevealed = new WeakSet();
  // Windows sliding into place, which aren't where they will stay yet.
  #sliding = new WeakSet();
  // Where windows were put, by window, to tell whether they were moved
  // since (see saveBounds).
  #placed = new WeakMap();
  // Windows still showing as the search bar they start as, see open, by
  // where they were put.
  #searchBars = new WeakMap();
  // The view AppKit sends keys to, by window, from before AppKit loses
  // track of it (see #showSmoothly).
  #views = new WeakMap();
  // A little window kept ready and out of sight, so the next one shows at
  // once instead of starting up first (see #makeSpare).
  #spare = null;
  #spareReady = false;
  // The Space the window kept ready was put up on, see #takeSpare.
  #spareSpace = null;
  #spareTimer = null;
  #hotKey = null;

  constructor() {
    Services.prefs.addObserver(GLOBAL_SHORTCUT_PREF, () =>
      this.#updateGlobalShortcut()
    );
    Services.prefs.addObserver("zen.little-window.enabled", () => {
      this.#updateGlobalShortcut();
      this.#updateSpare();
    });
    Services.prefs.addObserver(PRELOAD_PREF, () => this.#updateSpare());
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "domwindowclosed");
  }

  observe(aSubject, aTopic) {
    switch (aTopic) {
      case "browser-delayed-startup-finished":
        if (
          !aSubject.document.documentElement.hasAttribute("zen-little-window")
        ) {
          this.#scheduleSpare(SPARE_AFTER_STARTUP_MS);
        }
        break;
      case "domwindowclosed":
        if (aSubject === this.#spare) {
          this.#spare = null;
          this.#spareReady = false;
        }
        // Once the window is gone from the list of windows.
        Services.tm.dispatchToMainThread(() => this.#updateSpare());
        break;
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref("zen.little-window.enabled", true);
  }

  /**
   * Opens a little window. Opened without a page on macOS, it asks where to
   * go first in a small search bar, as Little Arc does, and becomes the
   * window itself once a page is picked (see expandSearchBar).
   *
   * @param {object} [options]
   * @param {Window} [options.opener] - The window it is opened from.
   * @param {string} [options.url] - See nsZenLittleWindow.open.
   * @param {object} [options.space] - The space "Open in" sends the page to.
   *   Without one, the window picks the first.
   * @param {nsIPrincipal} [options.triggeringPrincipal]
   * @returns {Window}
   */
  open({
    opener = null,
    url = null,
    space = null,
    triggeringPrincipal = null,
  } = {}) {
    const searchFirst =
      IS_MAC && !url && Services.prefs.getBoolPref(SEARCH_FIRST_PREF, true);
    // The shortcut puts away a search bar that is up, as with Spotlight.
    const searchBar = searchFirst && this.#openSearchBar;
    if (searchBar) {
      searchBar.close();
      return searchBar;
    }
    const previousApp =
      IS_MAC && !Cocoa.isAppActive() ? Cocoa.frontmostApp() : null;
    const screen = opener?.screen ?? this.#primaryScreen();
    const bounds = searchFirst
      ? this.#searchBarBounds(screen)
      : this.#initialBounds(screen);
    if (searchFirst) {
      this.#addSitesProvider();
    }
    let win = this.#takeSpare();
    const fromSpare = !!win;
    if (fromSpare) {
      // Before it asks where to go, which the sites provider tells by.
      if (searchFirst) {
        this.#searchBars.set(win, bounds);
      }
      this.#place(win, bounds);
      win.gZenLittleWindow.takeOver({
        url,
        spaceId: space?.uuid ?? null,
        triggeringPrincipal,
        searchFirst,
      });
    } else {
      win = this.#create({ opener, space, bounds });
      win._zenLittleWindow = {
        spaceId: space?.uuid ?? null,
        url,
        triggeringPrincipal,
        searchFirst,
      };
      if (searchFirst) {
        this.#searchBars.set(win, bounds);
      }
    }
    if (IS_MAC) {
      if (previousApp) {
        this.#previousApps.set(win, previousApp);
      }
      this.#showSmoothly(win, {
        activate: !!previousApp,
        fromSpare,
        searchFirst,
      });
      this.#scheduleSpare(SPARE_AFTER_USE_MS);
    }
    return win;
  }

  get #openSearchBar() {
    return (
      [...Services.wm.getEnumerator("navigator:browser")].find(
        win => !win.closed && this.#searchBars.has(win)
      ) ?? null
    );
  }

  /**
   * Suggests the sites visited most in a search bar before anything is
   * typed, as Little Arc does. Firefox's top sites would, but Zen turns them
   * off, and the address bar suggests nothing there otherwise.
   */
  #addSitesProvider() {
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    if (manager.getProvider(SITES_PROVIDER_NAME)) {
      return;
    }
    // A search bar goes away as soon as another window is picked, so the
    // address bar asking is its own.
    const isAsking = () => !!this.#openSearchBar;
    const { UrlbarResult, UrlbarShared } = lazy;
    class SitesProvider extends lazy.UrlbarProvider {
      get name() {
        return SITES_PROVIDER_NAME;
      }

      get type() {
        return UrlbarShared.PROVIDER_TYPE.PROFILE;
      }

      async isActive(queryContext) {
        return (
          !queryContext.searchString &&
          !queryContext.isPrivate &&
          !queryContext.searchMode &&
          isAsking()
        );
      }

      // That of Firefox's top sites, which would hold the others back.
      getPriority() {
        return 1;
      }

      async startQuery(queryContext, addCallback) {
        const sites = await lazy.NewTabUtils.activityStreamLinks.getTopSites({
          numItems: SEARCH_BAR_SITES,
        });
        for (const site of sites) {
          addCallback(
            this,
            new UrlbarResult({
              type: UrlbarShared.RESULT_TYPE.URL,
              source: UrlbarShared.RESULT_SOURCE.HISTORY,
              payload: {
                url: site.url,
                title: site.title || "",
                icon: site.favicon || UrlbarShared.getIconForUrl(site.url),
              },
            })
          );
        }
      }
    }
    manager.registerProvider(new SitesProvider());
  }

  /**
   * @param {object} options
   * @param {Window} [options.opener]
   * @param {object} [options.space] - Its container is the one the window
   *   starts in. Without one, the opener's.
   * @param {object} options.bounds - Where it opens, see #initialBounds.
   * @returns {Window}
   */
  #create({ opener = null, space = null, bounds }) {
    const { left, top, width, height } = bounds;
    // The page is loaded once the window is up: a single URL argument would
    // be split on "|" and loaded as several pages.
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString
    );
    args.data = "about:blank";
    const win = lazy.BrowserWindowTracker.openWindow({
      openerWindow: opener ?? undefined,
      args,
      features: `width=${width},height=${height},left=${left},top=${top}`,
      zenSyncedWindow: false,
    });
    this.#placed.set(win, { left, top });
    // Whatever "zen.window-sync.prefer-unsynced-windows" says, a little
    // window is never synced.
    win._zenStartupSyncFlag = "unsynced";
    if (space || !opener) {
      win._zenStartupUnsyncedUserContextId =
        typeof space?.containerTabId === "number" ? space.containerTabId : 0;
    }
    return win;
  }

  /**
   * Moves a window to where a new little window would open.
   *
   * @param {Window} aWindow
   * @param {object} aBounds - See #initialBounds.
   */
  #place(aWindow, { left, top, width, height }) {
    this.#placed.set(aWindow, { left, top });
    if (aWindow.innerWidth !== width || aWindow.innerHeight !== height) {
      aWindow.resizeBy(
        width - aWindow.innerWidth,
        height - aWindow.innerHeight
      );
    }
    if (aWindow.screenX !== left || aWindow.screenY !== top) {
      aWindow.moveTo(left, top);
    }
  }

  // Section: the window kept ready

  get #wantsSpare() {
    return (
      IS_MAC &&
      this.enabled &&
      Services.prefs.getBoolPref(PRELOAD_PREF, true) &&
      this.#regularWindows.length > 0
    );
  }

  get #regularWindows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(
      win =>
        !win.closed &&
        !win.document.documentElement.hasAttribute("zen-little-window")
    );
  }

  #scheduleSpare(aDelay) {
    if (this.#spare || this.#spareTimer || !this.#wantsSpare) {
      return;
    }
    // Starting a window keeps Zen busy for a moment: do it when idle, well
    // after anything that needs to be smooth.
    this.#spareTimer = lazy.setTimeout(() => {
      ChromeUtils.idleDispatch(
        () => {
          this.#spareTimer = null;
          this.#makeSpare();
        },
        { timeout: 10000 }
      );
    }, aDelay);
  }

  #updateSpare() {
    if (this.#wantsSpare) {
      this.#scheduleSpare(SPARE_AFTER_USE_MS);
    } else if (this.#spare) {
      // A window kept ready mustn't be the only one left: clicking Zen in the
      // Dock would find a window and open none.
      this.#spare.close();
      this.#spare = null;
    }
  }

  /**
   * Opens a little window that is never shown: it is put up unseen at the
   * back, so Zen doesn't show it itself, and put away once started (see
   * spareReady). Opened last, it would otherwise be the window links open
   * in; BrowserWindowTracker keeps it last until it is used.
   */
  #makeSpare() {
    if (this.#spare || !this.#wantsSpare) {
      return;
    }
    if (Services.prefs.getBoolPref(SEARCH_FIRST_PREF, true)) {
      this.#addSitesProvider();
      // The first look in history takes a while, which the first search bar
      // would wait for.
      lazy.NewTabUtils.activityStreamLinks
        .getTopSites({ numItems: SEARCH_BAR_SITES })
        .catch(console.error);
    }
    const opener = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    const win = this.#create({
      opener,
      bounds: this.#initialBounds(opener?.screen ?? this.#primaryScreen()),
    });
    win._zenLittleWindow = { spare: true };
    this.#spare = win;
    this.#spareReady = false;
    try {
      const nativeWindow = Cocoa.nativeWindow(win);
      this.#views.set(win, Cocoa.call(nativeWindow, "firstResponder"));
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 0);
      Cocoa.call(
        nativeWindow,
        "setIgnoresMouseEvents:",
        Cocoa.objc.sendWithBool,
        1
      );
      Cocoa.call(
        nativeWindow,
        "setExcludedFromWindowsMenu:",
        Cocoa.objc.sendWithBool,
        1
      );
      // Should anything show it, it is still left out of Accel+` and
      // Mission Control. It is put up on the Space in use, which it then
      // stays on, even a fullscreen app's (see #showSmoothly).
      Cocoa.updateCollectionBehavior(nativeWindow, {
        add:
          NS_IGNORES_CYCLE |
          NS_TRANSIENT |
          NS_FULLSCREEN_AUXILIARY |
          NS_FULLSCREEN_DISALLOWS_TILING,
        remove: NS_FULLSCREEN_PRIMARY | NS_FULLSCREEN_ALLOWS_TILING,
      });
      Cocoa.setNonActivating(nativeWindow, true);
      this.#spareSpace = Cocoa.activeSpace();
      Cocoa.call(nativeWindow, "orderBack:", Cocoa.objc.sendWithId, null);
    } catch (ex) {
      console.error("Little windows: could not keep one ready", ex);
      this.#spare = null;
      win.close();
    }
  }

  /**
   * Called by the window kept ready once it has started.
   *
   * @param {Window} aWindow
   */
  spareReady(aWindow) {
    if (aWindow !== this.#spare) {
      return;
    }
    const putAway = () => {
      if (aWindow === this.#spare && !aWindow.closed) {
        Cocoa.call(
          Cocoa.nativeWindow(aWindow),
          "orderOut:",
          Cocoa.objc.sendWithId,
          null
        );
      }
    };
    putAway();
    // Windows starting alongside, as the session is restored, can show it
    // again.
    for (const delay of SPARE_PUT_AWAY_AGAIN_MS) {
      lazy.setTimeout(putAway, delay);
    }
    this.#spareReady = true;
  }

  #takeSpare() {
    const spare = this.#spare;
    if (!spare || !this.#spareReady || spare.closed) {
      return null;
    }
    this.#spare = null;
    this.#spareReady = false;
    // macOS would switch to the Space it was put up on to show it. A new
    // window opens on the Space in use, and the next one is kept ready there.
    // AppKit only tells whether a window is on the Space in use while it is
    // shown, which this one isn't.
    let sameSpace = false;
    try {
      sameSpace = this.#spareSpace === Cocoa.activeSpace();
    } catch (ex) {
      console.error("Little windows: could not tell the Space in use", ex);
    }
    if (!sameSpace) {
      spare.close();
      return null;
    }
    return spare;
  }

  /**
   * Where a new little window opens: where the last one was left, as long as
   * that is still on a screen, or else centered on the given screen.
   *
   * @param {{availLeft: number, availTop: number, availWidth: number, availHeight: number}} aScreen
   * @returns {{left: number, top: number, width: number, height: number}}
   */
  #initialBounds(aScreen) {
    let width = Services.prefs.getIntPref("zen.little-window.width", 960);
    let height = Services.prefs.getIntPref("zen.little-window.height", 680);
    const place = this.#savedPlace(POSITION_PREF);
    if (place) {
      const { left, top } = place;
      const { availLeft, availTop, availWidth, availHeight } = this.#screenAt(
        left,
        top,
        width,
        height
      );
      width = Math.min(width, availWidth);
      height = Math.min(height, availHeight);
      // Screens may have been rearranged since: keep the window on one.
      return {
        left: clamp(left, availLeft, availWidth, width),
        top: clamp(top, availTop, availHeight, height),
        width,
        height,
      };
    }
    const { availLeft, availTop, availWidth, availHeight } = aScreen;
    width = Math.min(width, availWidth);
    height = Math.min(height, availHeight);
    return {
      left: Math.round(availLeft + (availWidth - width) / 2),
      top: Math.round(availTop + (availHeight - height) / 2),
      width,
      height,
    };
  }

  /**
   * Where the search bar a little window starts as opens: where it was last
   * moved to, or else along the top of where the little window will, and
   * centered across it, as Little Arc's does. It grows down with its
   * results.
   *
   * @param {{availLeft: number, availTop: number, availWidth: number, availHeight: number}} aScreen
   * @returns {{left: number, top: number, width: number, height: number}}
   */
  #searchBarBounds(aScreen) {
    const windowBounds = this.#initialBounds(aScreen);
    const width = Math.min(SEARCH_BAR_WIDTH, windowBounds.width);
    const { left, top } = this.#savedPlace(SEARCH_BAR_POSITION_PREF) ?? {
      left: windowBounds.left + Math.round((windowBounds.width - width) / 2),
      top: windowBounds.top,
    };
    const { availLeft, availTop, availWidth, availHeight } = this.#screenAt(
      left,
      top,
      width,
      SEARCH_BAR_MAX_HEIGHT
    );
    return {
      left: clamp(left, availLeft, availWidth, width),
      // With room below for its results.
      top: clamp(top, availTop, availHeight, SEARCH_BAR_MAX_HEIGHT),
      width,
      height: SEARCH_BAR_HEIGHT,
    };
  }

  /**
   * @param {string} aPref - Where a little window or its search bar was
   *   last left, as "left,top".
   * @returns {{left: number, top: number}|null}
   */
  #savedPlace(aPref) {
    const [left, top] = Services.prefs
      .getStringPref(aPref, "")
      .split(",")
      .map(value => parseInt(value, 10));
    return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
  }

  #screenAt(aLeft, aTop, aWidth, aHeight) {
    return this.#availRect(
      Cc["@mozilla.org/gfx/screenmanager;1"]
        .getService(Ci.nsIScreenManager)
        .screenForRect(aLeft, aTop, aWidth, aHeight)
    );
  }

  #primaryScreen() {
    return this.#availRect(
      Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager)
        .primaryScreen
    );
  }

  #availRect(aScreen) {
    const left = {},
      top = {},
      width = {},
      height = {};
    aScreen.GetAvailRectDisplayPix(left, top, width, height);
    return {
      availLeft: left.value,
      availTop: top.value,
      availWidth: width.value,
      availHeight: height.value,
    };
  }

  /**
   * Remembers a little window's size and place for the next one, like Arc
   * does.
   *
   * @param {Window} aWindow
   */
  saveBounds(aWindow) {
    // Never shown.
    if (aWindow === this.#spare) {
      return;
    }
    if (this.#searchBars.has(aWindow)) {
      this.#saveSearchBarPlace(aWindow);
      return;
    }
    if (
      aWindow.windowState !== aWindow.STATE_NORMAL ||
      this.#sliding.has(aWindow)
    ) {
      return;
    }
    // The width and height a window is opened with are its inner size.
    Services.prefs.setIntPref("zen.little-window.width", aWindow.innerWidth);
    Services.prefs.setIntPref("zen.little-window.height", aWindow.innerHeight);
    // Its place only once moved, not one it was put in to fit on a screen.
    const placed = this.#placed.get(aWindow);
    if (aWindow.screenX !== placed?.left || aWindow.screenY !== placed?.top) {
      Services.prefs.setStringPref(
        POSITION_PREF,
        `${aWindow.screenX},${aWindow.screenY}`
      );
    }
  }

  // A search bar opens where it was last moved to.
  #saveSearchBarPlace(aWindow) {
    const { left, top } = this.#searchBars.get(aWindow);
    if (aWindow.screenX !== left || aWindow.screenY !== top) {
      Services.prefs.setStringPref(
        SEARCH_BAR_POSITION_PREF,
        `${aWindow.screenX},${aWindow.screenY}`
      );
    }
  }

  // Section: opening from any app

  /**
   * Makes the shortcut for little windows work from any app, as Little Arc's
   * does. Only on macOS, and only for shortcuts with Command or Control, so
   * typing in other apps is never taken over.
   *
   * @param {object|null} aShortcut - The shortcut, as KeyShortcut.toJSONForm
   *   gives it, or null for none.
   */
  setGlobalShortcut(aShortcut) {
    if (AppConstants.platform !== "macosx") {
      return;
    }
    this.#globalShortcut = null;
    const key = ((!aShortcut?.disabled && aShortcut?.key) || "").toLowerCase();
    const keyCode = key.length === 1 ? MAC_KEY_CODES.indexOf(key) : -1;
    if (keyCode !== -1) {
      const { accel, meta, control, alt, shift } = aShortcut.modifiers ?? {};
      const modifiers =
        (accel || meta ? CARBON_CMD_KEY : 0) |
        (control ? CARBON_CONTROL_KEY : 0) |
        (alt ? CARBON_OPTION_KEY : 0) |
        (shift ? CARBON_SHIFT_KEY : 0);
      if (modifiers & (CARBON_CMD_KEY | CARBON_CONTROL_KEY)) {
        this.#globalShortcut = { keyCode, modifiers };
      }
    }
    this.#updateGlobalShortcut();
  }

  #updateGlobalShortcut() {
    const wanted =
      this.enabled && Services.prefs.getBoolPref(GLOBAL_SHORTCUT_PREF, true)
        ? this.#globalShortcut
        : null;
    if (
      this.#hotKey?.keyCode === wanted?.keyCode &&
      this.#hotKey?.modifiers === wanted?.modifiers
    ) {
      return;
    }
    try {
      this.#hotKey?.unregister();
      this.#hotKey = null;
      if (wanted) {
        this.#hotKey = new MacHotKey(wanted.keyCode, wanted.modifiers, () =>
          this.#onGlobalShortcut()
        );
      }
    } catch (ex) {
      console.error("Little windows: could not set up the global shortcut", ex);
    }
  }

  #onGlobalShortcut() {
    const opener = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (opener?.gZenLittleWindow) {
      opener.gZenLittleWindow.open();
    } else {
      this.open();
    }
  }

  // AppKit only makes a window key in the active app, which Zen becomes a
  // moment after asking.
  #makeKeyOnceActive(aWindow, aNativeWindow, aView, aStart) {
    if (aWindow.closed) {
      return;
    }
    if (Date.now() - aStart > 1000) {
      Cocoa.setNonActivating(aNativeWindow, false);
      this.#watchSearchBar(aWindow, aNativeWindow);
      return;
    }
    if (Cocoa.isAppActive()) {
      Cocoa.call(
        aNativeWindow,
        "makeKeyAndOrderFront:",
        Cocoa.objc.sendWithId,
        null
      );
    }
    if (Cocoa.call(aNativeWindow, "isKeyWindow", Cocoa.objc.sendBool)) {
      Cocoa.setNonActivating(aNativeWindow, false);
      this.#watchSearchBar(aWindow, aNativeWindow);
      Cocoa.call(
        aNativeWindow,
        "makeFirstResponder:",
        Cocoa.objc.sendBoolWithId,
        aView
      );
      // Zen took the window for active already, so it doesn't see it
      // activate now and ask where to go.
      aWindow.gZenLittleWindow?.askForLocation();
    } else {
      lazy.setTimeout(
        () => this.#makeKeyOnceActive(aWindow, aNativeWindow, aView, aStart),
        20
      );
    }
  }

  /**
   * Puts a search bar away once another window or app is picked, as with
   * Spotlight. Gecko doesn't tell when Zen stops being the active app, so
   * it is checked while the search bar is up.
   *
   * @param {Window} aWindow
   * @param {CData} aNativeWindow
   */
  #watchSearchBar(aWindow, aNativeWindow) {
    let misses = 0;
    const check = () => {
      if (aWindow.closed || !this.#searchBars.has(aWindow)) {
        return;
      }
      // Twice in a row, as it can be in between for a moment.
      misses = Cocoa.call(aNativeWindow, "isKeyWindow", Cocoa.objc.sendBool)
        ? 0
        : misses + 1;
      if (misses >= 2) {
        aWindow.close();
      } else {
        lazy.setTimeout(check, SEARCH_BAR_WATCH_MS);
      }
    };
    check();
  }

  /**
   * Called as a little window starts closing, while it is still the key
   * window if it was. Opened from another app with the shortcut, closing it
   * goes back to that app, as with Little Arc, unless the page was opened in
   * a space or another Zen window was picked since.
   *
   * @param {Window} aWindow
   * @param {object} options
   * @param {boolean} options.openedInSpace
   * @returns {boolean} Whether it went back to that app, in which case the
   *   window should only close once Zen isn't the active app anymore: macOS
   *   would bring Zen's next window forward otherwise.
   */
  windowClosing(aWindow, { openedInSpace }) {
    const previousApp = this.#previousApps.get(aWindow);
    if (!previousApp) {
      return false;
    }
    this.#previousApps.delete(aWindow);
    const goBack =
      !openedInSpace &&
      Cocoa.isAppActive() &&
      !!Cocoa.call(
        Cocoa.nativeWindow(aWindow),
        "isKeyWindow",
        Cocoa.objc.sendBool
      );
    if (goBack) {
      Cocoa.call(
        previousApp,
        "activateWithOptions:",
        Cocoa.objc.sendBoolWithULong,
        0
      );
    }
    Cocoa.release(previousApp);
    return goBack;
  }

  /**
   * @param {Function} aCallback - Called once Zen isn't the active app, or
   *   after half a second at most.
   * @param {number} [aStart]
   */
  whenAppInactive(aCallback, aStart = Date.now()) {
    if (Cocoa.isAppActive() && Date.now() - aStart < 500) {
      lazy.setTimeout(() => this.whenAppInactive(aCallback, aStart), 10);
    } else {
      aCallback();
    }
  }

  /**
   * Shows a little window the way Little Arc does, over the app in use, and
   * smoothly: it is put up unseen, and revealed once its toolbar and address
   * bar have settled (see reveal), so nothing flashes as it starts.
   *
   * Put up early for another reason too: macOS only lets Zen become the
   * active app right as the shortcut is pressed, and then brings forward
   * Zen's key window, which would otherwise be the last regular window used.
   *
   * It joins the Space in use, even a fullscreen app's. macOS places a
   * window on a Space as it is first shown, for good, and only lets an
   * auxiliary, non-activating one join another app's fullscreen Space, as
   * Gecko's Picture-in-Picture player does. It stays non-activating only until it
   * is key, so a click still brings Zen forward later.
   *
   * @param {Window} aWindow
   * @param {object} options
   * @param {boolean} options.activate - Make Zen the active app.
   * @param {boolean} options.fromSpare - It is the window kept ready.
   * @param {boolean} options.searchFirst - It starts as a search bar.
   */
  #showSmoothly(aWindow, { activate, fromSpare, searchFirst }) {
    let nativeWindow;
    try {
      nativeWindow = Cocoa.nativeWindow(aWindow);
      // Zen's view, which AppKit stops sending keys to once the window is
      // shown this way.
      const view =
        this.#views.get(aWindow) ?? Cocoa.call(nativeWindow, "firstResponder");
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 0);
      if (fromSpare) {
        // Anything may have shown it.
        Cocoa.call(nativeWindow, "orderOut:", Cocoa.objc.sendWithId, null);
        Cocoa.call(
          nativeWindow,
          "setIgnoresMouseEvents:",
          Cocoa.objc.sendWithBool,
          0
        );
        Cocoa.call(
          nativeWindow,
          "setExcludedFromWindowsMenu:",
          Cocoa.objc.sendWithBool,
          0
        );
      }
      Cocoa.updateCollectionBehavior(nativeWindow, {
        add: NS_FULLSCREEN_AUXILIARY | NS_FULLSCREEN_DISALLOWS_TILING,
        remove:
          NS_FULLSCREEN_PRIMARY |
          NS_FULLSCREEN_ALLOWS_TILING |
          NS_IGNORES_CYCLE |
          NS_TRANSIENT,
      });
      Cocoa.setNonActivating(nativeWindow, true);
      if (searchFirst) {
        Cocoa.styleAsSearchBar(nativeWindow, true);
      }
      Cocoa.call(
        nativeWindow,
        "makeKeyAndOrderFront:",
        Cocoa.objc.sendWithId,
        null
      );
      if (activate) {
        Cocoa.call(
          Cocoa.app,
          "activateIgnoringOtherApps:",
          Cocoa.objc.sendWithBool,
          1
        );
      }
      this.#unrevealed.add(aWindow);
      // Zen would show the window as usual, but finds it already up and
      // leaves it, so it never becomes the key window that way.
      const makeKey = () =>
        this.#makeKeyOnceActive(aWindow, nativeWindow, view, Date.now());
      if (fromSpare) {
        makeKey();
      } else {
        aWindow.addEventListener("MozAfterPaint", makeKey, { once: true });
      }
      // In case the window never says it has settled.
      lazy.setTimeout(() => this.reveal(aWindow), REVEAL_AT_THE_LATEST_MS);
    } catch (ex) {
      console.error("Little windows: could not show smoothly", ex);
      if (nativeWindow) {
        Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 1);
        Cocoa.setNonActivating(nativeWindow, false);
      }
    }
  }

  /**
   * Shows a window put up by #showSmoothly. A search bar fades in where it
   * is, as Little Arc's does, and a little window slides in.
   *
   * @param {Window} aWindow
   */
  reveal(aWindow) {
    if (!this.#unrevealed.has(aWindow) || aWindow.closed) {
      return;
    }
    this.#unrevealed.delete(aWindow);
    if (!this.#searchBars.has(aWindow)) {
      this.#slideIn(aWindow);
      return;
    }
    try {
      Cocoa.animate(Cocoa.nativeWindow(aWindow), {
        duration: FADE_IN_DURATION,
        curve: EASE_OUT_CURVE,
        alpha: 1,
      });
    } catch (ex) {
      console.error("Little windows: could not fade in", ex);
      Cocoa.call(
        Cocoa.nativeWindow(aWindow),
        "setAlphaValue:",
        Cocoa.objc.sendDouble,
        1
      );
    }
  }

  /**
   * Turns the search bar a window started as into the little window, once a
   * page was picked: the search bar goes, before the address bar closes and
   * shows the toolbar it sits in, and the window slides in where little
   * windows open.
   *
   * @param {Window} aWindow
   */
  expandSearchBar(aWindow) {
    if (!this.#searchBars.has(aWindow)) {
      return;
    }
    this.#saveSearchBarPlace(aWindow);
    this.#searchBars.delete(aWindow);
    try {
      const nativeWindow = Cocoa.nativeWindow(aWindow);
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 0);
      // Out of sight now, not once Zen is next idle: the window may be
      // drawn laid out anew before that.
      Cocoa.flush();
      Cocoa.styleAsSearchBar(nativeWindow, false);
    } catch (ex) {
      console.error("Little windows: could not restyle", ex);
    }
    this.#place(aWindow, this.#initialBounds(aWindow.screen));
    this.#unrevealed.add(aWindow);
    // Once laid out at its new size.
    aWindow.requestAnimationFrame(() =>
      aWindow.requestAnimationFrame(() => this.reveal(aWindow))
    );
  }

  /**
   * Shows a window the way Hyprland shows a dropdown terminal: it slides
   * down into place from above the top of its screen, out from under the
   * menu bar, and bounces a little as it lands.
   *
   * AppKit clamps a timing curve that overshoots, so the bounce is a second
   * step: the window slides a little past its place, coming to rest there,
   * and settles back from rest, which hides where one step meets the next.
   *
   * @param {Window} aWindow
   */
  #slideIn(aWindow) {
    let nativeWindow;
    try {
      nativeWindow = Cocoa.nativeWindow(aWindow);
      const frame = Cocoa.frame(nativeWindow);
      this.#sliding.add(aWindow);
      Cocoa.setUnconstrained(nativeWindow, true);
      Cocoa.setFrame(nativeWindow, {
        ...frame,
        y: Cocoa.screenTop(nativeWindow),
      });
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 1);
      Cocoa.animate(nativeWindow, {
        duration: SLIDE_IN_DURATION,
        curve: EASE_OUT_CURVE,
        // AppKit's y grows upwards.
        frame: { ...frame, y: frame.y - BOUNCE },
      });
      const target = nativeWindow;
      lazy.setTimeout(() => {
        if (aWindow.closed) {
          return;
        }
        Cocoa.animate(target, {
          duration: SETTLE_DURATION,
          curve: EASE_IN_OUT_CURVE,
          frame,
        });
        lazy.setTimeout(
          () => {
            this.#sliding.delete(aWindow);
            if (!aWindow.closed) {
              Cocoa.setUnconstrained(target, false);
            }
          },
          SETTLE_DURATION * 1000 + 50
        );
      }, SLIDE_IN_DURATION * 1000);
    } catch (ex) {
      console.error("Little windows: could not reveal", ex);
      this.#sliding.delete(aWindow);
      if (nativeWindow) {
        Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 1);
      }
    }
  }

  /**
   * Takes a window out of sight before it closes: a little window slides
   * back up, as a dropdown terminal hides, and a search bar fades away.
   *
   * @param {Window} aWindow
   * @param {Function} aCallback - Called once it is out of sight.
   */
  hide(aWindow, aCallback) {
    if (!IS_MAC || aWindow.closed) {
      aCallback();
      return;
    }
    const searchBar = this.#searchBars.has(aWindow);
    try {
      const nativeWindow = Cocoa.nativeWindow(aWindow);
      if (searchBar) {
        Cocoa.animate(nativeWindow, {
          duration: FADE_OUT_DURATION,
          curve: EASE_IN_CURVE,
          alpha: 0,
        });
      } else {
        Cocoa.setUnconstrained(nativeWindow, true);
        Cocoa.animate(nativeWindow, {
          duration: SLIDE_OUT_DURATION,
          curve: EASE_IN_CURVE,
          frame: {
            ...Cocoa.frame(nativeWindow),
            y: Cocoa.screenTop(nativeWindow),
          },
        });
      }
    } catch (ex) {
      console.error("Little windows: could not hide", ex);
    }
    lazy.setTimeout(
      aCallback,
      (searchBar ? FADE_OUT_DURATION : SLIDE_OUT_DURATION) * 1000
    );
  }
}

const IS_MAC = AppConstants.platform === "macosx";
const REVEAL_AT_THE_LATEST_MS = 1500;
const SLIDE_IN_DURATION = 0.3;
const SETTLE_DURATION = 0.16;
const SLIDE_OUT_DURATION = 0.2;
// How far past its place a window goes before settling back, in points.
const BOUNCE = 16;
const EASE_OUT_CURVE = [0.22, 1, 0.36, 1];
const EASE_IN_OUT_CURVE = [0.37, 0, 0.63, 1];
const SPARE_AFTER_STARTUP_MS = 5000;
const SPARE_AFTER_USE_MS = 4000;
const SPARE_PUT_AWAY_AGAIN_MS = [1000, 4000];
const EASE_IN_CURVE = [0.55, 0, 0.9, 0.4];
const FADE_IN_DURATION = 0.16;
const FADE_OUT_DURATION = 0.1;
const SEARCH_BAR_WATCH_MS = 100;
// The search bar's size before it fits its results, in points.
const SEARCH_BAR_WIDTH = 560;
const SEARCH_BAR_HEIGHT = 66;
// About as tall as it gets with its results.
const SEARCH_BAR_MAX_HEIGHT = 330;
const SEARCH_BAR_SITES = 5;
const SITES_PROVIDER_NAME = "ZenLittleWindowSites";

// Moves a length along a screen so it fits on it.
const clamp = (aValue, aStart, aSize, aLength) =>
  Math.min(Math.max(aValue, aStart), aStart + aSize - aLength);

// Section: macOS

// Carbon's virtual key codes for the keys of a US keyboard, by code.
const MAC_KEY_CODES =
  "asdfhgzxcv\0bqweryt123465=97-80]ou[ip\0lj'k;\\,/nm.\0\0`";

const CARBON_CMD_KEY = 1 << 8;
const CARBON_SHIFT_KEY = 1 << 9;
const CARBON_OPTION_KEY = 1 << 11;
const CARBON_CONTROL_KEY = 1 << 12;

const fourCharCode = code =>
  [...code].reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0;

const HOT_KEY_SIGNATURE = fourCharCode("ZenL");

/**
 * A shortcut that works whatever app is in front, through Carbon's hot keys:
 * the only way to have one that doesn't need the accessibility permission.
 * The app shell tells of presses with "mac-hot-key-pressed", as a callback
 * from native code can't run script.
 */
class MacHotKey {
  static #carbon = null;
  static #callbacks = new Map();
  static #nextId = 1;

  #ref = null;
  #id = 0;

  constructor(aKeyCode, aModifiers, aCallback) {
    const carbon = MacHotKey.#load();
    this.keyCode = aKeyCode;
    this.modifiers = aModifiers;
    this.#id = MacHotKey.#nextId++;
    const ref = new carbon.EventHotKeyRef();
    const status = carbon.RegisterEventHotKey(
      aKeyCode,
      aModifiers,
      new carbon.EventHotKeyID(HOT_KEY_SIGNATURE, this.#id),
      carbon.GetApplicationEventTarget(),
      0,
      ref.address()
    );
    if (status !== 0) {
      throw new Error(`RegisterEventHotKey failed: ${status}`);
    }
    this.#ref = ref;
    MacHotKey.#callbacks.set(String(this.#id), aCallback);
  }

  unregister() {
    MacHotKey.#callbacks.delete(String(this.#id));
    MacHotKey.#carbon.UnregisterEventHotKey(this.#ref);
  }

  static #load() {
    if (this.#carbon) {
      return this.#carbon;
    }
    const { ctypes } = lazy;
    // Open for as long as the app runs.
    const lib = ctypes.open(
      "/System/Library/Frameworks/Carbon.framework/Carbon"
    );
    const ref = ctypes.voidptr_t;
    const EventHotKeyID = new ctypes.StructType("EventHotKeyID", [
      { signature: ctypes.uint32_t },
      { id: ctypes.uint32_t },
    ]);
    this.#carbon = {
      EventHotKeyID,
      EventHotKeyRef: ref,
      GetApplicationEventTarget: lib.declare(
        "GetApplicationEventTarget",
        ctypes.default_abi,
        ref
      ),
      RegisterEventHotKey: lib.declare(
        "RegisterEventHotKey",
        ctypes.default_abi,
        ctypes.int32_t,
        ctypes.uint32_t,
        ctypes.uint32_t,
        EventHotKeyID,
        ref,
        ctypes.uint32_t,
        ref.ptr
      ),
      UnregisterEventHotKey: lib.declare(
        "UnregisterEventHotKey",
        ctypes.default_abi,
        ctypes.int32_t,
        ref
      ),
    };
    Services.obs.addObserver(
      (subject, topic, data) => this.#callbacks.get(data)?.(),
      "mac-hot-key-pressed"
    );
    return this.#carbon;
  }
}

const NS_WINDOW_STYLE_MASK_RESIZABLE = 1 << 3;
const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL = 1 << 7;
const NS_WINDOW_BUTTONS = [0, 1, 2]; // Close, minimize and zoom.
const NS_TRANSIENT = 1 << 3;
const NS_IGNORES_CYCLE = 1 << 6;
const NS_FULLSCREEN_PRIMARY = 1 << 7;
const NS_FULLSCREEN_AUXILIARY = 1 << 8;
const NS_FULLSCREEN_ALLOWS_TILING = 1 << 11;
const NS_FULLSCREEN_DISALLOWS_TILING = 1 << 12;

/**
 * The few AppKit calls little windows need.
 */
const Cocoa = {
  get objc() {
    const { ctypes } = lazy;
    // Open for as long as the app runs.
    const lib = ctypes.open("/usr/lib/libobjc.A.dylib");
    const id = ctypes.voidptr_t;
    const msgSend = (returns, ...args) =>
      lib.declare("objc_msgSend", ctypes.default_abi, returns, id, id, ...args);
    const objc = {
      getClass: lib.declare(
        "objc_getClass",
        ctypes.default_abi,
        id,
        ctypes.char.ptr
      ),
      selector: lib.declare(
        "sel_registerName",
        ctypes.default_abi,
        id,
        ctypes.char.ptr
      ),
      sendId: msgSend(id),
      sendBool: msgSend(ctypes.signed_char),
      sendULong: msgSend(ctypes.unsigned_long),
      sendIdWithULong: msgSend(id, ctypes.unsigned_long),
      sendBoolWithULong: msgSend(ctypes.signed_char, ctypes.unsigned_long),
      send: msgSend(ctypes.void_t),
      sendWithId: msgSend(ctypes.void_t, id),
      sendBoolWithId: msgSend(ctypes.signed_char, id),
      sendWithBool: msgSend(ctypes.void_t, ctypes.signed_char),
      sendWithULong: msgSend(ctypes.void_t, ctypes.unsigned_long),
      sendDouble: msgSend(ctypes.void_t, ctypes.double),
      sendRect: msgSend(this.NSRect),
      sendWithRectBool: msgSend(ctypes.void_t, this.NSRect, ctypes.signed_char),
      sendWith4Floats: msgSend(
        id,
        ctypes.float32_t,
        ctypes.float32_t,
        ctypes.float32_t,
        ctypes.float32_t
      ),
    };
    delete this.objc;
    return (this.objc = objc);
  },

  get NSRect() {
    const { ctypes } = lazy;
    const NSRect = new ctypes.StructType("NSRect", [
      { x: ctypes.double },
      { y: ctypes.double },
      { width: ctypes.double },
      { height: ctypes.double },
    ]);
    delete this.NSRect;
    return (this.NSRect = NSRect);
  },

  call(aReceiver, aSelector, aSend = this.objc.sendId, ...aArgs) {
    return aSend(aReceiver, this.objc.selector(aSelector), ...aArgs);
  },

  get app() {
    return this.call(this.objc.getClass("NSApplication"), "sharedApplication");
  },

  isAppActive() {
    return !!this.call(this.app, "isActive", this.objc.sendBool);
  },

  /** @returns {CData|null} The app in front, kept until released. */
  frontmostApp() {
    const workspace = this.call(
      this.objc.getClass("NSWorkspace"),
      "sharedWorkspace"
    );
    const app = this.call(workspace, "frontmostApplication");
    return app.isNull() ? null : this.call(app, "retain");
  },

  release(aApp) {
    if (aApp) {
      this.call(aApp, "release", this.objc.send);
    }
  },

  updateCollectionBehavior(aNativeWindow, { add = 0, remove = 0 }) {
    const behavior = Number(
      this.call(aNativeWindow, "collectionBehavior", this.objc.sendULong)
    );
    this.call(
      aNativeWindow,
      "setCollectionBehavior:",
      this.objc.sendWithULong,
      (behavior & ~remove) | add
    );
  },

  setStyle(aNativeWindow, aStyle, aValue) {
    const mask = Number(
      this.call(aNativeWindow, "styleMask", this.objc.sendULong)
    );
    this.call(
      aNativeWindow,
      "setStyleMask:",
      this.objc.sendWithULong,
      aValue ? mask | aStyle : mask & ~aStyle
    );
  },

  // Gecko's windows keep this style even though they aren't panels.
  setNonActivating(aNativeWindow, aValue) {
    this.setStyle(
      aNativeWindow,
      NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL,
      aValue
    );
  },

  // A search bar has no window buttons, and keeps the size it is given.
  styleAsSearchBar(aNativeWindow, aValue) {
    for (const kind of NS_WINDOW_BUTTONS) {
      const button = this.call(
        aNativeWindow,
        "standardWindowButton:",
        this.objc.sendIdWithULong,
        kind
      );
      if (!button.isNull()) {
        this.call(button, "setHidden:", this.objc.sendWithBool, aValue ? 1 : 0);
      }
    }
    this.setStyle(aNativeWindow, NS_WINDOW_STYLE_MASK_RESIZABLE, !aValue);
  },

  /** @returns {{x: number, y: number, width: number, height: number}} */
  frame(aNativeWindow) {
    const { x, y, width, height } = this.call(
      aNativeWindow,
      "frame",
      this.objc.sendRect
    );
    return { x, y, width, height };
  },

  setFrame(aNativeWindow, { x, y, width, height }) {
    this.call(
      aNativeWindow,
      "setFrame:display:",
      this.objc.sendWithRectBool,
      new this.NSRect(x, y, width, height),
      0
    );
  },

  /**
   * Animates a window's alpha and frame. AppKit runs it, off script.
   *
   * @param {CData} aNativeWindow
   * @param {object} options
   * @param {number} options.duration - In seconds.
   * @param {number[]} options.curve - A cubic bezier's control points.
   * @param {number} [options.alpha]
   * @param {object} [options.frame]
   */
  animate(aNativeWindow, { duration, curve, alpha, frame }) {
    const context = this.objc.getClass("NSAnimationContext");
    this.call(context, "beginGrouping", this.objc.send);
    try {
      const current = this.call(context, "currentContext");
      this.call(current, "setDuration:", this.objc.sendDouble, duration);
      this.call(
        current,
        "setTimingFunction:",
        this.objc.sendWithId,
        this.call(
          this.objc.getClass("CAMediaTimingFunction"),
          "functionWithControlPoints::::",
          this.objc.sendWith4Floats,
          ...curve
        )
      );
      const animator = this.call(aNativeWindow, "animator");
      if (frame) {
        const { x, y, width, height } = frame;
        this.call(
          animator,
          "setFrame:display:",
          this.objc.sendWithRectBool,
          new this.NSRect(x, y, width, height),
          1
        );
      }
      if (alpha !== undefined) {
        this.call(animator, "setAlphaValue:", this.objc.sendDouble, alpha);
      }
    } finally {
      this.call(context, "endGrouping", this.objc.send);
    }
  },

  /**
   * The Space in use, on the screen with the menu bar. Through a private
   * call, which tools for Spaces have long relied on: AppKit has none.
   *
   * @returns {string}
   */
  activeSpace() {
    if (!this._skyLight) {
      const { ctypes } = lazy;
      // Open for as long as the app runs.
      const lib = ctypes.open(
        "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
      );
      this._skyLight = {
        mainConnection: lib.declare(
          "CGSMainConnectionID",
          ctypes.default_abi,
          ctypes.int32_t
        ),
        activeSpace: lib.declare(
          "CGSGetActiveSpace",
          ctypes.default_abi,
          ctypes.uint64_t,
          ctypes.int32_t
        ),
      };
    }
    const { mainConnection, activeSpace } = this._skyLight;
    return String(activeSpace(mainConnection()));
  },

  // Sends the changes made to windows so far to the screen.
  flush() {
    this.call(this.objc.getClass("CATransaction"), "flush", this.objc.send);
  },

  // Lets a window go past the top of its screen, which AppKit doesn't let
  // titled windows do (see BaseWindow's constrainFrameRect:toScreen:).
  setUnconstrained(aNativeWindow, aValue) {
    const selector = this.objc.selector("setZenUnconstrained:");
    if (
      this.call(
        aNativeWindow,
        "respondsToSelector:",
        this.objc.sendBoolWithId,
        selector
      )
    ) {
      this.objc.sendWithBool(aNativeWindow, selector, aValue ? 1 : 0);
    }
  },

  // Where a window's bottom edge goes for it to sit just above its screen,
  // in AppKit's coordinates, which grow upwards.
  screenTop(aNativeWindow) {
    const screen = this.call(aNativeWindow, "screen");
    const { y, height } = this.call(screen, "frame", this.objc.sendRect);
    return y + height;
  },

  nativeWindow(aWindow) {
    const { ctypes } = lazy;
    return ctypes.voidptr_t(
      ctypes.UInt64(
        aWindow.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle
      )
    );
  },
};

export const ZenLittleWindows = new nsZenLittleWindows();
