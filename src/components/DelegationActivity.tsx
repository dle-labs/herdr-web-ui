import { GitBranch } from "lucide-react";
import type { ConversationPart } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { turnDelegations } from "../lib/workBlocks.ts";
import "./DelegationActivity.css";

/** Transcript evidence is always outside generic work folds; it never claims live liveness. */
export function DelegationActivity({ parts }: { parts: ConversationPart[] }) {
  const t = useT();
  const tasks = turnDelegations(parts);
  if (!tasks.length) return null;
  return <section className="delegation-activity" aria-label={t("Delegation evidence")}>
    {tasks.map((task, index) => <details className="delegation-card" key={index}>
      <summary><GitBranch aria-hidden="true" /><span className="delegation-name">{task.name}</span><span>{t("Recorded: {status}", { status: task.status ?? t("Unknown") })}</span></summary>
      <div className="delegation-detail">
        <p>{t("Last recorded evidence, not live status. A parent turn ending does not mean this task ended.")}</p>
        <p><code>{task.type} · {task.evidence}{task.id ? ` · ${task.id}` : ""}</code></p>
        {(task.agent || task.model) && <p>{[task.agent, task.model].filter(Boolean).join(" · ")}</p>}
        {task.duration_ms !== null && <p>{t("Recorded duration: {ms} ms", { ms: task.duration_ms })}</p>}
        {task.result && <pre>{task.result}{task.result_cut ? "…" : ""}</pre>}
      </div>
    </details>)}
    {parts.filter((part): part is Extract<ConversationPart, { kind: "delegation" }> => part.kind === "delegation").map((part, index) => part.text && <details className="delegation-card" key={`raw-${index}`}><summary>{t("Original notification")}</summary><pre className="delegation-detail">{part.text}</pre></details>)}
  </section>;
}
