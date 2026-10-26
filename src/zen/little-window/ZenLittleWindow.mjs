// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { nsZenDOMOperatedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
});

const LITTLE_WINDOW_ATTR = "zen-little-window";

/**
 * Little windows, after Arc's "Little Arc": a small, unsynced window for a
 * quick look at a page. It has no sidebar, only a slim toolbar, and the page
 * can be sent to a space of a regular window with a single click (Accel+O).
 *
 * The window that opens one passes its options through `_zenLittleWindow`,
 * set on the new window before its document loads.
 */
class nsZenLittleWindow extends nsZenDOMOperatedFeature {
  // The space the page is sent to by "Open in".
  #targetSpaceId = null;
  #initialTab = null;
  // Set while the page is reopened in another container.
  #replacingTab = false;

  constructor() {
    super();
    if (this.isLittleWindow) {
      const root = document.documentElement;
      root.setAttribute(LITTLE_WINDOW_ATTR, "true");
      // The size of a little window must never become the size the next
      // regular window opens with.
      root.removeAttribute("persist");
      root.removeAttribute("sizemode");
      // A window that can't go fullscreen itself is an auxiliary one to
      // macOS, which can open over a fullscreen window instead of switching
      // to another Space. Read before the window is first shown.
      root.setAttribute("macnativefullscreen", "false");
    }
  }

  get isLittleWindow() {
    return !!window._zenLittleWindow;
  }

  get enabled() {
    return Services.prefs.getBoolPref("zen.little-window.enabled", true);
  }

  init() {
    if (!this.isLittleWindow) {
      return;
    }
    this.#targetSpaceId = window._zenLittleWindow.spaceId;
    this.#addKeys();
    this.#buildToolbar();
    // gBrowser isn't set up yet, the window sees its tabs open all the same.
    window.addEventListener("TabOpen", this);
    window.addEventListener("resize", this);
    window.addEventListener("unload", () => this.#saveBounds(), {
      once: true,
    });
    gZenStartup.promiseInitialized.then(() => this.#onStartupDone());
  }

  // Section: opening

  /**
   * Opens a little window from this window.
   *
   * @param {object} [options]
   * @param {string} [options.url] - The page to show. Without one, the
   *   address bar opens so a page can be picked.
   * @param {string} [options.spaceId] - The space "Open in" sends the page
   *   to. Defaults to the space last used in a regular window.
   * @param {nsIPrincipal} [options.triggeringPrincipal] - What loads the
   *   page, the system by default.
   * @returns {Window|null} The new window.
   */
  open({ url = null, spaceId = null, triggeringPrincipal = null } = {}) {
    if (!this.enabled || PrivateBrowsingUtils.isWindowPrivate(window)) {
      return null;
    }
    const space = this.#resolveSpace(spaceId);
    const { left, top, width, height } = this.#initialBounds();

    // The page is loaded once the window is up: a single URL argument would
    // be split on "|" and loaded as several pages.
    const args = Cc["@mozilla.org/supports-string;1"].createInstance(
      Ci.nsISupportsString
    );
    args.data = "about:blank";
    const win = OpenBrowserWindow({
      args,
      features: `width=${width},height=${height},left=${left},top=${top}`,
      zenSyncedWindow: false,
    });
    // Whatever "zen.window-sync.prefer-unsynced-windows" says, a little
    // window is never synced.
    win._zenStartupSyncFlag = "unsynced";
    win._zenStartupUnsyncedUserContextId = this.#spaceContainerId(space);
    win._zenLittleWindow = {
      spaceId: space?.uuid ?? null,
      url,
      triggeringPrincipal,
    };
    return win;
  }

