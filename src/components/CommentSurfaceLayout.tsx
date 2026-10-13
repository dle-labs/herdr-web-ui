import { createContext, useRef, type JSX, type ReactNode, type RefObject } from "react";
import "./CommentSurfaceLayout.css";

/** One stable desktop editor host: changing float/dock mode must not remount a draft or its textarea. */
export const CommentEditorHost = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function CommentSurfaceLayout({ children, className = "" }: { children: ReactNode; className?: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  return <CommentEditorHost.Provider value={host}>
    <div className={`comment-surface-layout ${className}`}>
      {children}
      <div ref={host} className="comment-editor-host" aria-live="off" />
    </div>
  </CommentEditorHost.Provider>;
}
