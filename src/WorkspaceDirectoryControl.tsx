import React, { useState } from "react";

export const ZEUS_WORKSPACE_DIR_KEY = "zeus.sessionWorkspaceDir";

declare global {
  interface Window {
    __ZEUS_WORKSPACE_DIR__?: string;
  }
}

export function getSessionWorkspaceDir(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(ZEUS_WORKSPACE_DIR_KEY)?.trim() || undefined;
}

export function setSessionWorkspaceDir(value: string): void {
  if (typeof window === "undefined") return;
  const cleaned = value.trim();
  if (cleaned) {
    window.localStorage.setItem(ZEUS_WORKSPACE_DIR_KEY, cleaned);
    window.__ZEUS_WORKSPACE_DIR__ = cleaned;
  } else {
    window.localStorage.removeItem(ZEUS_WORKSPACE_DIR_KEY);
    delete window.__ZEUS_WORKSPACE_DIR__;
  }
}

export function WorkspaceDirectoryControl() {
  const [draft, setDraft] = useState(() => getSessionWorkspaceDir() ?? "");
  const [saved, setSaved] = useState(() => getSessionWorkspaceDir() ?? "");

  function save() {
    setSessionWorkspaceDir(draft);
    setSaved(draft.trim());
  }

  function clear() {
    setDraft("");
    setSaved("");
    setSessionWorkspaceDir("");
  }

  return (
    <section className="workspace-dir-control" aria-label="Session working directory">
      <strong>Working folder</strong>
      <input
        aria-label="Working directory path"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Use app working directory"
      />
      <button type="button" onClick={save}>Save</button>
      {saved ? <button type="button" onClick={clear}>Clear</button> : null}
      <span title={saved || "App process working directory"}>{saved || "App working directory"}</span>
    </section>
  );
}
