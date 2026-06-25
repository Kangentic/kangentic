import { useRef, useEffect, useCallback } from 'react';

interface UseValuePulseOptions {
  /**
   * Identity of the CONTEXT the value belongs to (e.g. the current project id, or
   * the session id a metric is reporting for). When it changes - a project switch,
   * a session re-bind, any programmatic context reset - the pulse is rebaselined
   * silently instead of firing: the value flipping from one context's number to
   * another's is not a live change and must not animate. See
   * `.claude/rules/restore-no-animation-replay.md`.
   */
  resetKey?: unknown;
  className?: string;
  durationMs?: number;
}

/**
 * Tracks a value and applies a transient CSS class when it changes IN PLACE.
 * Skips the initial mount, and skips a change that coincides with a `resetKey`
 * change (a context switch), so the pulse only fires on genuine live updates.
 * Returns a ref callback to attach to the target element.
 */
export function useValuePulse<T>(value: T, options: UseValuePulseOptions = {}) {
  const { resetKey, className = 'animate-value-update', durationMs = 350 } = options;
  const elRef = useRef<HTMLElement | null>(null);
  const prevRef = useRef<T>(value);
  const resetKeyRef = useRef<unknown>(resetKey);
  const mountedRef = useRef(false);
  const rafRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    // Context reset (project switch, session re-bind, any programmatic restore):
    // rebaseline silently. The value moving from one context's number to another's
    // is not a live tick and must not pulse.
    if (resetKey !== resetKeyRef.current) {
      resetKeyRef.current = resetKey;
      prevRef.current = value;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      elRef.current?.classList.remove(className);
      return;
    }

    if (value === prevRef.current) return;
    prevRef.current = value;

    const el = elRef.current;
    if (!el) return;

    // Cancel any pending animation so rapid changes restart cleanly
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearTimeout(timerRef.current);

    el.classList.remove(className);
    rafRef.current = requestAnimationFrame(() => {
      el.classList.add(className);
      timerRef.current = setTimeout(() => el.classList.remove(className), durationMs);
    });
  }, [value, resetKey, className, durationMs]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const setRef = useCallback((node: HTMLElement | null) => {
    elRef.current = node;
  }, []);

  return setRef;
}
