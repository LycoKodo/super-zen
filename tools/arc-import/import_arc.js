/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Imports everything from Arc into the running browser. Run with chrome
 * privileges through Marionette (see import_arc.py).
 *
 *  - Every Arc profile becomes a container, except the one of the first
 *    space, which uses the default container.
 *  - History, passwords, form data and payment cards of every profile go
 *    through Zen's own Arc migrator. Extensions aren't imported: Firefox
 *    only matches Chrome's own, so install their Firefox versions by hand.
 *  - Cookies, which no migrator imports, are decrypted with Arc's keychain
 *    key and added to the profile's container, so accounts stay signed in.
 *  - Spaces, pinned tabs, folders and favorites are created from Arc's
 *    sidebar, each space in its profile's container.
 */

/* global arguments */
const [arcRoot, options] = arguments;
const done = arguments[arguments.length - 1];

const { MigrationUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs"
);
const { ZenMigrationUtils } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenMigrationUtils.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

const ARC_SYSTEM_PROFILE = "__ARC_SYSTEM_PROFILE";
const CONTAINER_COLORS = [
  "blue",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
];
// Microseconds between 1601-01-01, where Chromium's clock starts, and 1970.
const CHROMIUM_EPOCH_OFFSET_US = 11644473600n * 1000000n;
// Session cookies become persistent ones, as Arc keeps them across restarts.
const SESSION_COOKIE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const report = { containers: {}, profiles: {}, spaces: 0, errors: [] };

// What earlier, interrupted runs already imported, so a rerun picks up
// where they stopped instead of importing things twice.
const PROGRESS_PREF = "zen.arc-import.progress";
const progress = JSON.parse(
  Services.prefs.getStringPref(PROGRESS_PREF, "{}") || "{}"
);
progress.profiles ??= [];
progress.cookies ??= [];
function saveProgress() {
  Services.prefs.setStringPref(PROGRESS_PREF, JSON.stringify(progress));
}

function logError(where, ex) {
  report.errors.push(`${where}: ${ex?.message ?? ex}`);
}

async function arcProfiles(userData) {
  const localState = await IOUtils.readJSON(
    PathUtils.join(userData, "Local State")
  );
  const cache = localState?.profile?.info_cache ?? {};
  return Object.entries(cache)
    .filter(([, info]) => info?.name !== ARC_SYSTEM_PROFILE)
    .map(([dir, info]) => ({ dir, name: info.name || dir }));
}

function ensureContainer(name, index) {
  const existing = ContextualIdentityService.getPublicIdentities().find(
    identity =>
      (identity.name ??
        ContextualIdentityService.getUserContextLabel(identity.userContextId)) ===
      name
  );
  if (existing) {
    return existing.userContextId;
  }
  const identity = ContextualIdentityService.create(
    name,
    "fingerprint",
    CONTAINER_COLORS[index % CONTAINER_COLORS.length]
  );
  return identity.userContextId;
}

// Section: cookies

async function cookieKey() {
  const keychain = Cc[
    "@mozilla.org/profile/migrator/keychainmigrationutils;1"
  ].getService(Ci.nsIKeychainMigrationUtils);
  const passphrase = keychain.getGenericPassword("Arc Safe Storage", "Arc");
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("saltysalt"),
      iterations: 1003,
      hash: "SHA-1",
    },
    baseKey,
    { name: "AES-CBC", length: 128 },
    false,
    ["decrypt"]
  );
}

async function decryptValue(key, blob, stripsHostHash) {
  const bytes = new Uint8Array(blob);
  const prefix = String.fromCharCode(...bytes.slice(0, 3));
  if (prefix !== "v10") {
    throw new Error(`unsupported cookie encryption ${prefix}`);
  }
  let plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: new Uint8Array(16).fill(0x20) },
      key,
      bytes.slice(3)
    )
  );
  if (stripsHostHash) {
    // Since database version 24, the value is prefixed with the SHA-256 of
    // the cookie's domain.
    plain = plain.slice(32);
  }
  return new TextDecoder().decode(plain);
}

function chromiumTimeToMs(value) {
  const us = BigInt(value);
  if (us <= CHROMIUM_EPOCH_OFFSET_US) {
    return 0;
  }
  return Number((us - CHROMIUM_EPOCH_OFFSET_US) / 1000n);
}

