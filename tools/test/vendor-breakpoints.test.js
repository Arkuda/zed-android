"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { Debugger } = require("../vendor/android-debug/src/debugger.js");
const {
  BreakpointOptions,
  DebuggerBreakpoint,
} = require("../vendor/android-debug/src/debugger-types.js");

function fakeClass(signature, typeid, methodid, linecodeidx, linenum) {
  return {
    type: { signature },
    info: { typeid },
    methods: [{ methodid, linetable: { lines: [{ linenum, linecodeidx }] } }],
  };
}

test("qtypes replaces the basename-equals-classname assumption", () => {
  const options = new BreakpointOptions();
  options.qtypes = ["dev/pkg/MainActivity", "dev/pkg/MainActivityKt"];
  const bp = new DebuggerBreakpoint("/dev/pkg/MainActivity.java", 58, options);

  assert.ok(bp.sigpattern.test("Ldev/pkg/MainActivity;"));
  assert.ok(bp.sigpattern.test("Ldev/pkg/MainActivityKt;")); // Kotlin file facade
  assert.ok(bp.sigpattern.test("Ldev/pkg/MainActivity$1;")); // anonymous inner
  assert.ok(bp.sigpattern.test("Ldev/pkg/MainActivityKt$onCreate$1;")); // lambda in facade
  assert.ok(!bp.sigpattern.test("Ldev/pkg/MainActivityOther;")); // prefix must not leak
  assert.ok(!bp.sigpattern.test("Lcom/other/MainActivity;"));
});

test("without qtypes the upstream basename pattern is kept", () => {
  const bp = new DebuggerBreakpoint("/dev/pkg/Foo.java", 10, new BreakpointOptions());
  assert.ok(bp.sigpattern.test("Ldev/pkg/Foo;"));
  assert.ok(!bp.sigpattern.test("Ldev/pkg/FooKt;"));
});

test("findBreakpointLocations returns every class/method/line match, deduplicated", () => {
  const options = new BreakpointOptions();
  options.qtypes = ["dev/pkg/Probe", "dev/pkg/ProbeKt"];
  const bp = new DebuggerBreakpoint("/dev/pkg/Probe.java", 21, options);

  const classes = [
    // top-level class method and the Kt facade both carry line 21
    fakeClass("Ldev/pkg/Probe;", "T1", "M1", "000A", 21),
    fakeClass("Ldev/pkg/ProbeKt;", "T2", "M2", "000B", 21),
    // lambda inside the facade, same line, different method
    fakeClass("Ldev/pkg/ProbeKt$run$1;", "T2", "M3", "000C", 21),
    // duplicate enumeration of an already-seen location
    fakeClass("Ldev/pkg/ProbeKt;", "T2", "M2", "000B", 21),
    // non-matching class and non-matching line must be ignored
    fakeClass("Lcom/other/Probe;", "T9", "M9", "000D", 21),
    fakeClass("Ldev/pkg/Probe;", "T1", "M1", "000E", 22),
  ];

  const locs = Debugger.findBreakpointLocations(classes, bp);
  assert.strictEqual(locs.length, 3);
  const cmls = locs.map((l) => `${l.c.info.typeid}:${l.m.methodid}:${l.l}`);
  assert.deepStrictEqual(
    [...new Set(cmls)],
    ["T1:M1:000A", "T2:M2:000B", "T2:M3:000C"],
  );
});

test("setEnabled accumulates one request per location for multi-location breakpoints", () => {
  const options = new BreakpointOptions();
  options.qtypes = ["dev/pkg/Probe", "dev/pkg/ProbeKt"];
  const bp = new DebuggerBreakpoint("/dev/pkg/Probe.java", 21, options);

  const clsA = fakeClass("Ldev/pkg/Probe;", "T1", "M1", "000A", 21);
  const clsB = fakeClass("Ldev/pkg/ProbeKt;", "T2", "M2", "000B", 21);
  bp.setEnabled({ c: clsA, m: clsA.methods[0], l: "000A" }, 7);
  bp.setEnabled({ c: clsB, m: clsB.methods[0], l: "000B" }, 8);

  assert.strictEqual(bp.enabled.requests.length, 2);
  assert.deepStrictEqual(bp.enabled.requests.map((r) => r.requestid), [7, 8]);
  // legacy single-request fields still point at the first location
  assert.strictEqual(bp.enabled.requestid, 7);
  assert.strictEqual(bp.enabled.cml, "T1:M1:000A");
});
