// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ctypes: "resource://gre/modules/ctypes.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const GLOBAL_SHORTCUT_PREF = "zen.little-window.global-shortcut";
const PRELOAD_PREF = "zen.little-window.preload";

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
  // The view AppKit sends keys to, by window, from before AppKit loses
  // track of it (see #showSmoothly).
  #views = new WeakMap();
  // A little window kept ready and out of sight, so the next one shows at
  // once instead of starting up first (see #makeSpare).
  #spare = null;
  #spareReady = false;
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
   * Opens a little window.
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
    const previousApp =
      IS_MAC && !Cocoa.isAppActive() ? Cocoa.frontmostApp() : null;
    let win = this.#takeSpare();
    const fromSpare = !!win;
    if (fromSpare) {
      this.#place(win, opener);
      win.gZenLittleWindow.takeOver({
        url,
        spaceId: space?.uuid ?? null,
        triggeringPrincipal,
      });
    } else {
      win = this.#create({ opener, space });
      win._zenLittleWindow = {
        spaceId: space?.uuid ?? null,
        url,
        triggeringPrincipal,
      };
    }
    if (IS_MAC) {
      if (previousApp) {
        this.#previousApps.set(win, previousApp);
      }
      this.#showSmoothly(win, { activate: !!previousApp, fromSpare });
      this.#scheduleSpare(SPARE_AFTER_USE_MS);
    }
    return win;
  }

  /**
   * @param {object} options
   * @param {Window} [options.opener]
   * @param {object} [options.space] - Its container is the one the window
   *   starts in. Without one, the opener's.
   * @returns {Window}
   */
  #create({ opener = null, space = null }) {
    const { left, top, width, height } = this.#initialBounds(
      opener?.screen ?? this.#primaryScreen()
    );
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
   * Moves a window kept ready to where a new little window would open.
   *
   * @param {Window} aWindow
   * @param {Window} [aOpener]
   */
  #place(aWindow, aOpener) {
    const { left, top, width, height } = this.#initialBounds(
      aOpener?.screen ?? this.#primaryScreen()
    );
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
    const win = this.#create({
      opener: lazy.BrowserWindowTracker.getTopWindow({ private: false }),
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
      // Mission Control.
      Cocoa.call(
        nativeWindow,
        "setCollectionBehavior:",
        Cocoa.objc.sendWithULong,
        Number(
          Cocoa.call(nativeWindow, "collectionBehavior", Cocoa.objc.sendULong)
        ) |
          NS_IGNORES_CYCLE |
          NS_TRANSIENT
      );
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
    const [left, top] = Services.prefs
      .getStringPref("zen.little-window.position", "")
      .split(",")
      .map(value => parseInt(value, 10));
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const { availLeft, availTop, availWidth, availHeight } = this.#availRect(
        Cc["@mozilla.org/gfx/screenmanager;1"]
          .getService(Ci.nsIScreenManager)
          .screenForRect(left, top, width, height)
      );
      width = Math.min(width, availWidth);
      height = Math.min(height, availHeight);
      // Screens may have been rearranged since: keep the window on one.
      const clamp = (value, start, size, length) =>
        Math.min(Math.max(value, start), start + size - length);
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
    if (
      aWindow.windowState !== aWindow.STATE_NORMAL ||
      this.#sliding.has(aWindow)
    ) {
      return;
    }
    // The width and height a window is opened with are its inner size.
    Services.prefs.setIntPref("zen.little-window.width", aWindow.innerWidth);
    Services.prefs.setIntPref("zen.little-window.height", aWindow.innerHeight);
    Services.prefs.setStringPref(
      "zen.little-window.position",
      `${aWindow.screenX},${aWindow.screenY}`
    );
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
   * Called as a little window starts closing, while it is still the active
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
      Services.focus.activeWindow === aWindow;
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
   * window on a Space as it is first shown, and only lets an auxiliary,
   * non-activating one join another app's fullscreen Space, as Gecko's
   * Picture-in-Picture player does. It stays non-activating only until it
   * is key, so a click still brings Zen forward later.
   *
   * @param {Window} aWindow
   * @param {object} options
   * @param {boolean} options.activate - Make Zen the active app.
   */
  #showSmoothly(aWindow, { activate, fromSpare }) {
    let nativeWindow;
    try {
      nativeWindow = Cocoa.nativeWindow(aWindow);
      // Zen's view, which AppKit stops sending keys to once the window is
      // shown this way.
      const view =
        this.#views.get(aWindow) ?? Cocoa.call(nativeWindow, "firstResponder");
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 0);
      if (fromSpare) {
        // Out of every Space, so it is shown on the one in use.
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
      const behavior = Number(
        Cocoa.call(nativeWindow, "collectionBehavior", Cocoa.objc.sendULong)
      );
      Cocoa.call(
        nativeWindow,
        "setCollectionBehavior:",
        Cocoa.objc.sendWithULong,
        (behavior &
          ~(
            NS_FULLSCREEN_PRIMARY |
            NS_FULLSCREEN_ALLOWS_TILING |
            NS_IGNORES_CYCLE |
            NS_TRANSIENT
          )) |
          NS_FULLSCREEN_AUXILIARY |
          NS_FULLSCREEN_DISALLOWS_TILING
      );
      Cocoa.setNonActivating(nativeWindow, true);
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
   * Shows a window put up by #showSmoothly the way Hyprland shows a dropdown
   * terminal: it slides down into place from above the top of its screen,
   * out from under the menu bar, and bounces a little as it lands.
   *
   * AppKit clamps a timing curve that overshoots, so the bounce is a second
   * step: the window slides a little past its place, coming to rest there,
   * and settles back from rest, which hides where one step meets the next.
   *
   * @param {Window} aWindow
   */
  reveal(aWindow) {
    if (!this.#unrevealed.has(aWindow) || aWindow.closed) {
      return;
    }
    this.#unrevealed.delete(aWindow);
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
   * Slides a window back up out of sight before it closes, as a dropdown
   * terminal hides.
   *
   * @param {Window} aWindow
   * @param {Function} aCallback - Called once it is out of sight.
   */
  slideOut(aWindow, aCallback) {
    if (!IS_MAC || aWindow.closed) {
      aCallback();
      return;
    }
    try {
      const nativeWindow = Cocoa.nativeWindow(aWindow);
      Cocoa.setUnconstrained(nativeWindow, true);
      Cocoa.animate(nativeWindow, {
        duration: SLIDE_OUT_DURATION,
        curve: EASE_IN_CURVE,
        frame: {
          ...Cocoa.frame(nativeWindow),
          y: Cocoa.screenTop(nativeWindow),
        },
      });
    } catch (ex) {
      console.error("Little windows: could not slide out", ex);
    }
    lazy.setTimeout(aCallback, SLIDE_OUT_DURATION * 1000);
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

const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL = 1 << 7;
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

  // Gecko's windows keep this style even though they aren't panels.
  setNonActivating(aNativeWindow, aValue) {
    const mask = Number(
      this.call(aNativeWindow, "styleMask", this.objc.sendULong)
    );
    this.call(
      aNativeWindow,
      "setStyleMask:",
      this.objc.sendWithULong,
      aValue
        ? mask | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL
        : mask & ~NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL
    );
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
