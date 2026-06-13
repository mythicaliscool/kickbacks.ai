import type { LogTail } from "../activity/logTail";
import type { MetricsClient } from "../metrics/client";
import type { PatchAd } from "../portfolio/client";
import type { CliCachedAd, CliTerminalSession } from "../adapters/claude-cli/cliAd";
import { canPatch } from "../servingGate";
import { cliMode } from "../modes";
import { dlog } from "../log";

// The dwell/billing loop for the TERMINAL statusline surface. The statusline
// (and spinner-verb) ads are written into ~/.claude/settings.json by cliSync,
// which emits one impression_viewable per ad — but until this module existed
// NO TUI surface ever emitted view_tick, so a user consuming ads purely in
// the terminal saw ads all day and earned nothing (the Steven incident,
// 2026-06-10). Server-side, view_tick from surface:"statusline" is already
// allowlisted, block-debited, cooldown-gated (5s shared per user+ad across
// surfaces — so statusbar+statusline ticking the same ad can never
// double-credit), and daily-capped; the whole gap was client emission.
//
// CONTINUOUS BILLING (2026-06-13): unlike the spinner verb (which CC only
// renders mid-turn), the statusline ad PERSISTS on screen at idle — it sits
// in ~/.claude/settings.json and CC repaints it below every prompt, between
// turns, indefinitely. So billing must NOT be gated on an active turn: a
// terminal user who left the statusline ad up all day was shown the ad the
// whole time yet earned nothing between turns. We now bill view_tick whenever
// the statusline ad is APPLIED (signed in, not killed, mode on, surface
// rendered), active or idle — mirroring the docked-idle Claude overlay, which
// keeps its view session live while the ad stays visible. The suspend cap in
// accrueVisible() keeps a laptop sleep from billing as visible time, and the
// server's 5s cross-surface cooldown gates real credit. Deliberately NOT
// gated on window focus: the surface lives in the user's terminal (integrated
// or external), not in the VS Code chrome.

const POLL_INTERVAL_MS = 1_000;
const VIEW_TICK_INTERVAL_MS = 5_000;
const FRESH_ACTIVITY_MS = 4_000;

export interface CliTickDeps {
  cliTail: Pick<LogTail, "current" | "activityAgeMs">;
  metrics: MetricsClient;
  adRef: { current: PatchAd | null };
  killedRef: { current: boolean };
  /** Live sign-in probe (auth.accessToken truthiness). */
  signedIn: () => boolean;
  /** True when cliSync's adapter can actually render the statusline (its
   *  preflight().compatible) — billing must track a surface that paints. */
  surfaceApplied: () => boolean;
  /** Rendered statusline heartbeats keyed by Claude Code's statusline
   *  session_id. When omitted, cliTick falls back to one legacy synthetic
   *  terminal for unit tests and older wiring. */
  terminalSessions?: () => CliTerminalSession[];
  /** Full CLI ad cache written by cliSync; lets each terminal bill the ad it
   *  actually rendered rather than the currently-active global ad. */
  cachedAds?: () => CliCachedAd[];
  ccVersion: string;
  timers: NodeJS.Timeout[];
  /** Injectable for tests; default to the shared modes/servingGate. */
  cliModeFn?: () => string;
  canPatchFn?: () => boolean;
}

