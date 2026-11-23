"use strict";

// Terminal menus (plain tasks) and the DAP runInTerminal pick handshake.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const { atomicWrite } = require("./paths.js");

/** Thrown when the user aborts a selection; callers must leave state untouched. */
class Cancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "Cancelled";
    this.cancelled = true;
  }
}

function printMenu(prompt, items) {
  const lines = [prompt];
  items.forEach((item, i) => {
    lines.push(`  ${i + 1}. ${item.label}${item.current ? "   <- current" : ""}`);
  });
  lines.push("  q. cancel");
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Numbered menu on a TTY. Returns the chosen index or null on cancel
 * (`q`, EOF, Ctrl-C). Throws when stdin is not interactive.
 */
async function menu({ prompt, items }) {
  if (!process.stdin.isTTY) {
    throw new Error(
      "selection needs an interactive terminal; run it through the Zed task (task: spawn)",
    );
  }
  printMenu(prompt, items);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C / closed terminal: close the interface so the pending question
  // settles and we report a cancellation instead of hanging or crashing.
  process.once("SIGINT", () => {
    process.stdout.write("\n");
    rl.close();
  });
  try {
    for (;;) {
      let answer;
      try {
        answer = await rl.question("> ");
      } catch (err) {
        if (err && (err.code === "ERR_READLINE_CLOSE" || err.name === "AbortError")) return null;
        throw err;
      }
      if (answer === undefined || answer === null) return null; // EOF
      answer = answer.trim();
      if (/^q$/i.test(answer)) return null;
      if (answer === "") continue; // bare Enter: ask again rather than act
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= items.length && `${n}` === answer) return n - 1;
      process.stdout.write(`enter a number 1..${items.length} or q to cancel\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * DAP `runInTerminal` helper: read the pick request written by the adapter,
 * show the same menu, then atomically publish the opaque id (or cancellation)
 * as response.json next to the request file. One directory per request.
 */
async function runPick(requestFile) {
  let result;
  try {
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new Error("pick request has no items");
    }
    const index = await menu({ prompt: request.prompt ?? "Select", items: request.items });
    result =
      index === null
        ? { kind: "cancel" }
        : { kind: "choice", id: request.items[index].id };
  } catch (err) {
    if (err && err.cancelled) {
      result = { kind: "cancel" };
    } else {
      result = { kind: "error", message: String(err?.message ?? err) };
    }
  }
  atomicWrite(path.join(path.dirname(path.resolve(requestFile)), "response.json"), `${JSON.stringify(result)}\n`);
  return result.kind === "error" ? 1 : 0;
}

module.exports = { menu, runPick, Cancelled, printMenu };
