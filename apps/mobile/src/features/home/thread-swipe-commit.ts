const FULL_SWIPE_GESTURE_MAX_AGE_MS = 5_000;

export function shouldCommitThreadFullSwipe(input: {
  readonly armed: boolean;
  readonly gestureResetKey: string | undefined;
  readonly currentResetKey: string | undefined;
  readonly gestureStartedAtMs: number | null;
  readonly nowMs: number;
}): boolean {
  if (!input.armed || input.gestureStartedAtMs === null) return false;
  if (input.gestureResetKey !== input.currentResetKey) return false;

  const gestureAgeMs = input.nowMs - input.gestureStartedAtMs;
  return gestureAgeMs >= 0 && gestureAgeMs <= FULL_SWIPE_GESTURE_MAX_AGE_MS;
}