export function setupCliTick(deps: CliTickDeps): void {
  const {
    cliTail, metrics, adRef, killedRef, signedIn, surfaceApplied,
    ccVersion, timers,
  } = deps;
  // cliTail is no longer a billing GATE (continuous-billing change above), but
  // its activity snapshot is still logged per show/tick so the debug log shows
  // whether a tick fired during a live turn or at idle.
  const cliModeFn = deps.cliModeFn ?? cliMode;
  const canPatchFn = deps.canPatchFn ?? canPatch;

  type Showing = {
    session: CliTerminalSession;
    shownAd: PatchAd | CliCachedAd;
    corr: string;
    accruedVisibleMs: number;
    lastAccrualMs: number;
    lastViewTickAt: number;
  };
  const showing = new Map<string, Showing>();

  // Same suspend clamp as the statusbar (audit #23): accrue per poll tick,
  // capping any single gap per terminal, so a laptop sleep never bills as
  // visible time.
  const VISIBLE_GAP_CAP_MS = 2 * POLL_INTERVAL_MS;
  const accrueVisible = (s: Showing): void => {
    const now = Date.now();
    const delta = now - s.lastAccrualMs;
    if (delta > 0) s.accruedVisibleMs += Math.min(delta, VISIBLE_GAP_CAP_MS);
    s.lastAccrualMs = now;
  };

  // Same token-freshness contract as the statusbar (audit #1): the 60s
  // portfolio refresh REPLACES ad objects to adopt fresh session tokens
  // (300s TTL) — re-read the live ad each billable emission and adopt its
  // token when it is still the same ad.
  const freshenToken = (s: Showing): void => {
    const live = adRef.current;
    const cached = (deps.cachedAds?.() ?? []).find((a) =>
      a.adId === s.shownAd.adId);
    const fresh = cached ?? (live && live.adId === s.shownAd.adId
      ? live : null);
    if (fresh && fresh.sessionToken !== s.shownAd.sessionToken) {
      s.shownAd = { ...s.shownAd, sessionToken: fresh.sessionToken,
        demo: fresh.demo };
    }
  };

  const endShow = (keyHash: string): void => {
    const s = showing.get(keyHash);
    if (!s) return;
    accrueVisible(s);
    dlog("ext", "clitick.end",
      { adId: s.shownAd.adId, visibleMs: s.accruedVisibleMs,
        corr: s.corr, terminal: keyHash });
    showing.delete(keyHash);
  };

  // Activity snapshot for logging only (no longer gates billing). Returns
  // true=live turn, false=idle, null=transcript unreadable.
  const turnActiveNow = (): boolean | null => {
    try {
      const act = cliTail.current();
      if (act) return !act.done;
      const age = cliTail.activityAgeMs();
      return age !== null ? age <= FRESH_ACTIVITY_MS : null;
    } catch { return null; }
  };

  const fallbackSession = (): CliTerminalSession[] => {
    const ad = adRef.current;
    return ad ? [{
      keyHash: "legacy",
      sessionNonce: "cli.legacy",
      adId: ad.adId,
      campaignId: ad.campaignId,
      adIndex: 0,
      renderedAt: Date.now(),
      lastSeen: Date.now(),
    }] : [];
  };

  const renderedSessions = (): CliTerminalSession[] =>
    deps.terminalSessions ? deps.terminalSessions() : fallbackSession();

  const resolveRenderedAd = (
    sess: CliTerminalSession,
  ): PatchAd | CliCachedAd | null => {
    const cached = (deps.cachedAds?.() ?? []).find((a) => a.adId === sess.adId);
    if (cached) return cached;
    const live = adRef.current;
    if (!live) return null;
    return !sess.adId || live.adId === sess.adId ? live : null;
  };

  const startShow = (
    sess: CliTerminalSession,
    shownAd: PatchAd | CliCachedAd,
  ): void => {
    const now = Date.now();
    const corr = "clitick." + sess.keyHash + "." + shownAd.adId + "."
      + Math.random().toString(36).slice(2, 8);
    showing.set(sess.keyHash, {
      session: sess,
      shownAd,
      corr,
      accruedVisibleMs: 0,
      lastAccrualMs: now,
      lastViewTickAt: now,
    });
    dlog("ext", "clitick.show",
      { adId: shownAd.adId, corr, turnActive: turnActiveNow(),
        terminal: sess.keyHash, sessionNonce: sess.sessionNonce });
    metrics.send("impression_rendered", {
      adId: shownAd.adId,
      campaignId: shownAd.campaignId,
      ccVersion,
      corr,
      surface: "statusline",
      sessionNonce: sess.sessionNonce,
    });
    metrics.send("impression_viewable", {
      adId: shownAd.adId,
      campaignId: shownAd.campaignId,
      ccVersion,
      corr,
      surface: "statusline",
      sessionToken: shownAd.sessionToken,
      sessionNonce: sess.sessionNonce,
    });
  };

  const poll = (): void => {
    try {
      // CONTINUOUS BILLING: bill whenever the statusline ad is APPLIED —
      // active OR idle (see file header). No turn-active gate; the statusline
      // persists on screen between turns, so the ad is genuinely visible the
      // whole time. All the other money gates still apply.
      const globallyEligible = signedIn()
        && !killedRef.current && canPatchFn() && cliModeFn() === "on"
        && surfaceApplied();

      const liveKeys = new Set<string>();
      if (globallyEligible) {
        for (const sess of renderedSessions()) {
          const renderedAd = resolveRenderedAd(sess);
          if (!renderedAd || renderedAd.demo) continue;
          liveKeys.add(sess.keyHash);
          const cur = showing.get(sess.keyHash);
          if (cur && cur.shownAd.adId !== renderedAd.adId) {
            endShow(sess.keyHash);
          }
          if (!showing.has(sess.keyHash)) startShow(sess, renderedAd);
        }
      }

      for (const [keyHash, s] of Array.from(showing.entries())) {
        if (!globallyEligible || !liveKeys.has(keyHash)) {
          endShow(keyHash);
          continue;
        }
        accrueVisible(s);
        freshenToken(s);
        s.session = { ...s.session,
          ...(renderedSessions().find((r) => r.keyHash === keyHash) ?? {}) };
        const now = Date.now();
        if (now - s.lastViewTickAt >= VIEW_TICK_INTERVAL_MS) {
          s.lastViewTickAt = now;
          // Per-poll trace: the request side of "every poll + response". The
          // matching backend response is logged by MetricsClient (metric.resp,
          // same corr). turnActive shows whether this tick fired at idle.
          dlog("ext", "clitick.tick",
            { adId: s.shownAd.adId, surface: "statusline",
              visibleMs: s.accruedVisibleMs, corr: s.corr,
              turnActive: turnActiveNow(), terminal: keyHash,
              sessionNonce: s.session.sessionNonce });
          metrics.send("view_tick", {
            adId: s.shownAd.adId, campaignId: s.shownAd.campaignId,
            ccVersion, corr: s.corr, surface: "statusline",
            visibleMs: s.accruedVisibleMs,
            sessionToken: s.shownAd.sessionToken,
            sessionNonce: s.session.sessionNonce,
          });
        }
      }
    } catch { /* prime directive: never break activation */ }
  };

  timers.push(setInterval(poll, POLL_INTERVAL_MS));
}