const SAMESITE = {
  "-1": Ci.nsICookie.SAMESITE_UNSET,
  0: Ci.nsICookie.SAMESITE_NONE,
  1: Ci.nsICookie.SAMESITE_LAX,
  2: Ci.nsICookie.SAMESITE_STRICT,
};

function partitionKeyFor(topFrameSite) {
  try {
    const url = new URL(topFrameSite);
    return `(${url.protocol.slice(0, -1)},${url.hostname})`;
  } catch {
    return null;
  }
}

async function importCookies(key, profileDir, userContextId) {
  const source = PathUtils.join(profileDir, "Cookies");
  if (!(await IOUtils.exists(source))) {
    return { imported: 0, skipped: 0 };
  }
  // Arc may be running and holding the database: work on a copy.
  const copy = PathUtils.join(
    PathUtils.tempDir,
    `arc-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );
  await IOUtils.copy(source, copy);
  const journal = source + "-journal";
  if (await IOUtils.exists(journal)) {
    await IOUtils.copy(journal, copy + "-journal");
  }
  let imported = 0;
  let skipped = 0;
  const db = await Sqlite.openConnection({ path: copy, readOnly: true });
  try {
    const [meta] = await db.execute(
      "SELECT value FROM meta WHERE key = 'version'"
    );
    const stripsHostHash =
      parseInt(meta?.getResultByName("value") ?? "0", 10) >= 24;
    const rows = await db.execute(
      `SELECT host_key, top_frame_site_key, name, value, encrypted_value, path,
              CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly,
              samesite, is_persistent, has_expires
       FROM cookies`
    );
    const now = Date.now();
    for (const row of rows) {
      const host = row.getResultByName("host_key");
      const name = row.getResultByName("name");
      try {
        let value = row.getResultByName("value");
        const encrypted = row.getResultByName("encrypted_value");
        if (!value && encrypted?.length) {
          value = await decryptValue(key, encrypted, stripsHostHash);
        }
        const persistent = !!row.getResultByName("is_persistent");
        let expiry = persistent
          ? chromiumTimeToMs(row.getResultByName("expires_utc"))
          : now + SESSION_COOKIE_LIFETIME_MS;
        if (persistent && expiry && expiry <= now) {
          skipped++;
          continue;
        }
        if (!expiry) {
          expiry = now + SESSION_COOKIE_LIFETIME_MS;
        }
        const secure = !!row.getResultByName("is_secure");
        const originAttributes = { userContextId };
        const topFrameSite = row.getResultByName("top_frame_site_key");
        const partitionKey = topFrameSite ? partitionKeyFor(topFrameSite) : null;
        if (partitionKey) {
          originAttributes.partitionKey = partitionKey;
        }
        const validation = Services.cookies.add(
          host,
          row.getResultByName("path") || "/",
          name,
          value ?? "",
          secure,
          !!row.getResultByName("is_httponly"),
          false,
          expiry,
          originAttributes,
          SAMESITE[row.getResultByName("samesite")] ??
            Ci.nsICookie.SAMESITE_UNSET,
          secure
            ? Ci.nsICookie.SCHEME_HTTPS
            : Ci.nsICookie.SCHEME_HTTP | Ci.nsICookie.SCHEME_HTTPS,
          !!partitionKey
        );
        if (
          validation &&
          validation.result !== Ci.nsICookieValidation.eOK
        ) {
          skipped++;
          continue;
        }
        imported++;
      } catch (ex) {
        skipped++;
        if (report.errors.length < 50) {
          logError(`cookie ${name}@${host}`, ex);
        }
      }
    }
  } finally {
    await db.close();
    await IOUtils.remove(copy, { ignoreAbsent: true });
    await IOUtils.remove(copy + "-journal", { ignoreAbsent: true });
  }
  return { imported, skipped };
}

// Section: everything else

async function importProfileData(migrator, profile) {
  const types = MigrationUtils.resourceTypes;
  let items =
    types.HISTORY |
    types.PASSWORDS |
    types.FORMDATA |
    types.BOOKMARKS |
    types.PAYMENT_METHODS;
  const available = await migrator.getMigrateData(profile);
  items &= available;
  if (!items) {
    return;
  }
  await migrator.migrate(items, false, profile);
}

(async () => {
  const userData = PathUtils.join(arcRoot, "User Data");

  // The keychain is asked first, once: with "Always Allow", the migrator's
  // own requests for the same item go through without asking again.
  let key = null;
  try {
    key = await cookieKey();
  } catch (ex) {
    logError("keychain", ex);
  }

  // A full import: all of history, not only recent pages.
  Services.prefs.setIntPref("browser.migrate.chrome.history.limit", 0);
  Services.prefs.setIntPref("browser.migrate.history.maxAgeInDays", 36500);
  Services.prefs.setBoolPref(
    "browser.migrate.chrome.payment_methods.enabled",
    true
  );
  // Arc's bookmarks are its sidebar, which is imported as spaces below.
  Services.prefs.setBoolPref(
    "zen.migration.bookmarks-as-pinned-folders",
    false
  );
  Services.prefs.setBoolPref("privacy.userContext.enabled", true);
  Services.prefs.setBoolPref("privacy.userContext.ui.enabled", true);

  const profiles = await arcProfiles(userData);
  const sidebar = await IOUtils.readJSON(
    PathUtils.join(arcRoot, "StorableSidebar.json")
  );
  const plan = ZenMigrationUtils.parseArcSidebar(sidebar);
  const mainProfile = plan.spaces[0]?.profile ?? "Default";

  // Containers, one per Arc profile.
  const containerFor = new Map();
  let colorIndex = 0;
  for (const profile of profiles) {
    if (profile.dir === mainProfile) {
      containerFor.set(profile.dir, 0);
      report.containers[profile.name] = 0;
      continue;
    }
    const id = ensureContainer(profile.name, colorIndex++);
    containerFor.set(profile.dir, id);
    report.containers[profile.name] = id;
  }

  // History, passwords, form data and payment cards.
  const migrator = await MigrationUtils.getMigrator("arc");
  const sourceProfiles = (await migrator.getSourceProfiles()) ?? [];
  for (const profile of profiles) {
    const source = sourceProfiles.find(p => p.id === profile.dir);
    const entry = (report.profiles[profile.name] = {});
    if (!source) {
      entry.migrator = "not offered";
      continue;
    }
    if (progress.profiles.includes(profile.dir)) {
      entry.migrator = "already imported";
      continue;
    }
    try {
      await importProfileData(migrator, source);
      entry.migrator = "ok";
      progress.profiles.push(profile.dir);
      saveProgress();
    } catch (ex) {
      entry.migrator = "failed";
      logError(`migrator ${profile.name}`, ex);
    }
  }

  // Cookies.
  if (key) {
    for (const profile of profiles) {
      if (progress.cookies.includes(profile.dir)) {
        report.profiles[profile.name].cookies = "already imported";
        continue;
      }
      try {
        report.profiles[profile.name].cookies = await importCookies(
          key,
          PathUtils.join(userData, profile.dir),
          containerFor.get(profile.dir) ?? 0
        );
        progress.cookies.push(profile.dir);
        saveProgress();
      } catch (ex) {
        logError(`cookies ${profile.name}`, ex);
      }
    }
  }

  // Spaces, each in its profile's container.
  if (options.spaces && !progress.spaces) {
    for (const space of plan.spaces) {
      space.userContextId = containerFor.get(space.profile ?? mainProfile) ?? 0;
    }
    try {
      report.spaces = await ZenMigrationUtils.applyArcSidebar(plan);
      progress.spaces = true;
      saveProgress();
    } catch (ex) {
      logError("spaces", ex);
    }
  }

  const history = await (
    await PlacesUtils.promiseDBConnection()
  ).execute("SELECT COUNT(*) AS n FROM moz_places");
  report.historyEntries = history[0].getResultByName("n");
  report.logins = (await Services.logins.getAllLogins()).length;
  report.cookies = Services.cookies.cookies.length;
  report.containerCount =
    ContextualIdentityService.getPublicIdentities().length;
  report.spaceNames = window.gZenWorkspaces
    .getWorkspaces()
    .map(space => `${space.name} [container ${space.containerTabId ?? 0}]`);
  return report;
})().then(done, ex => {
  logError("import", ex);
  done(report);
});
