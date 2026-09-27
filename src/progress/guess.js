// Round guess helpers (V105-CLIENT.md §2.3). Pure functions over round.state.

export const GUESS_LOCK_PUSH = 0.7;

// How far the RAW price (not the eased border) has travelled toward the nearer end zone:
// 0 at the round centre, 1 at either zone.
export function pushOf(state) {
  const { price, low, high } = state;
  if (!(high > low) || !(price > 0)) return 0;
  const pos = (price - low) / (high - low); // 0 = red zone, 1 = green zone
  return Math.min(1, Math.abs(pos - 0.5) * 2);
}

export const isGuessLocked = (state) => pushOf(state) >= GUESS_LOCK_PUSH;

// Stable id of a round (survives reloads): start wall time + rounded low.
export const roundSig = (state) => `${state.roundStartedAt}:${Math.round(state.low)}`;
