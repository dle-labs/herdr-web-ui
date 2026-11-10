/**
 * A Back or Forward the file viewer refused (lib/useFileViewer.ts: the file's comment field holds a
 * draft). It puts the entry it left back and marks the event, rather than stopping it: every popstate
 * listener after it still hears the event (lib/useAddressBar.ts reads each one), and reads here that
 * nothing moves. Kept by identity, so the mark ends with its event by itself.
 */
let refused: Event | null = null;

export function refusePop(event: PopStateEvent): void {
  refused = event;
}

/** Whether `event` is the popstate the file viewer refused: its listener has put the entry left back. */
export function popRefused(event: Event): boolean {
  return event === refused;
}
