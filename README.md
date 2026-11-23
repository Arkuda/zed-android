# zed-android

Android integration for [Zed](https://zed.dev): separate emulator window, Gradle
application/variant selection, build, run, and Kotlin/Java (JDWP) debugging through
Zed's DAP support. All heavy lifting happens in an external `zed-android` CLI
(Node.js, `tools/`); the Zed extension (WASM, `src/`) only registers the
`Android` debug adapter and shells out to that CLI. Nothing is ever written into
your Android projects — state lives in `$ZED_ANDROID_STATE_DIR`
(`%LOCALAPPDATA%/zed-android` by default).

## Requirements

- JDK 17+ and an Android SDK (platform-tools, an AVD) on the machine running Zed.
- Node.js 20+ with the CLI linked globally:
  `cd tools && npm install && npm link` → provides `zed-android` on PATH.
- **Zed must see `JAVA_HOME`, `ANDROID_HOME` (and `ANDROID_AVD_HOME` if non-default)
  in its environment.** Zed inherits the environment it was launched with; on
  Windows, either set them as user/system variables and restart Zed, or launch
  Zed from a shell that exports them.

## Tasks

After installing the extension, these workspace tasks are available (also wired
into `tasks.json` by the installer step):

- `Android: Select application` — pick module + build variant (interactive).
- `Android: Start emulator` — pick and boot an AVD.
- `Android: Build` — assemble the selected variant.
- `Android: Run` — install and launch on the selected device/emulator.

Cancelling a selection (`q`) exits with code 3 and persists nothing.

## Debugging

Press <kbd>F4</kbd> → **Android: Debug** (adds itself to `debug.json`). The
extension resolves the CLI via PATH, spawns `zed-android dap`, deploys the
selected variant, attaches JDWP, and bridges it to Zed's debugger UI. Set
breakpoints with <kbd>F9</kbd>; stop the session to force-stop the app and tear
down port forwards.

## Development install

A Zed dev extension must be a **git repository** containing `extension.toml`.

1. `cd tools && npm link` (once).
2. In Zed: `zed: install dev extension` → select this directory. If it was added
   before the repo existed, symlink instead:
   `<user-data>/extensions/installed/zed-android -> D:\path\to\this\repo`.
3. After source changes: `zed: rebuild dev extension` (compiles via
   `cargo build --target wasm32-wasip2`; requires the WASI target installed).

Manual smoke tests (device required): `node tools/scripts/dap-smoke.js <gradle-root>`
drives a full headless DAP session; `cd tools && npm test` runs unit tests.
