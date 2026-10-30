import { createContext, useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, Ellipsis, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import { nativeModalOver } from "../lib/useFocusTrap.ts";

/** Match the existing narrow browser, also on a phone turned sideways. */
export const MOBILE_FILES_QUERY = "(max-width: 768px), (pointer: coarse) and (max-height: 540px)";
export interface FileToolbarHosts {
  title: HTMLElement | null;
  mode: HTMLElement | null;
  actions: HTMLElement | null;
  overlay: HTMLElement | null;
  document: boolean;
}
export const FileToolbarContext = createContext<FileToolbarHosts | null>(null);

/** Existing document controls are portalled here; their drafts and handlers stay with the document. */
export function MobileFilesToolbar({ showFile, onBack, onClose, open, onOpenChange, titleHost, modeHost, actionsHost, overlayHost, children }: {
  showFile: boolean; onBack: () => void; onClose: () => void; open: boolean; onOpenChange: (open: boolean) => void;
  titleHost: (node: HTMLDivElement | null) => void; modeHost: (node: HTMLDivElement | null) => void;
  actionsHost: (node: HTMLDivElement | null) => void; overlayHost: (node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pendingClose = useRef(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const afterMenu = () => {
      if (!pendingClose.current) return;
      pendingClose.current = false;
      latestClose.current();
    };
    window.addEventListener("popstate", afterMenu);
    return () => window.removeEventListener("popstate", afterMenu);
  }, []);
  const closeFiles = () => {
    if (!open) { onClose(); return; }
    // A linked file owns its own Back entry below More. Consume More's first.
    pendingClose.current = true;
    onOpenChange(false);
  };
  const close = (restore = true) => { onOpenChange(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useSheetHistory(open, () => close());
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, a[href]")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target) && !closeButton.current?.contains(event.target)) close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(panel.current)) return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    // Portalled controls have a different React parent; use the actual DOM bubble path.
    const element = panel.current;
    const action = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button, a[href]")) {
        // A portalled action may already have focused its picker or comment field.
        const restore = document.activeElement !== null && !!element?.contains(document.activeElement);
        close(restore);
      }
    };
    const prepareAction = () => trigger.current?.focus({ preventScroll: true });
    element?.addEventListener("click", prepareAction, true);
    element?.addEventListener("click", action);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => { element?.removeEventListener("click", prepareAction, true); element?.removeEventListener("click", action); document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <header className="modal-header files-dialog-header files-mobile-header">
    {showFile && <button type="button" className="icon-button" aria-label={t("Back to files")} title={t("Back to files")} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>}
    <div className="files-mobile-title"><div ref={titleHost} /><h2 className="modal-title">{t("Files")}</h2></div>
    <div ref={modeHost} className="files-mobile-mode" />
    <button ref={trigger} type="button" className="icon-button" aria-label={t("More")} title={t("More")} aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpenChange(!open)}><Ellipsis aria-hidden="true" /></button>
    <button ref={closeButton} type="button" className="icon-button" aria-label={t("Close files")} title={t("Close files")} onClick={closeFiles}><X aria-hidden="true" /></button>
    <div ref={panel} hidden={!open} className="files-mobile-actions" role="dialog" aria-label={t("More")}>
      <div ref={actionsHost} className="files-mobile-document-actions" />
      {children}
    </div>
    <div ref={overlayHost} className="files-mobile-overlay" />
  </header>;
}
