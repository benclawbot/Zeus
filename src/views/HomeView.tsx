import { FileText, Image as ImageIcon, Paperclip, Send, Sparkles, Square, User, X } from "lucide-react";
import type { RefObject, ChangeEvent, KeyboardEvent, ClipboardEvent } from "react";
import type { ChatMessage, SessionRef } from "../App";
import type { AttachedFile } from "../App";
import type { UseSlashMenuResult } from "../providers/slash";
import type { SlashItem } from "../providers/slash";
import type { ProviderInfo, ProviderKeysStatus } from "../providers/providers";
import { MarkdownView } from "../components/MarkdownView";
import { StatusBar } from "../components/StatusBar";
import styles from "./HomeView.module.css";
import { WorkingFolderButton } from "../WorkingFolderButton";
import { DEFAULT_COMPACT_TRIGGER_RATIO } from "../providers/autoCompact";

interface HomeViewProps {
  // Conversation
  chat: ChatMessage[];
  conversationRef: RefObject<HTMLDivElement>;

  // Composer
  message: string;
  setMessage: (value: string) => void;
  composerRef: RefObject<HTMLTextAreaElement>;
  resizeComposer: () => void;
  handleComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  fileInputRef: RefObject<HTMLInputElement>;
  attachedFiles: AttachedFile[];
  handleFileSelection: (files: FileList | File[] | null) => void;
  revokeAttachmentUrls: (files: AttachedFile[]) => void;
  setAttachedFiles: (updater: (current: AttachedFile[]) => AttachedFile[]) => void;

  // Slash menu
  slash: UseSlashMenuResult;
  applySlashPick: (item: SlashItem) => void;

  // Skill chip
  activeSkillId: string | null;
  detachSkill: () => void;

  // Run state
  runState: "idle" | "running" | "error";
  handleSend: () => Promise<void> | void;
  stopRun: () => void;

  // Session pill
  activeSession: SessionRef | null;

  // StatusBar
  activeProviderId: string;
  providers: ProviderInfo[];
  providerKeysStatus: ProviderKeysStatus;
  modelId: string;
  livePromptTokens: number;
  actualPromptTokens?: number;
  onOpenSettings: () => void;
}

/**
 * The chat surface: header pills, conversation history, the composer
 * (textarea + slash menu + file attach + send/stop), and the status
 * bar pinned to the bottom. Pure props-in: the orchestrator owns
 * every handler and piece of state this view reads.
 */
