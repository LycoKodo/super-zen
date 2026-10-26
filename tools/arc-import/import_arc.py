#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Imports Arc's profiles, spaces, history, passwords and cookies into a Zen
build. See import_arc.js for what is imported and how.

Quit the browser first. macOS asks once for access to "Arc Safe Storage" in
the keychain: choose "Always Allow".

    python3 tools/arc-import/import_arc.py --app "/Applications/Super Zen.app"
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from marionette import Marionette  # noqa: E402

HERE = Path(__file__).parent
ARC_ROOT = Path.home() / "Library/Application Support/Arc"
PORT = 2828  # Marionette's default.


def launch(app, profile=None):
    binary = next((Path(app) / "Contents/MacOS").glob("zen"))
    args = [str(binary), "--marionette", "--remote-allow-system-access", "-no-remote"]
    if profile:
        args += ["-profile", profile]
    # Chrome-privileged scripts need system access.
    env = dict(os.environ, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1")
    return subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def connect():
    client = Marionette(port=PORT, timeout=90)
    client.connect()
    return client


def wait_for_exit(proc, timeout=60):
    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        proc.terminate()
        proc.wait(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", default="/Applications/Super Zen.app")
    parser.add_argument("--profile", help="Profile directory (defaults to the app's default profile)")
    parser.add_argument("--no-spaces", action="store_true", help="Skip importing Arc's sidebar")
    parser.add_argument("--extensions", action="store_true", help="Also install Firefox versions of Arc extensions")
    opts = parser.parse_args()

    if not (ARC_ROOT / "User Data").exists():
        sys.exit(f"No Arc data found in {ARC_ROOT}")

    # A first run settles the profile and the welcome screen, so the import
    # doesn't race with first-run setup.
    proc = launch(opts.app, opts.profile)
    client = connect()
    client.execute_async(
        """
        const done = arguments[arguments.length - 1];
        Services.prefs.setBoolPref("zen.welcome-screen.seen", true);
        done(Services.dirsvc.get("ProfD", Ci.nsIFile).path);
        """
    )
    client.quit()
    wait_for_exit(proc)
    time.sleep(2)

    proc = launch(opts.app, opts.profile)
    client = connect()
    script = (HERE / "import_arc.js").read_text()
    print("Importing from Arc. If macOS asks about \"Arc Safe Storage\", choose Always Allow...")
    started = time.time()
    report = client.execute_async(
        script,
        [str(ARC_ROOT), {"spaces": not opts.no_spaces, "extensions": opts.extensions}],
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"Done in {time.time() - started:.0f}s")
    # Let the session store write the new spaces and tabs before quitting.
    time.sleep(5)
    client.quit()
    wait_for_exit(proc)


if __name__ == "__main__":
    main()