  /**
   * Where a new little window opens: where the last one was left, as long as
   * that is still on a screen, or else centered on this window's screen.
   *
   * @returns {{left: number, top: number, width: number, height: number}}
   */
  #initialBounds() {
    let width = Services.prefs.getIntPref("zen.little-window.width", 960);
    let height = Services.prefs.getIntPref("zen.little-window.height", 680);
    const [left, top] = Services.prefs
      .getStringPref("zen.little-window.position", "")
      .split(",")
      .map(value => parseInt(value, 10));
    if (Number.isFinite(left) && Number.isFinite(top)) {
      const screen = Cc["@mozilla.org/gfx/screenmanager;1"]
        .getService(Ci.nsIScreenManager)
        .screenForRect(left, top, width, height);
      const availLeft = {},
        availTop = {},
        availWidth = {},
        availHeight = {};
      screen.GetAvailRectDisplayPix(availLeft, availTop, availWidth, availHeight);
      width = Math.min(width, availWidth.value);
      height = Math.min(height, availHeight.value);
      // Screens may have been rearranged since: keep the window on one.
      const clamp = (value, start, size, length) =>
        Math.min(Math.max(value, start), start + size - length);
      return {
        left: clamp(left, availLeft.value, availWidth.value, width),
        top: clamp(top, availTop.value, availHeight.value, height),
        width,
        height,
      };
    }
    const { availLeft, availTop, availWidth, availHeight } = window.screen;
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
   * Remembers this little window's size and place for the next one, like
   * Arc does. Windows don't say when they move, so this also runs on close.
   */
  #saveBounds() {
    if (window.windowState !== window.STATE_NORMAL) {
      return;
    }
    // The width and height a window is opened with are its inner size.
    Services.prefs.setIntPref("zen.little-window.width", window.innerWidth);
    Services.prefs.setIntPref("zen.little-window.height", window.innerHeight);
    Services.prefs.setStringPref(
      "zen.little-window.position",
      `${window.screenX},${window.screenY}`
    );
  }

  /**
   * The regular window to send pages to: the most recently used synced one.
   *
   * @returns {Window|null}
   */
  get #syncedWindow() {
    return (
      BrowserWindowTracker.orderedWindows.find(
        win =>
          !win.closed &&
          win.gZenWorkspaces?.currentWindowIsSyncing &&
          !win.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)
      ) ?? null
    );
  }

  get #spaces() {
    // A regular window knows about spaces the session store hasn't saved yet.
    return (
      this.#syncedWindow?.gZenWorkspaces.getWorkspaces() ??
      gZenWorkspaces.getWorkspaces(true)
    );
  }

  #resolveSpace(spaceId) {
    const spaces = this.#spaces;
    const fromSyncedWindow = this.#syncedWindow?.gZenWorkspaces.activeWorkspace;
    return (
      spaces.find(space => space.uuid === spaceId) ??
      spaces.find(space => space.uuid === fromSyncedWindow) ??
      spaces[0] ??
      null
    );
  }

  #spaceContainerId(space) {
    return typeof space?.containerTabId === "number" ? space.containerTabId : 0;
  }

  get targetSpace() {
    return this.#resolveSpace(this.#targetSpaceId);
  }

  // Section: toolbar

  #buildToolbar() {
    const navBar = document.getElementById("nav-bar");
    const spaceItem = window.MozXULElement.parseXULToFragment(`
      <toolbaritem id="zen-little-window-space-item" removable="false">
        <html:button id="zen-little-window-space-button"
                     class="zen-little-window-pill"
                     data-l10n-id="zen-little-window-space-button">
          <html:span class="zen-little-window-space-icon"/>
          <html:span class="zen-little-window-space-name"/>
        </html:button>
        <menupopup id="zen-little-window-space-popup"/>
      </toolbaritem>
    `);
    navBar.prepend(spaceItem);

    const actions = window.MozXULElement.parseXULToFragment(`
      <toolbaritem id="zen-little-window-actions" removable="false">
        <toolbarbutton id="zen-little-window-copy-url"
                       class="toolbarbutton-1"
                       data-l10n-id="zen-little-window-copy-url"/>
        <html:div id="zen-little-window-open-in">
          <html:button id="zen-little-window-open-in-button">
            <html:span data-l10n-id="zen-little-window-open-in-label"/>
            <html:span class="zen-little-window-space-name"/>
            <html:kbd id="zen-little-window-open-in-shortcut"/>
          </html:button>
          <html:button id="zen-little-window-open-in-menu"
                       data-l10n-id="zen-little-window-open-in-menu"/>
        </html:div>
        <menupopup id="zen-little-window-open-in-popup"/>
      </toolbaritem>
    `);
    navBar.append(actions);

    this.#connectMenu(
      "zen-little-window-space-button",
      "zen-little-window-space-popup",
      space => this.setTargetSpace(space)
    );
    this.#connectMenu(
      "zen-little-window-open-in-menu",
      "zen-little-window-open-in-popup",
      space => this.openInSpace(space)
    );
    document
      .getElementById("zen-little-window-open-in-button")
      .addEventListener("click", () => this.openInSpace());
    document
      .getElementById("zen-little-window-copy-url")
      .addEventListener("command", () => {
        gZenCommonActions.copyCurrentURLToClipboard();
      });
    this.#updateToolbar();
  }

  #connectMenu(buttonId, popupId, onPick) {
    const button = document.getElementById(buttonId);
    const popup = document.getElementById(popupId);
    button.addEventListener("click", () => {
      this.#fillSpacesPopup(popup, onPick);
      button.setAttribute("open", "true");
      popup.addEventListener(
        "popuphidden",
        () => button.removeAttribute("open"),
        { once: true }
      );
      popup.openPopup(button, "after_start", 0, 4);
    });
  }

  #fillSpacesPopup(popup, onPick) {
    popup.replaceChildren();
    const target = this.targetSpace;
    for (const space of this.#spaces) {
      const item = gZenWorkspaces.generateMenuItemForWorkspace(space, true);
      item.removeAttribute("disabled");
      item.setAttribute("type", "radio");
      item.toggleAttribute("checked", space.uuid === target?.uuid);
      item.addEventListener("command", () => onPick(space));
      popup.appendChild(item);
    }
  }

  #updateToolbar() {
    const space = this.targetSpace;
    const icon = (space && gZenWorkspaces.getWorkspaceIcon(space)) || "";
    for (const element of document.querySelectorAll(
      ".zen-little-window-space-name"
    )) {
      element.textContent = space?.name ?? "";
    }
    const iconElement = document.querySelector(
      ".zen-little-window-space-icon"
    );
    if (icon.endsWith(".svg")) {
      iconElement.textContent = "";
      iconElement.style.backgroundImage = `url("${icon}")`;
    } else {
      iconElement.textContent = icon;
      iconElement.style.backgroundImage = "";
    }
    document.getElementById("zen-little-window-open-in-shortcut").textContent =
      ShortcutUtils.prettifyShortcut(
        document.getElementById("zen-little-window-open-in-key")
      );
  }

  #addKeys() {
    // Only describes the shortcut for the toolbar: Accel+O is also "Open
    // File" in the main keyset, which would get it first, so the keypress
    // itself is caught earlier, in #onKeyDown.
    const keyset = window.MozXULElement.parseXULToFragment(`
      <keyset id="zen-little-window-keyset">
        <key id="zen-little-window-open-in-key" key="O" modifiers="accel"/>
      </keyset>
    `);
    document.documentElement.appendChild(keyset);
    window.addEventListener("keydown", this, true);
  }

  #onKeyDown(event) {
    const accel =
      AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
    const otherModifiers =
      event.altKey ||
      event.shiftKey ||
      (AppConstants.platform === "macosx" ? event.ctrlKey : event.metaKey);
    if (!accel || otherModifiers || event.key.toLowerCase() !== "o") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      this.openInSpace();
    }
  }

  // Section: window behaviour

  #onStartupDone() {
    this.#initialTab = gBrowser.selectedTab;
    // Spaces are only known once the window has fully started.
    this.#updateToolbar();
    const { url, triggeringPrincipal } = window._zenLittleWindow;
    if (url) {
      gBrowser.selectedBrowser.fixupAndLoadURIString(url, {
        triggeringPrincipal:
          triggeringPrincipal ??
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
    } else {
      // Ask where to go straight away, the same way Arc does. The page takes
      // focus once the window gets activated and once it finishes loading, so
      // ask again then, as long as nothing was picked yet.
      const openLocation = () =>
        setTimeout(() => {
          if (
            !gURLBar.focused &&
            gBrowser.selectedBrowser.currentURI.spec === "about:blank"
          ) {
            document.getElementById("Browser:OpenLocation").doCommand();
          }
        }, 0);
      openLocation();
      if (Services.focus.activeWindow !== window) {
        window.addEventListener("activate", openLocation, { once: true });
      }
      const listener = {
        onStateChange(webProgress, request, flags) {
          if (
            webProgress.isTopLevel &&
            flags & Ci.nsIWebProgressListener.STATE_STOP
          ) {
            gBrowser.removeProgressListener(listener);
            openLocation();
          }
        },
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
      };
      gBrowser.addProgressListener(listener);
    }
  }

  #saveBoundsTimer = null;

  handleEvent(event) {
    switch (event.type) {
      case "TabOpen":
        this.#onTabOpen(event.target);
        break;
      case "resize":
        clearTimeout(this.#saveBoundsTimer);
        this.#saveBoundsTimer = setTimeout(() => this.#saveBounds(), 500);
        break;
      case "keydown":
        this.#onKeyDown(event);
        break;
    }
  }

  /**
   * A little window only ever shows one page. Links that open new tabs open
   * them in the target space of a regular window, as Arc does.
   *
   * @param {MozTabbrowserTab} aTab
   */
  #onTabOpen(aTab) {
    if (
      !this.#initialTab ||
      this.#replacingTab ||
      aTab === this.#initialTab ||
      aTab.hasAttribute("zen-empty-tab") ||
      aTab.hasAttribute("zen-glance-tab")
    ) {
      return;
    }
    // Let the tab finish being set up before moving it.
    Services.tm.dispatchToMainThread(() => {
      if (!aTab.closing && aTab.isConnected) {
        this.#sendTabs([aTab], this.targetSpace, { closeWindow: false });
      }
    });
  }

  /**
   * Changes the space "Open in" sends the page to. Spaces have their own
   * container, so the page is reloaded in the new one if needed.
   *
   * @param {object} aSpace
   */
  setTargetSpace(aSpace) {
    const previous = this.targetSpace;
    this.#targetSpaceId = aSpace.uuid;
    this.#updateToolbar();
    const userContextId = this.#spaceContainerId(aSpace);
    if (userContextId === this.#spaceContainerId(previous)) {
      return;
    }
    const oldTab = gBrowser.selectedTab;
    const uri = oldTab.linkedBrowser.currentURI;
    let newTab;
    this.#replacingTab = true;
    try {
      newTab = gBrowser.addTrustedTab(
        uri && uri.spec !== "about:blank" ? uri.spec : "about:blank",
        { userContextId, inBackground: false, skipAnimation: true }
      );
    } finally {
      this.#replacingTab = false;
    }
    this.#initialTab = newTab;
    gBrowser.selectedTab = newTab;
    gBrowser.removeTab(oldTab, { animate: false, closeWindowWithLastTab: false });
  }

  /**
   * Sends the page to a space of a regular window and closes this window.
   *
   * @param {object} [aSpace] - Defaults to the target space.
   */
  openInSpace(aSpace = this.targetSpace) {
    if (!aSpace) {
      return;
    }
    const tabs = gBrowser.tabs.filter(
      tab => !tab.hasAttribute("zen-empty-tab") && !tab.closing
    );
    this.#sendTabs(tabs, aSpace, { closeWindow: true });
  }

  /**
   * @param {MozTabbrowserTab[]} aTabs
   * @param {object} aSpace
   * @param {object} options
   * @param {boolean} options.closeWindow - Close this window afterwards.
   */
  #sendTabs(aTabs, aSpace, { closeWindow }) {
    // Done by window sync, which outlives this window: what is left once the
    // window closes, like focusing the page in its space, still happens.
    lazy.ZenWindowSync.moveTabsToSyncedWorkspace(window, aSpace.uuid, {
      tabs: aTabs,
      targetWindow: this.#syncedWindow,
      closeWindow,
    });
  }
}

window.gZenLittleWindow = new nsZenLittleWindow();
