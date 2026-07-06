import React from "react";

/**
 * Workspace selection is no longer handled from the composer.
 *
 * Zeus resolves its own runtime home from the installed Tauri resource
 * directory and should expose broader filesystem access through the access
 * mode policy instead of asking the user to pick a folder next to the chat
 * input. Keeping this component as a no-op avoids touching the large App
 * layout in this PR while removing the misleading bottom selector from the
 * UI wherever it is still rendered.
 */
export function WorkingFolderButton() {
  return null;
}

/**
 * Kept for compatibility with existing imports. Clearing a composer-level
 * working folder is intentionally a no-op now because workspace defaults are
 * resolved by the runtime, not by a per-session bottom-bar selector.
 */
export function clearStoredWorkspaceDir(): void {
  return;
}
