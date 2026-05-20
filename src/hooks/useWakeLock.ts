import { useEffect } from "react";

/**
 * Hold a Screen Wake Lock while the page is visible so the device doesn't dim /
 * sleep mid-broadcast. The OS auto-releases the lock whenever the tab is hidden
 * (or the screen is manually locked), so we re-acquire on every return to visible.
 *
 * No-op where the API is unavailable (older browsers; needs a secure context —
 * https — which Vercel provides). iOS Safari supports it from 16.4.
 */
export function useWakeLock(): void {
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      if (cancelled) return;
      if (!("wakeLock" in navigator)) return;
      if (document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return; // already held
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // request can reject (low battery, user-agent policy, etc.) — non-fatal.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, []);
}
