/**
 * Diagnostic-log gate. Quiet by default in production so the console isn't
 * spammed during normal viewing. Enable for a session by either:
 *
 *   - URL query: `?debug=1`
 *   - DevTools console: `localStorage.setItem("shogitv:debug", "1")` then reload
 *
 * To disable a persistent localStorage flag:
 *   `localStorage.removeItem("shogitv:debug")` (and reload)
 *
 * Evaluated once at module load — toggling requires a reload, which is fine for
 * a debugging affordance. Keeps the per-call overhead at one boolean check.
 */
const enabled = (() => {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "1") return true;
    return window.localStorage.getItem("shogitv:debug") === "1";
  } catch {
    return false;
  }
})();

export function dlog(...args: unknown[]): void {
  if (enabled) console.log(...args);
}
