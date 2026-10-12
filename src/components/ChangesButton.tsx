import { useContext, useEffect, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { WorkspaceFilesContext } from "../lib/workspaceFiles.ts";

/** A visible pane's lightweight inventory backstop; never polls hidden/inactive panes. */
export function ChangesButton({ paneId, active, connected }: { paneId: string; active: boolean; connected: boolean }) {
  const t = useT();
  const open = useContext(WorkspaceFilesContext);
  const { fetchGitChanges } = useMachineApi();
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!active || !connected || open === null) return;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (disposed || pending || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      pending = true;
      let delay = 10_000;
      try {
        const inventory = await fetchGitChanges(paneId, "all");
        if (!disposed) setCount(inventory.files.length);
      } catch {
        if (!disposed) setCount(0);
        delay = 30_000;
      } finally {
        pending = false;
        if (!disposed) timer = setTimeout(() => void refresh(), delay);
      }
    }
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [paneId, active, connected, fetchGitChanges, open]);
  if (count === 0 || open === null) return null;
  return <button type="button" className="icon-button composer-changes" aria-label={t("Changed files")} title={`${t("Changed files")} (${count})`} onClick={() => open(paneId)}>
    <GitCompareArrows aria-hidden="true" />
  </button>;
}
