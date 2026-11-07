import { useEffect, useRef, useSyncExternalStore } from "react";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { workspaceChanges, workspaceChangesKey, type WorkspaceChangesTarget } from "./workspaceChanges.ts";

export function useWorkspaceChangesSnapshot(target: WorkspaceChangesTarget | null): boolean {
  return useSyncExternalStore(workspaceChanges.subscribe, () => workspaceChanges.get(target), () => null) === true;
}

/** No background polling. Status frames that don't enter/leave work don't read Git. */
export function useWorkspaceChanges(paneId: string, cwd: string, enabled: boolean, status: string, forceOnMount = false): boolean {
  const machineId = useMachineId();
  const { fetchGitChanges } = useMachineApi();
  const target = { machineId, paneId, cwd };
  const key = workspaceChangesKey(target);
  const changed = useWorkspaceChangesSnapshot(target);
  const previous = useRef<{ key: string; status: string; enabled: boolean } | null>(null);
  useEffect(() => {
    const last = previous.current;
    previous.current = { key, status, enabled };
    if (!enabled) return;
    const workEdge = last !== null && last.status !== status && [last.status, status].some((state) => state === "working" || state === "waiting");
    const read = (force: boolean) => void workspaceChanges.load(target, () => fetchGitChanges(paneId, "all"), force);
    const activate = last === null || last.key !== key || !last.enabled;
    if (!document.hidden && (activate || workEdge)) read((forceOnMount && activate) || (last !== null && (activate || workEdge)));
    const onFocus = () => { if (!document.hidden) read(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [key, enabled, status, fetchGitChanges, forceOnMount]);
  return changed;
}
