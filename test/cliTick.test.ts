import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupCliTick, type CliTickDeps } from "../src/activation/cliTick";
import type { Activity } from "../src/activity/logTail";

// The statusline view-tick loop (the Steven fix): TUI surfaces used to emit
// impression_viewable only — no view_tick, no credit, no advertiser debit —
// so a terminal-only user saw ads all day and earned nothing. These tests pin
// the dwell loop's gates and cadence.
//
// CONTINUOUS BILLING (2026-06-13): the statusline ad persists on screen at
// idle, so billing is no longer gated on an active turn — it ticks whenever
// the ad is APPLIED (signed in, not killed, mode on, surface rendered). The
// money gates (signed-out / demo / killed / surface-not-applied / mode-off)
// and the suspend clamp still hold; only the turn-active requirement is gone.

function makeDeps(overrides: Partial<CliTickDeps> = {}): CliTickDeps & {
  metrics: { send: ReturnType<typeof vi.fn> };
  cliTail: {
    current: ReturnType<typeof vi.fn>;
    activityAgeMs: ReturnType<typeof vi.fn>;
  };
} {
  const metrics = { send: vi.fn() };
  const cliTail = {
    current: vi.fn().mockReturnValue(null),
    activityAgeMs: vi.fn().mockReturnValue(null),
  };
  return {
    cliTail: cliTail as any,
    metrics: metrics as any,
    adRef: { current: { adId: "ad1", campaignId: "c1",
      adText: "Try Acme Widgets", iconRef: "", iconUrl: "",
      clickUrl: "https://acme.com", bannerEnabled: false,
      sessionToken: "tok1" } },
    killedRef: { current: false },
    signedIn: () => true,
    surfaceApplied: () => true,
    ccVersion: "2.1.143",
    timers: [],
    cliModeFn: () => "on",
    canPatchFn: () => true,
    ...overrides,
  } as any;
}

function turn(): Activity {
  return { tool: "Edit", elapsedMs: 1000, ts: Date.now(), done: false };
}
function turnDone(): Activity {
  return { tool: "Edit", elapsedMs: 5000, ts: Date.now(), done: true };
}

describe("setupCliTick", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("emits view_tick with surface statusline every 5s during a terminal turn", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(11_000);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0][1]).toMatchObject({
      adId: "ad1", surface: "statusline", sessionToken: "tok1" });
    expect((ticks[0][1] as { visibleMs: number }).visibleMs).toBeGreaterThan(0);
  });

  it("bills view_tick at idle when the statusline ad is applied (continuous billing)", () => {
    // No terminal activity: cliTail.current()=null, activityAgeMs()=null.
    // The statusline ad still persists on screen at idle, so it must bill.
    const d = makeDeps();
    setupCliTick(d);
    vi.advanceTimersByTime(11_000);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0][1]).toMatchObject({ surface: "statusline", adId: "ad1" });
  });

  it("bills duplicate terminals as independent statusline sessions", () => {
    const d = makeDeps({
      terminalSessions: () => [
        { keyHash: "term1", sessionNonce: "cli.term1", sessionId: "s1",
          adId: "ad1", campaignId: "c1", adIndex: 0,
          renderedAt: Date.now(), lastSeen: Date.now() },
        { keyHash: "term2", sessionNonce: "cli.term2", sessionId: "s2",
          adId: "ad2", campaignId: "c2", adIndex: 1,
          renderedAt: Date.now(), lastSeen: Date.now() },
      ],
      cachedAds: () => [
        { adId: "ad1", campaignId: "c1", adText: "Acme", iconRef: "",
          iconUrl: "", clickUrl: "https://a/x", sessionToken: "tok1",
          bannerEnabled: false },
        { adId: "ad2", campaignId: "c2", adText: "Beta", iconRef: "",
          iconUrl: "", clickUrl: "https://b/x", sessionToken: "tok2",
          bannerEnabled: false },
      ],
    });
    setupCliTick(d);
    vi.advanceTimersByTime(6000);
    const rendered = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "impression_rendered");
    expect(rendered.map((c) => c[1]).map((p: any) => p.sessionNonce).sort())
      .toEqual(["cli.term1", "cli.term2"]);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.map((c) => c[1]).map((p: any) => p.adId).sort())
      .toEqual(["ad1", "ad2"]);
    expect(ticks.map((c) => c[1]).map((p: any) => p.sessionNonce).sort())
      .toEqual(["cli.term1", "cli.term2"]);
  });

  it("starts on a fresh-but-unparseable transcript (activityAgeMs fallback)", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(null);
    d.cliTail.activityAgeMs.mockReturnValue(500);
    setupCliTick(d);
    vi.advanceTimersByTime(6000);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps ticking after the turn completes (statusline persists at idle)", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(6000);
    const before = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(before).toBeGreaterThanOrEqual(1);
    d.cliTail.current.mockReturnValue(turnDone());
    vi.advanceTimersByTime(15_000);
    const after = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(after).toBeGreaterThan(before);   // idle billing continues
  });

  it("never ticks while signed out", () => {
    const d = makeDeps({ signedIn: () => false });
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("never ticks a demo ad", () => {
    const d = makeDeps();
    d.adRef.current = { ...d.adRef.current!, demo: true } as any;
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("never ticks when killed, and stops mid-show when the kill trips", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(6000);
    const before = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    d.killedRef.current = true;
    vi.advanceTimersByTime(15_000);
    const after = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick").length;
    expect(after).toBe(before);
  });

  it("never ticks when the statusline surface is not actually applied", () => {
    const d = makeDeps({ surfaceApplied: () => false });
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("never ticks when cliMode is off", () => {
    const d = makeDeps({ cliModeFn: () => "off" });
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(12_000);
    expect(d.metrics.send).not.toHaveBeenCalled();
  });

  it("adopts a fresh session token mid-show (audit #1 contract)", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(1000);             // show opens
    d.adRef.current = { ...d.adRef.current!, sessionToken: "tok2" };
    vi.advanceTimersByTime(5000);             // next tick adopts
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks[ticks.length - 1][1]).toMatchObject(
      { adId: "ad1", sessionToken: "tok2" });
  });

  it("restarts the session when the rotation swaps the ad (statusline repaints)", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(6000);             // ticking ad1
    d.adRef.current = { ...d.adRef.current!, adId: "ad2",
      sessionToken: "tok9", adText: "Other Ad" } as any;
    vi.advanceTimersByTime(6000);             // session restarts on ad2
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    expect(ticks[ticks.length - 1][1]).toMatchObject(
      { adId: "ad2", sessionToken: "tok9" });
  });

  it("suspend clamp: a sleep gap is not billed as visible time", () => {
    const d = makeDeps();
    d.cliTail.current.mockReturnValue(turn());
    setupCliTick(d);
    vi.advanceTimersByTime(5000);             // ~5s genuinely active
    vi.setSystemTime(Date.now() + 8 * 3600_000);  // suspend, no timer ticks
    vi.advanceTimersByTime(5000);
    const ticks = d.metrics.send.mock.calls.filter(
      (c: unknown[]) => c[0] === "view_tick");
    const last = ticks[ticks.length - 1][1] as { visibleMs: number };
    expect(last.visibleMs).toBeLessThan(30_000);  // never the 8h gap
  });
});
