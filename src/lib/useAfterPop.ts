import { useEffect, useRef } from "react";

/**
 * Runs `onPop` on each Back or Forward the page hears, the latest one given. It never stops the event:
 * every popstate listener after it (lib/useAddressBar.ts's among them) still hears each one.
 */
export function useAfterPop(onPop: () => void): void {
  const latest = useRef(onPop);
  latest.current = onPop;
  useEffect(() => {
    const listener = (): void => latest.current();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
}
