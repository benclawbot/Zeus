import { useMemo } from "react";
import type { SkillDetail, SkillSummary } from "../providers/skills";

export interface SkillsViewProps {
  skills: SkillSummary[];
  skillsStatus: "idle" | "loading" | "ready" | "error";
  skillsError: string;
  selectedSkillId: string | null;
  setSelectedSkillId: (id: string) => void;
  skillDetail: SkillDetail | null;
  skillDetailStatus: "idle" | "loading" | "ready" | "error";
}

const MERGE_RULES: ReadonlyArray<{ label: string; ids: string[] }> = [
  { label: "Frontend and mobile stacks", ids: ["frontend-dev", "fullstack-dev", "android-native-dev", "react-native-dev", "flutter-dev"] },
  { label: "Document and office generators", ids: ["minimax-docx", "minimax-pdf", "minimax-xlsx", "pptx-generator"] },
  { label: "Planning and todo helpers", ids: ["planf3", "planning-and-task-breakdown", "write-todos", "todo-update"] },
  { label: "Self-improvement loops", ids: ["self-improve", "self-optimization-loop", "skill-evolution"] },
  { label: "Debugging and root-cause analysis", ids: ["5-why", "debugging-and-error-recovery"] },
];

export function SkillsView(props: SkillsViewProps) {
  const { skills, skillsStatus, skillsError, selectedSkillId, setSelectedSkillId, skillDetail, skillDetailStatus } = props;

  const mergeCandidates = useMemo(() => {
    const available = new Set(skills.map((skill) => skill.id));
    return MERGE_RULES
      .map((rule) => ({
        label: rule.label,
        ids: rule.ids.filter((id) => available.has(id)),
      }))
      .filter((group) => group.ids.length >= 2);
  }, [skills]);

  return (
    <section className="skills-view" aria-label="Skills registry">
      <div className="skills-header">
        <div><p className="section-label">Local Skills</p><h2>Lazy-loaded registry</h2></div>
        <span>{skillsStatus === "ready" ? `${skills.length} found` : skillsStatus}</span>
      </div>
      {skillsStatus === "error" ? (
        <p className="skills-error">{skillsError}</p>
      ) : (
        <div className="skills-layout">
          <div className="skills-list" aria-label="Available skills">
            {skillsStatus === "loading" ? (
              <p className="skills-muted">Scanning skill frontmatter...</p>
            ) : (
              skills.map((skill) => (
                <button className={skill.id === selectedSkillId ? "skill-row selected" : "skill-row"} key={skill.id} type="button" onClick={() => setSelectedSkillId(skill.id)}>
                  <span><strong>{skill.name}</strong><em>{skill.id}</em></span>
                  <small>{[skill.hasReferences ? "references" : null, skill.hasScripts ? "scripts" : null, skill.hasAssets ? "assets" : null, skill.hasAgentsMetadata ? "metadata" : null].filter(Boolean).join(" / ") || "single file"}</small>
                </button>
              ))
            )}
          </div>
          <div className="skill-detail" aria-live="polite">
            {!selectedSkillId ? (
              <div className="skill-placeholder"><h3>Select a skill</h3><p>Only metadata is loaded so far. Pick a skill to read its full instructions.</p></div>
            ) : skillDetailStatus === "loading" ? (
              <p className="skills-muted">Loading {selectedSkillId}...</p>
            ) : skillDetailStatus === "error" ? (
              <p className="skills-error">{skillsError}</p>
            ) : skillDetail ? (
              <>
                <div className="skill-detail-heading">
                  <div><h3>{skillDetail.summary.name}</h3><p>{skillDetail.summary.description || "No description in frontmatter."}</p></div>
                  <span>{skillDetail.body.length.toLocaleString()} chars</span>
                </div>
                <pre>{skillDetail.body}</pre>
              </>
            ) : (
              <div className="skill-placeholder"><h3>Ready</h3><p>Skill bodies remain unloaded until you choose one.</p></div>
            )}
          </div>
        </div>
      )}
      <section className="merge-panel" aria-label="Potential skill merges">
        <div className="skills-header compact">
          <div><p className="section-label">Audit</p><h2>Potential overlap</h2></div>
          <span>{mergeCandidates.length} groups</span>
        </div>
        {mergeCandidates.length === 0 ? (
          <p className="skills-muted">Load the registry to see overlap candidates.</p>
        ) : (
          mergeCandidates.map((group) => (
            <p key={group.label}><strong>{group.label}</strong><span>{group.ids.join(" / ")}</span></p>
          ))
        )}
      </section>
    </section>
  );
}