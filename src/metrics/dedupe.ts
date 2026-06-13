/** One impression per (kind, surface, adId, webview session) for the lifetime
 *  of a loopback session. Same ad on overlay vs banner vs codex_overlay vs
 *  statusline are distinct visual impressions and each fires once. Duplicate
 *  Claude/Codex windows also carry distinct session nonces, so each visible
 *  window can produce its own billable impression while repeats from the same
 *  window session are still suppressed. Server-side credit_gate (keyed by
 *  user+ad+event_type) still prevents the user from being double-credited if
 *  the same ad shows on multiple surfaces. Clicks are NOT routed through this. */
export class ImpressionDedupe {
  private readonly seen = new Set<string>();
  shouldSend(
    kind: string, adId: string, surface?: string, sessionNonce?: string,
  ): boolean {
    const key = kind + ":" + (surface || "default") + ":" + adId
      + ":" + (sessionNonce || "default");
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  reset(): void { this.seen.clear(); }
}
