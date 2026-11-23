"use strict";

// zed-android DAP session - replaces the vendored debugMain.js (see VENDOR.md).
// Everything upstream needed from launch.json/apk-file-info/package-searcher is
// resolved here through the shared CLI libs: Gradle deploy for the selected
// target, Package Manager for the launcher activity, and the AGP describe
// payload for the source-file index. No APK parsing, no analytics, no console
// output on stdout (the DAP stream owns it).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  OutputEvent,
  ThreadEvent,
  BreakpointEvent,
  StackFrame,
  Source,
  Scope,
  Thread,
  Breakpoint,
} = require("@vscode/debugadapter");

const { Debugger } = require("./debugger.js");
const { ADBClient } = require("./adbclient.js");
const { LaunchBuildInfo, BreakpointOptions, DebuggerException } = require("./debugger-types.js");
const { AndroidThread } = require("./threads.js");

const { findSdk, adbPath } = require("../../../lib/sdk.js");
const { resolveSerial } = require("../../../lib/device.js");
const { resolveTarget } = require("../../../lib/target.js");
const { deploy } = require("../../../lib/deploy.js");
const { resolveComponent } = require("../../../lib/launcher.js");
const { FileIndex } = require("../../../lib/fileindex.js");
const { targetFile, readJsonFile } = require("../../../lib/paths.js");

const PID_WAIT_MS = 30_000;
const PICK_WAIT_MS = 300_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * JDWP commands have no timeout upstream: if the app dies mid-command the
 * reply never arrives and any await on it hangs forever. Session teardown
 * must respond to the client regardless, so cleanup steps are bounded here.
 */
function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise.catch((err) => err), guard])
    .then((r) => {
      if (r === "timeout") {
        process.stderr.write(`zed-android dap: teardown ${JSON.stringify(what)} did not finish within ${ms / 1000}s\n`);
      } else if (r instanceof Error) {
        throw r;
      }
    })
    .finally(() => clearTimeout(timer));
}

class ZedAndroidDebugSession extends DebugSession {
  constructor() {
    super();
    this.dbgr = new Debugger();
    this.root = process.cwd(); // Zed starts the adapter with cwd = worktree root
    this.trace = false;
    this._threads = [];
    this._breakpointId = 0;
    this._isDisconnecting = false;
    this.debuggerAttached = false;
    this.startedAppId = null; // set right before `am start -D`, used for cleanup
    this.serial = null;
    this.index = null;
    this.configurationDone = new Promise((resolve) => {
      this._configurationDoneResolve = resolve;
    });
  }

  // ---------------------------------------------------------------- logging

  LOG(msg) {
    if (!this.trace) process.stderr.write(`${msg}\n`);
    this.sendEvent(new OutputEvent(`${msg}${os.EOL}`));
  }

  WARN(msg) {
    msg = `Warning: ${msg}`;
    if (!this.trace) process.stderr.write(`${msg}\n`);
    this.sendEvent(new OutputEvent(`${msg}${os.EOL}`));
  }

  // ------------------------------------------------- terminal pick protocol

