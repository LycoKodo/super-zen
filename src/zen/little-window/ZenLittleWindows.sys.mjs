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

/**
 * What little windows share across windows: opening them, where they open,
 * and on macOS, the shortcut that opens one from any app, like Little Arc.
 * The windows themselves are run by ZenLittleWindow.mjs.
 */
class nsZenLittleWindows {
  #globalShortcut = null;
  // The app that was in use when the global shortcut opened a window, by
  // window, to go back to once it closes.
  #previousApps = new WeakMap();
  #hotKey = null;

  constructor() {
    Services.prefs.addObserver(GLOBAL_SHORTCUT_PREF, () =>
      this.#updateGlobalShortcut()
    );
    Services.prefs.addObserver("zen.little-window.enabled", () =>
      this.#updateGlobalShortcut()
    );
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
    win._zenStartupUnsyncedUserContextId =
      typeof space?.containerTabId === "number" ? space.containerTabId : 0;
    win._zenLittleWindow = {
      spaceId: space?.uuid ?? null,
      url,
      triggeringPrincipal,
    };
    return win;
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
    if (aWindow.windowState !== aWindow.STATE_NORMAL) {
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
    const previousApp = Cocoa.isAppActive() ? null : Cocoa.frontmostApp();
    const opener = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    const win = opener?.gZenLittleWindow
      ? opener.gZenLittleWindow.open()
      : this.open();
    if (!win) {
      Cocoa.release(previousApp);
    } else if (previousApp) {
      this.#previousApps.set(win, previousApp);
      this.#showOverOtherApp(win);
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
   * Shows a little window over the app in use, like Little Arc. macOS only
   * lets Zen become the active app right as the shortcut is pressed, and
   * then brings forward Zen's key window, which would otherwise be the last
   * regular window used. So the little window is put up first, unseen until
   * its first paint.
   *
   * It joins the Space in use, even a fullscreen app's. macOS places a
   * window on a Space as it is first shown, and only lets an auxiliary,
   * non-activating one join another app's fullscreen Space, as Gecko's
   * Picture-in-Picture player does. It stays non-activating only until it
   * is key, so a click still brings Zen forward later.
   *
   * @param {Window} aWindow
   */
  #showOverOtherApp(aWindow) {
    let nativeWindow;
    try {
      nativeWindow = Cocoa.nativeWindow(aWindow);
      // Zen's view, which AppKit stops sending keys to once the window is
      // shown this way.
      const view = Cocoa.call(nativeWindow, "firstResponder");
      Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 0);
      const behavior = Number(
        Cocoa.call(nativeWindow, "collectionBehavior", Cocoa.objc.sendULong)
      );
      Cocoa.call(
        nativeWindow,
        "setCollectionBehavior:",
        Cocoa.objc.sendWithULong,
        (behavior & ~(NS_FULLSCREEN_PRIMARY | NS_FULLSCREEN_ALLOWS_TILING)) |
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
      Cocoa.call(
        Cocoa.app,
        "activateIgnoringOtherApps:",
        Cocoa.objc.sendWithBool,
        1
      );
      // Zen would show the window as usual, but finds it already up and
      // leaves it, so it never becomes the key window that way.
      aWindow.addEventListener(
        "MozAfterPaint",
        () => {
          Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 1);
          this.#makeKeyOnceActive(aWindow, nativeWindow, view, Date.now());
        },
        { once: true }
      );
    } catch (ex) {
      console.error("Little windows: could not show over the app in use", ex);
      if (nativeWindow) {
        Cocoa.call(nativeWindow, "setAlphaValue:", Cocoa.objc.sendDouble, 1);
        Cocoa.setNonActivating(nativeWindow, false);
      }
    }
  }
}

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
    };
    delete this.objc;
    return (this.objc = objc);
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
