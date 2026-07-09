import { FolderPlus, Trash2 } from "lucide-react";
import type { SessionRef } from "../App";
import styles from "./ProjectsView.module.css";

export interface ProjectRef {
  id: string;
  name: string;
}

export interface ProjectSessionGroup {
  id: string;
  name: string;
  sessions: SessionRef[];
}

interface ProjectsViewProps {
  projects: ProjectRef[];
  activeProjectId: string;
  defaultProjectId: string;
  projectNameDraft: string;
  onProjectNameDraftChange: (value: string) => void;
  onCreateProject: () => void;
  onSelectProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  projectSessionGroups: ProjectSessionGroup[];
  activeSession: SessionRef | null;
  onSelectSession: (session: SessionRef) => void;
  /** Format ISO timestamps for the session row meta. */
  formatRelativeTime: (iso: string | undefined) => string;
}

/**
 * Project list + create + per-project session grid. Pure props-in; the
 * orchestrator owns the project/session state and the side effects of
 * create/delete/select.
 */
export function ProjectsView({
  projects,
  activeProjectId,
  defaultProjectId,
  projectNameDraft,
  onProjectNameDraftChange,
  onCreateProject,
  onSelectProject,
  onDeleteProject,
  projectSessionGroups,
  activeSession,
  onSelectSession,
  formatRelativeTime,
}: ProjectsViewProps) {
  return (
    <div className={styles.sessionsManager}>
      <div className={styles.projectCreate}>
        <input
          aria-label="New project name"
          onChange={(event) => onProjectNameDraftChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") onCreateProject(); }}
          placeholder="New project name"
          value={projectNameDraft}
        />
        <button type="button" onClick={onCreateProject}><FolderPlus size={15} />Create project</button>
      </div>
      <div className={styles.projectTabs} aria-label="Projects">
        {projects.map((project) => (
          <div className={project.id === activeProjectId ? `${styles.projectTab} selected` : styles.projectTab} key={project.id}>
            <button type="button" onClick={() => onSelectProject(project.id)}>
              {project.name}
            </button>
            {project.id !== defaultProjectId ? (
              <button
                aria-label={`Delete project ${project.name}`}
                className="project-tab-delete"
                type="button"
                onClick={() => onDeleteProject(project.id)}
              >
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="utility-grid">
        {projectSessionGroups.map((group) => (
          <section className={styles.projectGroup} key={group.id} aria-label={`${group.name} sessions`}>
            <h3>{group.name}</h3>
            {group.sessions.length === 0 ? (
              <p className="skills-muted">No sessions in this project yet. New Session will add one here.</p>
            ) : (
              group.sessions.map((session) => (
                <button
                  className={session.id === activeSession?.id ? "utility-row selected" : "utility-row"}
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSession(session)}
                >
                  <strong>{session.label}</strong>
                  <span>{formatRelativeTime(session.lastSeenAt)}</span>
                </button>
              ))
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
