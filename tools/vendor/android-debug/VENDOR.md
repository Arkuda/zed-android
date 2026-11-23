# Vendored android-debug core

Source: `adelphes/android-dev-ext` (VS Code "Android" extension), MIT licensed
(`LICENSE`, Dave Holoway 2017). Copied verbatim at commit
`cb6c78070cf7fd9c431a9999518fac312ff26b5c`, then patched as listed below.

## Files copied (unmodified unless listed)

```
src/adbclient.js              src/debugger-types.js     src/stack-frame.js
src/debugger.js               src/jdwp.js               src/threads.js
src/expression/assign.js      src/utils/char-decode.js  src/variable-manager.js
src/sockets/adbsocket.js      src/utils/nbc.js          src/sockets/androidsocket.js
src/sockets/jdwpsocket.js     src/utils/print.js        src/utils/source-file.js
src/utils/thread.js           LICENSE
```

Not copied (extension-host / APK-parsing / analytics, not needed here):
`apk-file-info.js`, `package-searcher.js`, `utils/android.js`,
`expression/evaluate.js`, `langserver/analytics.js`.

## Deltas from upstream

1. **`src/debugMain.js` deleted, replaced by `src/zed-session.js`.**
   Upstream's DAP session depends on the extension host, APK manifest parsing,
   source-tree scanning and analytics; zed-session.js implements the same DAP
   surface (launch/threads/stack/scopes/variables/breakpoints/steps/exceptions)
   against the Gradle describe payload + Package Manager instead, with:
   - deploy through `lib/deploy.js` (Gradle `install<Variant>` + describe),
   - exact debuggable-PID wait (no "last enumerated pid" fallback),
   - terminal selection via DAP `runInTerminal`,
   - no expression evaluator (`evaluateRequest`/`setVariableRequest` report an
     honest unsupported failure).

2. **`src/utils/print.js`: all console output goes to stderr.** The DAP frame
   stream owns stdout; upstream's `console.log/warn/error` would corrupt it.

3. **`src/adbclient.js`: `forward_remove_all()` removed**, replaced by
   `forward_list()`, `forward_remove(localport)` and
   `find_forwarded_jdwp_port(jdwpid)`. `killforward-all` deleted port forwards
   owned by other tools (`adb reverse`, another IDE's debugger).

4. **`src/debugger.js`:**
   - `PortManager`/`static portManager` and `startDebugSession()` removed; the
     launch flow lives in zed-session.js. Host ports now come from adb itself:
     `jdwp_forward tcp:0` + `find_forwarded_jdwp_port` (no random-port guessing,
     no collisions).
   - `disconnect()` removes only its own forward (`forward_remove(localport)`).
   - `findBreakpointLocation()` → `findBreakpointLocations()`: returns **all**
     deduplicated matches; `initialiseBreakpoint`/`_onClassPrepared` register
     every location (lambdas and `Foo`/`FooKt` pairs share source lines).
   - breakpoint hit lookup matches any registered request id;
     `disableBreakpoints()` clears every JDWP request of a breakpoint.

5. **`src/debugger-types.js`:**
   - `BreakpointOptions.qtypes`: explicit candidate JVM type names per
     breakpoint, dropping the upstream assumption that the class name equals the
     source file basename (Kotlin top-level functions compile to `FooKt`).
   - `DebuggerBreakpoint.setEnabled()` accumulates `enabled.requests[]` so
     multi-location breakpoints can be enabled/disabled as one unit.

Conditional-breakpoint re-arming after a hitcount still only re-registers the
first location (upstream single-request logic kept; conditional breakpoints on
multi-location lines are approximate).
