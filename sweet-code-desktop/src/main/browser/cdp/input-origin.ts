/** CDP timestamps are seconds since Unix epoch; 1 predates every live document. */
export const SELF_INPUT_TIMESTAMP = 1;
/** A clamped-to-zero timestamp is also synthetic. CDP input is trusted too. The explicit epoch marker, not isTrusted alone, distinguishes it. */
export function isUserInput(event: { isTrusted: boolean; timeStamp: number }): boolean {
  return event.isTrusted && Number.isFinite(event.timeStamp) && event.timeStamp > 0;
}