export function HomeView({
  chat,
  conversationRef,
  message,
  setMessage,
  composerRef,
  resizeComposer,
  handleComposerKeyDown,
  handleComposerPaste,
  fileInputRef,
  attachedFiles,
  handleFileSelection,
  revokeAttachmentUrls,
  setAttachedFiles,
  slash,
  applySlashPick,
  activeSkillId,
  detachSkill,
  runState,
  handleSend,
  stopRun,
  activeSession,
  activeProviderId,
  providers,
  providerKeysStatus,
  modelId,
  livePromptTokens,
  actualPromptTokens,
  onOpenSettings,
}: HomeViewProps) {
  return (
    <>
      <div className={styles.workspaceHeader}>
        <span className={styles.sessionPill} aria-label="Current session">{activeSession?.label ?? "Untitled Session"}</span>
        {activeSkillId ? <span className={`${styles.sessionPill} ${styles.sessionPillSkill}`}>skill: {activeSkillId}</span> : null}
      </div>

      <div className={styles.conversation} aria-label="Conversation" ref={conversationRef}>
        {chat.map((entry) => {
          if (entry.role === "user") {
            return (
              <article key={entry.id} className={`chat-bubble ${styles.chatUser}`}>
                <div className="chat-avatar" aria-hidden="true"><User size={16} /></div>
                <div className="chat-body">
                  <div className="chat-heading"><strong>Me</strong><time>just now</time></div>
                  {entry.skillId ? (
                    <p className={styles.chatSkillChip} aria-label={`Active skill ${entry.skillId}`}>skill: {entry.skillId}</p>
                  ) : null}
                  {/* User messages stay as pre-wrapped text — they're
                      raw keyboard input, not markdown. */}
                  <p className={styles.chatMdPara}>{entry.text}</p>
                  {entry.attachments && entry.attachments.length > 0 ? (
                    <ul className={styles.chatAttachments} aria-label="Attached files">
                      {entry.attachments.map((attachment) => (
                        <li key={attachment.id}>
                          <Paperclip size={12} aria-hidden="true" />
                          <span>{attachment.name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </article>
            );
          }
          return (
            <article key={entry.id} className="chat-bubble chat-zeus">
              <div className="chat-avatar" aria-hidden="true"><Sparkles size={16} /></div>
              <div className="chat-body">
                <div className="chat-heading"><strong>Zeus</strong><time>just now</time></div>
                {entry.thinking ? (
                  <p className={styles.thinking} aria-live="polite">Thinking<span className={styles.thinkingDots} aria-hidden="true"><span /><span /><span /></span></p>
                ) : (
                  <MarkdownView markdown={entry.text} />
                )}
              </div>
            </article>
          );
        })}
      </div>

      <section className={styles.composer} aria-label="Message composer">
        {slash.visible ? (
          <div className={styles.slashMenu} role="listbox" aria-label="Slash commands">
            {slash.items.length === 0 ? (
              <p className={styles.slashEmpty}>No matches for /{slash.query}</p>
            ) : (
              slash.items.map((item, index) => {
                const isActive = index === slash.activeIndex;
                const label = item.kind === "skill" ? `/${item.id}` : item.label;
                const description = item.kind === "skill" ? (item.description || `Skill: ${item.name}`) : item.description;
                return (
                  <button
                    aria-selected={isActive}
                    className={isActive ? `${styles.slashRow} ${styles.slashRowActive}` : styles.slashRow}
                    key={`${item.kind}-${item.kind === "skill" ? item.id : (item as { id: string }).id}`}
                    onClick={() => applySlashPick(item)}
                    onMouseEnter={() => slash.setActiveIndex(index)}
                    type="button"
                  >
                    <span className={styles.slashRowLabel}>{label}</span>
                    <span className={styles.slashRowDesc}>{description}</span>
                    {item.kind === "skill" ? <span className={styles.slashRowKind}>skill</span> : null}
                  </button>
                );
              })
            )}
            <p className={styles.slashHint}>Up Down navigate, Enter or Tab pick, Esc close. Typing a space picks the command and starts its arguments.</p>
          </div>
        ) : null}

        {activeSkillId ? (
          <div className={styles.composerSkillChip} aria-label={`Active skill ${activeSkillId}`}>
            skill: {activeSkillId}
            <button aria-label="Remove active skill" onClick={detachSkill} type="button"><X size={12} /></button>
          </div>
        ) : null}

        <textarea
          aria-label="Message Zeus"
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setMessage(event.target.value); resizeComposer(); }}
          onKeyDown={handleComposerKeyDown}
          onPaste={handleComposerPaste}
          placeholder="Ask Zeus to inspect, edit, test, or explain this project..."
          ref={composerRef}
          rows={1}
          value={message}
        />
        <div className={styles.composerBottom}>
          <div className={styles.composerTools}>
            <input
              aria-label="Choose files"
              className={styles.fileInput}
              multiple
              onChange={(event) => handleFileSelection(event.target.files)}
              ref={fileInputRef}
              type="file"
            />
            <button aria-label="Attach file" type="button" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
            <WorkingFolderButton />
            {attachedFiles.map((file) => (
              <span className={file.kind === "image" ? `${styles.attachedChip} ${styles.attachedChipImage}` : styles.attachedChip} key={file.id}>
                {file.kind === "image" && file.previewUrl ? (
                  <img alt={`${file.name} preview`} src={file.previewUrl} />
                ) : file.kind === "image" ? (
                  <ImageIcon size={14} />
                ) : (
                  <FileText size={14} />
                )}
                {file.name}
                <button
                  aria-label={`Remove ${file.name}`}
                  type="button"
                  onClick={() => {
                    const removed = attachedFiles.find((item) => item.id === file.id);
                    if (removed) revokeAttachmentUrls([removed]);
                    setAttachedFiles((current) => current.filter((item) => item.id !== file.id));
                  }}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
          <div className={styles.sendCluster}>
            {runState === "running" ? (
              <button aria-label="Stop run" className={styles.stopButton} onClick={stopRun} type="button"><Square size={14} /></button>
            ) : (
              <button aria-label="Send message" className={styles.sendButton} onClick={() => void handleSend()} type="button"><Send size={17} /></button>
            )}
          </div>
        </div>
      </section>

      <StatusBar
        modelId={modelId}
        providerId={activeProviderId}
        promptTokens={livePromptTokens}
        actualPromptTokens={actualPromptTokens}
        triggerRatio={DEFAULT_COMPACT_TRIGGER_RATIO}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}