  /**
   * Selection UI for DAP mode: spawns `zed-android pick <request.json>` in an
   * integrated terminal via the client's runInTerminal support, then polls for
   * the response file. Returns a menu index or null on cancel - callers decide
   * their own cancellation messages.
   */
  async pick({ prompt, items }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-android-pick-"));
    try {
      const requestFile = path.join(dir, "request.json");
      fs.writeFileSync(
        requestFile,
        JSON.stringify({
          prompt,
          items: items.map((it, i) => ({ id: String(i), label: it.label, current: !!it.current })),
        }),
      );
      const bin = path.join(__dirname, "..", "..", "..", "bin", "zed-android.cjs");
      if (!fs.existsSync(bin)) throw new Error(`picker entry not found: ${bin}`);
      const response = await new Promise((resolve) => {
        this.sendRequest(
          "runInTerminal",
          {
            kind: "integrated",
            title: "zed-android",
            cwd: this.root,
            args: [process.execPath, bin, "pick", requestFile],
            env: process.env,
          },
          30_000,
          resolve,
        );
      });
      if (!response || response.success === false) {
        throw new Error(
          "Zed could not open an integrated terminal for the selection " +
            "(runInTerminal unsupported or refused); run the Android: Select application task instead",
        );
      }
      const responseFile = path.join(dir, "response.json");
      const deadline = Date.now() + PICK_WAIT_MS;
      for (;;) {
        let result = null;
        try {
          result = JSON.parse(fs.readFileSync(responseFile, "utf8"));
        } catch (err) {
          if (!err || err.code !== "ENOENT") throw err;
        }
        if (result) {
          if (result.kind === "choice") {
            const idx = Number.parseInt(result.id, 10);
            return Number.isInteger(idx) && idx >= 0 && idx < items.length ? idx : null;
          }
          if (result.kind === "cancel") return null;
          throw new Error(result.message || "selection failed");
        }
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for the terminal selection");
        }
        await sleep(250);
      }
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // ---------------------------------------------------------------- launch

  async initializeRequest(response) {
    response.body.exceptionBreakpointFilters = [
      { label: "All Exceptions", filter: "all", default: false },
      { label: "Uncaught Exceptions", filter: "uncaught", default: true },
    ];
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsExceptionInfoRequest = true;
    response.body.supportsHitConditionalBreakpoints = true;
    // zed-android delta: no expression evaluator / setVariable yet - capabilities
    // stay false so Zed shows the honest UI instead of failing every watch.
    this.sendResponse(response);
  }

  async launchRequest(response, args) {
    if (args && args.trace) this.trace = true;
    try {
      await this.performLaunch();

      // connection is up and the app is suspended at startup: exchange the
      // initialize/configured handshake before letting it run.
      this.sendEvent(new InitializedEvent());
      await this.configurationDone;
      await this.dbgr.setThreadNotify();
      this.sendResponse(response);
      this.LOG("Application started");
      await this.dbgr.resume();
    } catch (err) {
      const msg = err?.message ?? String(err);
      this.LOG(`Launch failed: ${msg}`);
      if (err && err.cancelled) {
        this.LOG("Selection cancelled; previous target and device were left untouched.");
      }
      try {
        if (this.dbgr.status() !== "disconnected") {
          await withTimeout(this.dbgr.disconnect(), 3_000, "jdwp disconnect after failed launch");
        }
      } catch {
        /* best effort */
      }
      // a pending launch that already started the app must not leave it running
      // behind a dead debugger
      try {
        if (this.startedAppId && !this.debuggerAttached) {
          await withTimeout(Debugger.forceStopApp(this.serial, this.startedAppId), 3_000, "am force-stop");
        }
      } catch {
        /* best effort */
      }
      response.success = false;
      response.message = msg;
      this.sendResponse(response);
      this.sendEvent(new TerminatedEvent(false));
    }
  }

  async performLaunch() {
    const root = this.root;
    const ask = (menuArgs) => this.pick(menuArgs);
    const log = (msg) => this.LOG(msg);

    // 1. module/variant (debug mode: debuggable variants only, never persisted)
    const target = await resolveTarget({ root, mode: "debug", persist: false, log, ask });
    this.LOG(`debugging ${target.module} / ${target.variant} (${target.applicationId})`);

    // 2. device
    const { sdkDir } = findSdk(root);
    const { serial } = await resolveSerial({ sdkDir, projectRoot: root, log, ask });
    this.serial = serial;
    const adbExe = adbPath(sdkDir);

    // 3. build + install + describe (single Gradle invocation)
    const info = await deploy({ root, target, serial, log });
    this.index = new FileIndex(info);

    // 4. launcher activity (revalidated against Package Manager; not persisted)
    const launcher = await resolveComponent({
      root,
      adbExe,
      serial,
      applicationId: target.applicationId,
      log,
      ask,
      persist: false,
    });

    // 5. start the activity with the app process waiting for a debugger.
    // The process name override belongs to the saved pair; debug never rewrites
    // target.json, so read it from there if present.
    const saved = readJsonFile(targetFile(root)).value;
    const processName =
      (saved && saved.module === target.module && saved.variant === target.variant && saved.processName) ||
      target.applicationId;

    const build = new LaunchBuildInfo(
      new Map(),
      target.applicationId,
      launcher.component.slice(launcher.component.indexOf("/") + 1),
      [
        "-S", // stop the old instance first: guarantees a fresh onCreate for singleTask apps
        "-D", // start waiting for the debugger
        "--user", "current",
        "-a", "android.intent.action.MAIN",
        "-c", launcher.category,
        "-n", launcher.component,
      ],
      500,
    );

    this.LOG(`starting ${launcher.component} on ${serial}`);
    this.startedAppId = target.applicationId;
    const am_stdout = await Debugger.runApp(serial, build.startCommandArgs, build.postLaunchPause);
    if (am_stdout) this.LOG(am_stdout);

    // 6. wait for the exact debuggable process - no "last pid" guessing
    const pid = await ZedAndroidDebugSession.waitForDebuggablePid(serial, processName);
    this.LOG(`attaching to pid ${pid} (${processName})`);

    // 7. JDWP handshake while the app is suspended at startup
    await this.dbgr.attachToProcess(build, pid, serial);
    this.debuggerAttached = true;

    this.dbgr
      .on("bpstatechange", (e) => this.onBreakpointStateChange(e))
      .on("bphit", (e) => this.reportStoppedEvent("breakpoint", e.stoppedLocation))
      .on("step", (e) => this.reportStoppedEvent("step", e.stoppedLocation))
      .on("exception", (e) => this.onException(e))
      .on("threadchange", (e) => this.onThreadChange(e))
      .on("disconnect", () => {
        if (!this._isDisconnecting) {
          this.LOG("Device disconnected");
          this.sendEvent(new TerminatedEvent(false));
        }
      });
  }

  /**
   * Poll the JDWP process list until a debuggable process with exactly this
   * name appears (the -D flag keeps it parked at startup). Upstream's fallback
   * to "last enumerated pid" is deliberately gone: wrong-pid attach is worse
   * than a clear timeout.
   */
  static async waitForDebuggablePid(serial, processName, budgetMs = PID_WAIT_MS) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let procs = [];
      try {
        procs = await new ADBClient(serial).named_jdwp_list(2000);
      } catch (err) {
        if (Date.now() >= deadline) throw err;
      }
      const hit = procs.find((p) => p.name === processName);
      if (hit) return hit.pid;
      if (Date.now() >= deadline) {
        const seen = procs.length ? `debuggable processes: ${procs.map((p) => `${p.name ?? "?"}(${p.pid})`).join(", ")}` : "no debuggable processes at all";
        throw new Error(
          `the app started but no debuggable process named ${JSON.stringify(processName)} appeared within ${budgetMs / 1000}s (${seen}); ` +
            "if the app uses android:process or a custom applicationId suffix, record the real name with: zed-android select",
        );
      }
      await sleep(500);
    }
  }

  configurationDoneRequest(response) {
    this._configurationDoneResolve();
    this.sendResponse(response);
  }

  async disconnectRequest(response) {
    this._isDisconnecting = true;
    if (this.debuggerAttached) {
      try {
        await withTimeout(this.dbgr.forceStop(), 3_000, "am force-stop"); // app + its JDWP socket die
      } catch {
        /* best effort */
      }
      try {
        // idempotent; guarantees our tcp forward is removed even if the socket
        // survived the force-stop
        await withTimeout(this.dbgr.disconnect(), 3_000, "jdwp disconnect");
      } catch {
        /* best effort */
      }
    } else if (this.startedAppId && this.serial) {
      try {
        await withTimeout(Debugger.forceStopApp(this.serial, this.startedAppId), 3_000, "am force-stop");
      } catch {
        /* best effort */
      }
    }
    this.sendResponse(response);
  }

  // ------------------------------------------------------------ breakpoints

  async setBreakPointsRequest(response, args) {
    const sourcePath = args.source && args.source.path;
    const sendBPResponse = (breakpoints) => {
      response.body = { breakpoints };
      this.sendResponse(response);
    };

    const cand = this.index ? this.index.candidates(sourcePath) : null;
    if (!cand) {
      sendBPResponse(
        args.breakpoints.map((bp) => {
          const b = new Breakpoint(false, bp.line);
          b.id = ++this._breakpointId;
          b.message =
            "not a Kotlin/Java source file inside the deployed variant's source roots";
          return b;
        }),
      );
      return;
    }

    // drop breakpoints of this file that are no longer requested
    const lines = args.breakpoints.map((bp) => bp.line);
    const deleted = this.dbgr.findBreakpoints(
      (javabp) => javabp.srcfpn === cand.srcfpn && !lines.includes(javabp.linenum),
    );
    deleted.forEach((bp) => (bp.vsbp = null));
    this.dbgr.removeBreakpoints(deleted);

    const out = [];
    for (let idx = 0; idx < args.breakpoints.length; idx++) {
      const src_bp = args.breakpoints[idx];
      const options = new BreakpointOptions();
      if (src_bp.hitCondition) {
        const m = /^\s*(?:0x([0-9a-f]+)|0b([01]+)|0*(\d+(?:e\+?\d+)?))\s*$/i.exec(src_bp.hitCondition);
        if (m) {
          const hitcount = m[3] ? parseFloat(m[3]) : m[2] ? parseInt(m[2], 2) : parseInt(m[1], 16);
          if (hitcount > 0 && hitcount <= 0x7fffffff) options.hitcount = hitcount;
        }
      }
      options.qtypes = cand.qtypes;
      const javabp = await this.dbgr.setBreakpoint(cand.srcfpn, src_bp.line, options);
      if (!javabp.vsbp) {
        const verified = /set|enabled/.test(javabp.state);
        const bp = new Breakpoint(verified, javabp.linenum);
        bp.id = ++this._breakpointId;
        if (javabp.state === "notloaded") bp.message = "the runtime hasn't loaded this code location";
        javabp.vsbp = bp;
      }
      javabp.vsbp.order = idx;
      out.push(javabp.vsbp);
    }
    sendBPResponse(out);
  }

  async setExceptionBreakPointsRequest(response, args) {
    try {
      await this.dbgr.clearBreakOnExceptions();
      if (args.filters.includes("all")) {
        await this.dbgr.setBreakOnExceptions("both");
      } else if (args.filters.includes("uncaught")) {
        await this.dbgr.setBreakOnExceptions("uncaught");
      }
    } catch (err) {
      response.success = false;
      response.message = err?.message ?? String(err);
    }
    this.sendResponse(response);
  }

  onBreakpointStateChange(e) {
    e.breakpoints.forEach((javabp) => {
      if (!javabp.vsbp) return; // deleted breakpoint, no client entry to update
      javabp.vsbp.verified = /set|enabled/.test(javabp.state);
      javabp.vsbp.message = javabp.state === "notloaded" ? "the runtime hasn't loaded this code location" : null;
      this.sendEvent(new BreakpointEvent("changed", javabp.vsbp));
    });
  }

  // ---------------------------------------------------------- threads/state

  getThread(id, name) {
    let thread;
    switch (typeof id) {
      case "string":
        thread = this._threads.find((t) => t && t.threadid === id);
        if (!thread) {
          thread = new AndroidThread(this.dbgr, name, id);
          this._threads[thread.vscode_threadid] = thread;
        }
        break;
      case "number":
        thread = this._threads[id];
        break;
    }
    return thread;
  }

  async refreshThreads() {
    const thread_ids = await this.dbgr.getJavaThreadIDs();
    const threadinfos = await this.dbgr.getJavaThreadInfos(thread_ids);

    threadinfos.forEach((threadinfo) => {
      const thread = this.getThread(threadinfo.threadid);
      if (typeof thread.name !== "string") {
        thread.name = threadinfo.name;
      } else if (thread.name !== threadinfo.name) {
        // a renamed thread gets a new DAP id (old variable references die)
        delete this._threads[thread.vscode_threadid];
        thread.allocateNewThreadID();
        this._threads[thread.vscode_threadid] = thread;
        thread.name = threadinfo.name;
      }
    });

    this._threads.slice().forEach((thread) => {
      if (thread && !threadinfos.find((ti) => ti.threadid === thread.threadid)) {
        delete this._threads[thread.vscode_threadid];
      }
    });
  }

  /** @param {'breakpoint'|'step'|'exception'} reason */
  reportStoppedEvent(reason, location, last_exception = null) {
    const thread = this.getThread(location.threadid);
    if (thread.paused) {
      thread.paused.reasons.push(reason);
      if (last_exception) thread.paused.last_exception = last_exception;
      return;
    }
    thread.setPaused(reason, location, last_exception);
    this.checkPendingThreadBreaks();
  }

  checkPendingThreadBreaks() {
    const stepping_thread = this._threads.find((t) => t && t.stepTimeout);
    const paused_threads = this._threads.filter((t) => t && t.paused);
    const stopped_thread = paused_threads.find((t) => t.paused.stoppedEvent);
    if (stopped_thread || stepping_thread || !paused_threads.length) return;

    let thread;
    const paused_step_thread = paused_threads.find((t) => t.paused.reasons.includes("step"));
    if (paused_step_thread) {
      thread = paused_step_thread;
    } else {
      paused_threads.sort((a, b) => a.paused.when - b.paused.when);
      thread = paused_threads[0];
    }
    // breakpoint removed while we were stopping on it: silently resume
    if (thread.paused.reasons.length === 1 && thread.paused.reasons[0] === "breakpoint") {
      const { linenum, qtype } = thread.paused.location;
      if (!this.dbgr.breakpoints.byID.get(`${linenum}:${qtype}`)) {
        this.continueThread(thread);
        return;
      }
    }
    const event = new StoppedEvent(
      thread.paused.reasons[0],
      thread.vscode_threadid,
      thread.paused.last_exception && "Exception thrown",
    );
    thread.paused.stoppedEvent = event;
    this.sendEvent(event);
  }

  async continueThread(thread) {
    thread.paused = null;
    this.checkPendingThreadBreaks();
    await this.dbgr.resumeThread(thread.threadid);
  }

  continueRequest(response, args) {
    const thread = this.getThread(args.threadId);
    if (!thread) return this.failRequest(`Continue failed. Thread ${args.threadId} not found`, response);
    if (!thread.paused) return this.failRequest(`Continue cancelled. Thread ${args.threadId} is not suspended`, response, true);
    this.sendResponse(response);
    this.continueThread(thread);
  }

  doStep(which, response, args) {
    const thread = this.getThread(args.threadId);
    if (!thread) return this.failRequest(`Step failed. Thread ${args.threadId} not found`, response);
    if (!thread.paused) return this.failRequest(`Step cancelled. Thread ${args.threadId} is not suspended`, response, true);

    thread.paused = null;
    this.sendResponse(response);

    // a step that takes too long usually means it crossed into another thread's
    // work - surface other paused threads meanwhile
    thread.stepTimeout = setTimeout(() => {
      thread.stepTimeout = null;
      this.checkPendingThreadBreaks();
    }, 2000);

    this.dbgr.step(which, thread.threadid);
  }

  stepInRequest(response, args) {
    this.doStep("in", response, args);
  }

  nextRequest(response, args) {
    this.doStep("over", response, args);
  }

  stepOutRequest(response, args) {
    this.doStep("out", response, args);
  }

  async onException(e) {
    const thread_id = e.throwlocation.threadid;
    try {
      const ex_value = await this.dbgr.getExceptionValue(thread_id, e.event.exception);
      const last_exception = new DebuggerException(ex_value, thread_id);
      this.reportStoppedEvent("exception", e.throwlocation, last_exception);
    } catch (err) {
      this.WARN(`exception event: could not read the exception object (${err?.message ?? err})`);
      this.reportStoppedEvent("exception", e.throwlocation);
    }
  }

  async onThreadChange(e) {
    switch (e.state) {
      case "start": {
        try {
          const threadinfos = await this.dbgr.getJavaThreadInfos([e.threadid]);
          const t = this.getThread(threadinfos[0].threadid, threadinfos[0].name);
          this.sendEvent(new ThreadEvent("started", t.vscode_threadid));
        } catch {
          /* thread died immediately */
        }
        break;
      }
      case "end": {
        const t = this._threads.find((t) => t && t.threadid === e.threadid);
        if (t) {
          if (t.stepTimeout) {
            clearTimeout(t.stepTimeout);
            t.stepTimeout = null;
          }
          delete this._threads[t.vscode_threadid];
          this.sendEvent(new ThreadEvent("exited", t.vscode_threadid));
          this.checkPendingThreadBreaks();
        }
        break;
      }
    }
    this.dbgr.resumeThread(e.threadid);
  }

  async threadsRequest(response) {
    if (!this._threads.length) {
      try {
        await this.refreshThreads();
      } catch (e) {
        response.success = false;
        response.message = e?.message ?? String(e);
        return this.sendResponse(response);
      }
    }
    response.body = {
      threads: this._threads
        .filter((x) => x)
        .map((t) => {
          const javaid = parseInt(t.threadid, 16);
          return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name || "<unnamed>"}`);
        }),
    };
    this.sendResponse(response);
  }

  async stackTraceRequest(response, args) {
    const thread = this.getThread(args.threadId);
    if (!thread) return this.failRequest(`Stack trace failed. Thread ${args.threadId} not found`, response);
    if (!thread.paused) return this.failRequest(`Stack trace cancelled. Thread ${args.threadId} is not suspended`, response, true);

    try {
      const frames = await this.dbgr.getFrames(thread.threadid);
      await Promise.all(frames.map((f) => this.dbgr._ensureMethodLines(f.method)));

      const startFrame = typeof args.startFrame === "number" ? args.startFrame : 0;
      const maxLevels = typeof args.levels === "number" ? args.levels : frames.length - startFrame;
      const endFrame = Math.min(startFrame + maxLevels, frames.length);
      const stack = [];
      let totalFrames = frames.length;
      for (let i = startFrame; i < endFrame && thread.paused; i++) {
        const frame = frames[i];
        const type = frame.method.owningclass.type;
        const srcloc = this.dbgr.frameToSourceLocation(frame);
        if (!srcloc) continue; // synthetic frames have no line information
        const signature = type.signature;
        const sourcefile =
          (frame.method.owningclass.src && frame.method.owningclass.src.sourcefile) ||
          `${(/([^/$]+)[;$]/.exec(signature) ?? [])[1] ?? "unknown"}.java`;
        // path-based Source only: Zed opens the real file from disk; frames
        // outside the deployed source roots stay name-only
        const srcpath = this.index ? this.index.sourceFor(signature) : null;
        const src = new Source(sourcefile, srcpath || undefined);
        stack.push(
          new StackFrame(
            thread.createStackFrameVariable(frame, i).variableReference,
            `${frame.method.owningclass.name}.${frame.method.name}`,
            src,
            srcloc.linenum,
            // non-zero column on exception stops makes the exception UI show
            (!i && thread.paused.last_exception && thread.paused.reasons[0] === "exception") ? 1 : 0,
          ),
        );
      }
      response.body = { stackFrames: stack, totalFrames };
      this.sendResponse(response);
    } catch (e) {
      return this.failRequest(`No call stack is available (${e?.message ?? e})`, response);
    }
  }

  async scopesRequest(response, args) {
    const threadId = AndroidThread.variableRefToThreadId(args.frameId);
    const thread = this.getThread(threadId);
    if (!thread) return this.failRequest(`Scopes failed. Thread ${threadId} not found`, response);
    if (!thread.paused) return this.failRequest(`Scopes cancelled. Thread ${threadId} is not suspended`, response, true);

    const scopes = [new Scope("Local", args.frameId, false)];
    const last_exception = thread.paused.last_exception;
    if (last_exception) {
      last_exception.scopeRef = args.frameId + 1;
      scopes.unshift(new Scope(`Exception: ${last_exception.exceptionValue.type.typename}`, last_exception.scopeRef, false));
    }
    response.body = { scopes };
    this.sendResponse(response);
  }

  async variablesRequest(response, args) {
    const threadId = AndroidThread.variableRefToThreadId(args.variablesReference);
    const thread = this.getThread(threadId);
    if (!thread) return this.failRequest(`Variables failed. Thread ${threadId} not found`, response);
    if (!thread.paused) return this.failRequest(`Variables cancelled. Thread ${threadId} is not suspended`, response, true);

    try {
      const stack_frame = thread.findStackFrame(args.variablesReference);
      let variables = [];
      switch (args.variablesReference % 1e6) {
        case 0: // frame scope
        case 1: // exception scope
          if (args.variablesReference % 1e6 === 1 && stack_frame) {
            const ex = thread.paused.last_exception;
            variables = await stack_frame.getExpandableValues(
              stack_frame.makeVariableValue(ex.exceptionValue).variablesReference,
            );
          } else {
            variables = await stack_frame.getLocalVariables();
          }
          break;
        default:
          variables = await stack_frame.getExpandableValues(args.variablesReference);
          break;
      }
      response.body = { variables };
    } catch (e) {
      response.success = false;
      response.message = e?.message ?? String(e);
    }
    this.sendResponse(response);
  }

  async exceptionInfoRequest(response, args) {
    const thread = this.getThread(args.threadId);
    if (!thread) return this.failRequest(`Exception info failed. Thread ${args.threadId} not found`, response);
    if (!thread.paused || !thread.paused.last_exception) {
      return this.failRequest("No exception available", response);
    }
    const ex_value = thread.paused.last_exception.exceptionValue;
    const message = ex_value.data && ex_value.data.msg ? ex_value.data.msg.string : "";
    response.body = {
      exceptionId: ex_value.type.typename,
      description: `${os.EOL}${message}`,
      breakMode: "always",
      details: {
        message,
        typeName: ex_value.type.typename,
        fullTypeName: ex_value.type.fullyQualifiedName(),
      },
    };
    this.sendResponse(response);
  }

  // zed-android delta: evaluateRequest/setVariableRequest from upstream depend
  // on the expression evaluator (excluded from the vendor), so they report an
  // honest failure instead of silently mis-evaluating.
  evaluateRequest(response, args) {
    return this.failRequest("expression evaluation is not supported by zed-android yet", response);
  }

  setVariableRequest(response, args) {
    return this.failRequest("setting variable values is not supported by zed-android yet", response);
  }

  attachRequest(response, args) {
    return this.failRequest(
      "zed-android only supports request=launch (it builds, installs and attaches itself)",
      response,
    );
  }

  // ------------------------------------------------------------- plumbing

  failRequest(msg, response, silent = false) {
    if (!silent && msg) this.WARN(msg);
    if (response) {
      response.success = false;
      response.message = msg;
      this.sendResponse(response);
    }
  }
}

module.exports = { ZedAndroidDebugSession };
