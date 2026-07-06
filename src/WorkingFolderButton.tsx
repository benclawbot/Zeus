import React, { useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { FolderTree } from "lucide-react";
import { isTauriRuntime } from "./providers/minimax";

const ZEUS_WORKSPACE_DIR_KEY = "zeus.sessionWorkspaceDir";

function readStoredWorkspaceDir(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(ZEUS_WORKSPACE_DIR_KEY)?.trim() || undefined;
}

function writeStoredWorkspaceDir(value: string): void {
  if (typeof window === "undefined") return;
  if (value) {
    window.localStorage.setItem(ZEUS_WORKSPACE_DIR_KEY, value);
  } else {
    window.localStorage.removeItem(ZEUS_WORKSPACE_DIR_KEY);
  }
}

/** Last segment of an absolute path, with a leading `~` for the home dir. */
function folderName(path: string): string {
  const posixSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const tail = posixSlash >= 0 ? path.slice(posixSlash + 1) : path;
  if (!tail) return path || "Folder";
  return tail;
}

interface WorkingFolderButtonProps {
  /** Bumped by the parent when a folder change should re-read storage. */
  refreshKey?: number;
}

export function WorkingFolderButton({ refreshKey }: WorkingFolderButtonProps) {
  const [path, setPath] = useState<string | undefined>(() => readStoredWorkspaceDir());

  // Re-read storage when the parent bumps the key (e.g. when active session
  // changes via the slash menu / new session buttons).
  useEffect(() => {
    setPath(readStoredWorkspaceDir());
    // We deliberately ignore the eslint exhaustive-deps rule: refreshKey
    // is the only signal that should retrigger this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function pickFolder() {
    if (!isTauriRuntime()) {
      // In jsdom / browser preview the native dialog isn't available; the
      // button is a no-op so the test harness still mounts cleanly.
      return;
    }
    try {
      const selected = await openFolderDialog({
        directory: true,
        multiple: false,
        title: "Pick a workspace folder",
      });
      if (typeof selected === "string" && selected.trim()) {
        writeStoredWorkspaceDir(selected.trim());
        setPath(selected.trim());
      }
    } catch (err) {
      console.warn("folder picker failed", err);
    }
  }

  const label = path ? folderName(path) : "Pick folder";
  const ariaLabel = path ? `Working folder: ${path} (click to change)` : "Pick a working folder";

  return (
    <button
      type="button"
      className={path ? "composer-working-folder configured" : "composer-working-folder"}
      onClick={pickFolder}
      aria-label={ariaLabel}
      title={path ?? "Pick a working folder"}
    >
      <FolderTree size={14} aria-hidden="true" />
      <span className="composer-working-folder-label">{label}</span>
    </button>
  );
}

/**
 * Imperative helper used by /new and other slash commands that should
 * reset the working folder to "no folder picked". Kept here so the localStorage
 * key and the button component share a single source of truth.
 */
export function clearStoredWorkspaceDir(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ZEUS_WORKSPACE_DIR_KEY);
}