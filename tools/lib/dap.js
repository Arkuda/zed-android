"use strict";

// `zed-android dap`: DAP server on stdio, started by Zed through the extension
// (get_dap_binary resolves node + this package's bin). All selection UI during
// a debug launch happens in an integrated terminal spawned via runInTerminal;
// see zed-session.js for the session logic.

function runDap() {
  const { DebugSession } = require("@vscode/debugadapter");
  const { ZedAndroidDebugSession } = require("../vendor/android-debug/src/zed-session.js");
  DebugSession.run(ZedAndroidDebugSession);
  // run() keeps the process alive on stdio; exit cleanly when the client
  // closes the connection (Zed terminates the adapter after the session ends)
  return new Promise((resolve) => {
    process.stdin.once("end", () => resolve(0));
  });
}

module.exports = { runDap };
