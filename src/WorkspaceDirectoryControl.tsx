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

const shellStyle: React.CSSProperties = {
  position: "fixed",
  left: 18,
  bottom: 18,
  zIndex: 50,
  display: "flex",
  gap: 8,
  alignItems: "center",
  maxWidth: "min(760px, calc(100vw - 36px))",
  padding: "8px 10px",
  border: "1px solid rgba(90, 56, 222, 0.18)",
  borderRadius: 14,
  background: "rgba(255, 255, 255, 0.92)",
  boxShadow: "0 18px 40px rgba(16, 24, 40, 0.14)",
  color: "#111827",
  backdropFilter: "blur(10px)",
};

const buttonStyle: React.CSSProperties = {
  border: "1px solid rgba(90, 56, 222, 0.2)",
  borderRadius: 10,
  padding: "7px 10px",
  background: "#f4f2ff",
  color: "#5a38de",
  cursor: "pointer",
  fontWeight: 700,
};

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
    <section style={shellStyle} aria-label="Session working directory">
      <strong style={{ whiteSpace: "nowrap", color: "#5a38de", fontSize: 12 }}>Working folder</strong>
      <input
        aria-label="Working directory path"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Use app working directory"
        style={{
          width: "min(360px, 42vw)",
          border: "1px solid #d9ddea",
          borderRadius: 10,
          padding: "7px 9px",
          color: "#111821",
          background: "#ffffff",
        }}
      />
      <button type="button" onClick={save} style={buttonStyle}>Save</button>
      {saved ? <button type="button" onClick={clear} style={buttonStyle}>Clear</button> : null}
      <span
        title={saved || "App process working directory"}
        style={{ maxWidth: 260, overflow: "hidden", color: "#667085", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {saved || "App working directory"}
      </span>
    </section>
  );
}
