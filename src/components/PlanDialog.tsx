import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Circle, CircleCheck, CircleDot, ListChecks, Workflow, X, type LucideProps } from "lucide-react";

import "./PlanDialog.css";

import { useMachineApi } from "../lib/machineContext.tsx";
import { clockOffsetMs, formatElapsed, spanMs } from "../lib/omoTasks.ts";
import { FLOW, flowLayout, planWaves } from "../lib/plan.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import type { PlanStep, PlanSummary } from "../../shared/protocol.ts";

const POLL_MS = 3000;

const ICONS: Record<PlanStep["status"], ComponentType<LucideProps>> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };

/** The header's way to the selected pane's plan, in the chat and the terminal alike: how far it has got. */
export function PlanButton({ plan, onOpen }: { plan: PlanSummary; onOpen: () => void }) {
  const t = useT();
  const label = t("Plan: {done} of {total} done", { done: plan.done, total: plan.total });
  return (
    <button type="button" className={`plan-button${plan.done === plan.total ? " is-done" : ""}`} aria-haspopup="dialog" aria-label={label} title={plan.current ? `${label} · ${plan.current}` : label} onClick={onOpen}>
      <ListChecks aria-hidden="true" />
      <span className="plan-button-count">{plan.done}/{plan.total}</span>
    </button>
  );
}

/**
 * The plan the pane's agent keeps (Claude Code's task list, Codex's checklist), as a flow of
 * boxes (a step below the steps it waits on) or as a list. Read again every few seconds while
 * open; times are the PC's.
 */
export function PlanDialog({ paneId, title, onClose }: { paneId: string; title: string; onClose: () => void }) {
  const t = useT();
  const { fetchPanePlan } = useMachineApi();
  const titleId = useId();
  /** undefined: not read yet; null: the pane keeps no plan */
  const [steps, setSteps] = useState<PlanStep[] | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** null: not picked, so a plan whose steps wait on none (nothing to draw) opens as the list */
  const [picked, setView] = useState<"flow" | "steps" | null>(null);
  // Settings → Plan flow off: the list alone, with no switch
  const { settings } = useSettings();
  const view = !settings.planFlow ? "steps" : picked ?? (steps?.some((step) => step.blocked_by.length > 0) ? "flow" : "steps");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSteps(undefined);
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPanePlan(paneId);
        if (!alive) return;
        const received = Date.now();
        setSteps(next.steps); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        if (alive) setFailed(true);
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [paneId, fetchPanePlan]);

  // a step that runs counts its time up between reads
  const running = steps?.some((step) => step.status === "in_progress") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // the terminal under the dialog may hold the focus: Escape is the dialog's and goes no further
  useLayoutEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [onClose]);

  // the focus comes into the dialog and goes back where it was on close
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => before?.focus();
  }, []);

  const words: Record<PlanStep["status"], string> = { pending: t("waiting"), in_progress: t("running"), completed: t("done") };
  /** what one step says under its name: its state, how long it took or has run, who has it */
  const meta = (step: PlanStep): string => {
    const elapsed = spanMs(step.started_at, step.ended_at, step.status === "in_progress", now + offset);
    return [words[step.status], elapsed === null ? null : formatElapsed(elapsed), step.owner].filter((part) => part !== null).join(" · ");
  };
  const done = steps?.filter((step) => step.status === "completed").length ?? 0;
  const current = steps?.find((step) => step.status === "in_progress");

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal plan-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 className="modal-title plan-dialog-title" id={titleId}>{t("Plan")} <span className="plan-dialog-pane">{title}</span></h2>
          {settings.planFlow && <div className="segmented plan-view-switch" role="group" aria-label={t("Plan view")}>
            <button type="button" aria-pressed={view === "flow"} onClick={() => setView("flow")}><Workflow aria-hidden="true" />{t("Flow")}</button>
            <button type="button" aria-pressed={view === "steps"} onClick={() => setView("steps")}><ListChecks aria-hidden="true" />{t("Steps")}</button>
          </div>}
          <button ref={closeRef} type="button" className="icon-button" aria-label={t("Close plan")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body plan-dialog-body">
          {steps === undefined && !failed && <p className="plan-note" role="status">{t("Reading the plan…")}</p>}
          {steps === null && <p className="plan-note">{t("This session keeps no plan right now. Claude Code's task list and Codex's checklist show here as the agent makes them.")}</p>}
          {failed && <p className="plan-note plan-error" role="status">{t("Couldn't read the plan. Trying again…")}</p>}
          {steps && steps.length > 0 && (
            <>
              <p className="plan-summary">
                {t("{done} of {total} done", { done, total: steps.length })}
                {current && <span className="plan-summary-now">{current.active ?? current.label}</span>}
              </p>
              {view === "flow" ? <PlanFlow steps={steps} meta={meta} label={t("Plan flow")} after={(labels) => t("after {steps}", { steps: labels.join(", ") })} /> : (
                <ol className="plan-steps">
                  {planWaves(steps).flat().map((step) => {
                    const Icon = ICONS[step.status];
                    return (
                      <li key={step.id} className={`plan-step is-${step.status}`}>
                        <Icon aria-hidden="true" />
                        <span className="plan-step-main">
                          <span className="plan-step-label">{step.label}</span>
                          {step.status === "in_progress" && step.active && step.active !== step.label && <span className="plan-step-active">{step.active}</span>}
                          <span className="plan-step-meta">{meta(step)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** The plan as boxes: waves top to bottom, a curve from each step to the steps that wait on it. */
function PlanFlow({ steps, meta, label, after }: { steps: PlanStep[]; meta: (step: PlanStep) => string; label: string; after: (labels: string[]) => string }) {
  // two boxes side by side at most on a phone
  const columns = window.matchMedia?.("(max-width: 480px)").matches ? 2 : 4;
  const layout = useMemo(() => flowLayout(steps, columns), [steps, columns]);
  const labelOf = useMemo(() => new Map(steps.map((step) => [step.id, step.label])), [steps]);
  // an id that is also a valid url(#…) reference
  const arrow = `plan-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <div className="plan-flow-scroll">
      <div className="plan-flow" style={{ width: layout.width, height: layout.height }}>
        <svg className="plan-flow-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {/* an arrowhead takes no color from its line: one per kind of line */}
            {["wait", "done"].map((kind) => (
              <marker key={kind} id={`${arrow}-${kind}`} className={`plan-arrow is-${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => <path key={`${edge.from}>${edge.to}`} className={`plan-edge${edge.done ? " is-done" : ""}`} d={edge.path} markerEnd={`url(#${arrow}-${edge.done ? "done" : "wait"})`} />)}
        </svg>
        <ol className="plan-flow-nodes" aria-label={label}>
          {layout.nodes.map(({ step, x, y }) => {
            const Icon = ICONS[step.status];
            // the curves are drawn, not read: what a step waits on is said in words
            const before = step.blocked_by.flatMap((id) => labelOf.get(id) ?? []);
            return (
              <li key={step.id} className={`plan-node is-${step.status}`} style={{ left: x, top: y, width: FLOW.nodeWidth, height: FLOW.nodeHeight }} title={step.active && step.status === "in_progress" ? `${step.label}\n${step.active}` : step.label}>
                <span className="plan-node-label"><Icon aria-hidden="true" />{step.label}</span>
                <span className="plan-node-meta">{meta(step)}</span>
                {before.length > 0 && <span className="sr-only">{after(before)}</span>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
