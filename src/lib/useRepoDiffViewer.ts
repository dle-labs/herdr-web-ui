import { useCallback, useEffect, useRef, useState } from "react";

import { reviewNotes } from "./reviewNotes.ts";
import { diffTargetFromState, diffTargetState, repoDiffIdentity, type RepoDiffTarget } from "./repoDiff.ts";

/**
 * A repository diff is a history entry above the Files list, as a file preview is (useFileViewer):
 * Android Back closes it, and a reload or Forward restores it with its PC, pane and comparison.
 */
export function useRepoDiffViewer() {
  const [viewing, setViewing] = useState(() => diffTargetFromState(window.history.state));
  const closing = useRef(false);
  const shown = useRef(viewing); shown.current = viewing;

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      const next = diffTargetFromState(event.state);
      if (shown.current !== null && repoDiffIdentity(shown.current) !== (next === null ? null : repoDiffIdentity(next)) && !reviewNotes.guard()) { window.history.forward(); return; }
      closing.current = false;
      setViewing(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openDiff = useCallback((target: RepoDiffTarget) => {
    if (closing.current || !reviewNotes.guard()) return;
    const state = diffTargetState(window.history.state, target);
    // another file of the same list replaces the entry: Back still returns to the list in one step
    if (diffTargetFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(target);
  }, []);

  const closeDiff = useCallback(() => {
    if (closing.current || !reviewNotes.guard()) return;
    if (diffTargetFromState(window.history.state)) {
      closing.current = true;
      window.history.back();
    } else setViewing(null);
  }, []);

  return { viewing, openDiff, closeDiff };
}
