#!/usr/bin/env node
"use strict";

// zed-android CLI entry point. Keep this file tiny: the real logic lives in lib/.
const { main } = require("../lib/cli.js");

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`zed-android: internal error: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
