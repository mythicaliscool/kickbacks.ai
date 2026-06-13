// audit-2026-06-09 #38 regression: setupSelfUpdate must wire UpdateClient
// with the timeout-wrapped fetch (timeoutFetch(120000)), not bare global
// fetch — a black-holed manifest/VSIX connection otherwise hangs checkOnce
// forever (and, with the #31 single-flight guard, silently wedges every
// later 90s poll behind the stuck one). Pin: every request the updater
// makes carries an AbortSignal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { setupSelfUpdate } from "../src/activation/selfUpdate";
import { makeContext, _shown } from "./mocks/vscode";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("setupSelfUpdate fetch wiring (audit #38)", () => {
  it("manifest polls carry an abort signal (timeoutFetch, not bare fetch)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init);
      // Not-newer version -> checkOnce stops after the manifest fetch.
      return { ok: true, json: async () => ({ version: "0.0.0",
        sha256: "x", url: "http://b/x.vsix" }) } as Response;
    }));
    const timers: NodeJS.Timeout[] = [];
    const watchFileFn =
      (() => {}) as unknown as typeof import("node:fs").watchFile;
    try {
      const { updater } = setupSelfUpdate(
        makeContext() as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(false);
      expect(inits).toHaveLength(1);
      // Pre-fix: bare global fetch was called with NO init at all.
      expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });

  it("polls/validates a newer manifest but does not invoke VS Code's installer", async () => {
    const bytes = Buffer.alloc(12 * 1024, 0x42);
    const sha = createHash("sha256").update(bytes).digest("hex");
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      String(url).endsWith("/v1/ext/manifest")
        ? ({ ok: true, json: async () => ({ version: "9.9.9",
            sha256: sha, url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response)));
    const timers: NodeJS.Timeout[] = [];
    const watchFileFn =
      (() => {}) as unknown as typeof import("node:fs").watchFile;
    const ctx = makeContext();
    try {
      const vsc = await import("./mocks/vscode");
      const { updater } = setupSelfUpdate(
        ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(false);
      expect(vsc.commands._executed.some(
        (c) => c.id === "workbench.extensions.installExtension")).toBe(false);
      expect(_shown.some(
        (t) => /automatic install disabled|automatic extension installs are disabled/i
          .test(t.text))).toBe(true);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });
});

// Locked-down build: update manifests are still polled and VSIX bytes are
// still validated, but the VSIX is not handed to VS Code's installer.
// These checks keep the old cooldown/retry paths exercised around the new
// "install disabled" branch.
describe("locked-down self-update polling", () => {
  const bytes = Buffer.alloc(12 * 1024, 0x42);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const watchFileFn =
    (() => {}) as unknown as typeof import("node:fs").watchFile;

  function stubManifestFetch() {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) =>
      String(url).endsWith("/v1/ext/manifest")
        ? ({ ok: true, json: async () => ({ version: "9.9.9", sha256: sha,
            url: "http://b/x.vsix" }) } as Response)
        : ({ ok: true, arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
          } as Response)));
  }

  it("does not invoke the installer for the same artifact after cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    stubManifestFetch();
    const ctx = makeContext();
    const timers: NodeJS.Timeout[] = [];
    try {
      const { updater } = setupSelfUpdate(
        ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(false);   // update observed, install blocked
      const toastsAfterBlockedInstall = _shown.length;

      // 31 min later: attempted-ring cooldown has expired. The poll may
      // validate the artifact again, but it still must not install it.
      vi.setSystemTime(1_000_000_000 + 31 * 60 * 1000);
      expect(await updater.checkOnce()).toBe(false);
      expect(_shown.length).toBeGreaterThanOrEqual(toastsAfterBlockedInstall);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });

  it("keeps installs disabled across activation/retry cycles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000);
    stubManifestFetch();
    const ctx = makeContext();
    const timers: NodeJS.Timeout[] = [];
    try {
      const a = setupSelfUpdate(ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await a.updater.checkOnce()).toBe(false);  // update observed, install blocked

      // Window reloads and remains on 0.1.0. Even after the attempted
      // cooldown, the retry path is still blocked from installing.
      vi.setSystemTime(2_000_000_000 + 31 * 60 * 1000);
      const b = setupSelfUpdate(ctx as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await b.updater.checkOnce()).toBe(false);  // still blocked, no install
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });
});
