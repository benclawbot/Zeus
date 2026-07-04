# /// script
# requires-python = ">=3.10"
# dependencies = ["rich"]
# ///

"""
Skill Evolution Memory Manager

Manages .pi/skill-memory.json with structured feedback tracking.
"""

import json
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

MEMORY_FILE = Path(".pi/skill-memory.json")


def load_memory() -> dict:
    """Load existing memory or create empty structure."""
    if MEMORY_FILE.exists():
        with open(MEMORY_FILE) as f:
            return json.load(f)
    return {"lessons": [], "gaps": [], "patterns": []}


def save_memory(memory: dict) -> None:
    """Save memory to disk."""
    MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(MEMORY_FILE, "w") as f:
        json.dump(memory, f, indent=2)


def add_entry(
    category: Literal["lessons", "gaps", "patterns"],
    skill: str,
    content: str,
    **kwargs,
) -> str:
    """Add an entry to the skill memory."""
    memory = load_memory()

    entry = {
        "id": str(uuid.uuid4())[:8],
        "skill": skill,
        "timestamp": datetime.now().isoformat()[:19] + "Z",
    }

    if category == "lessons":
        entry["pattern"] = content
        entry["success"] = kwargs.get("success", True)
        if "context" in kwargs:
            entry["context"] = kwargs["context"]

    elif category == "gaps":
        entry["gap"] = content
        entry["suggestion"] = kwargs.get("suggestion", "")
        entry["priority"] = kwargs.get("priority", "medium")

    elif category == "patterns":
        entry["pattern"] = content
        if "example" in kwargs:
            entry["example"] = kwargs["example"]
        entry["confidence"] = kwargs.get("confidence", "medium")

    memory[category].append(entry)
    save_memory(memory)

    return entry["id"]


def get_skill_insights(skill: str) -> dict:
    """Get all entries related to a specific skill."""
    memory = load_memory()

    return {
        "lessons": [e for e in memory["lessons"] if e["skill"] == skill],
        "gaps": [e for e in memory["gaps"] if e["skill"] == skill],
        "patterns": [e for e in memory["patterns"] if e["skill"] == skill],
    }


def suggest_improvements(skill: str) -> str:
    """Generate improvement suggestions for a skill."""
    insights = get_skill_insights(skill)

    if not any(insights.values()):
        return f"No accumulated knowledge for skill: {skill}"

    lines = [f"## Skill: {skill}\n"]

    if insights["lessons"]:
        lines.append("### Lessons Learned")
        for lesson in insights["lessons"]:
            lines.append(f"- {lesson['pattern']}")
        lines.append("")

    if insights["patterns"]:
        lines.append("### Patterns to Codify")
        for pattern in insights["patterns"]:
            example = pattern.get("example", "")
            conf = pattern.get("confidence", "medium")
            lines.append(f"- [{conf}] {pattern['pattern']}")
            if example:
                lines.append(f"  Example: `{example}`")
        lines.append("")

    if insights["gaps"]:
        lines.append("### Gaps to Fill")
        for gap in insights["gaps"]:
            suggestion = gap.get("suggestion", "")
            priority = gap.get("priority", "medium")
            lines.append(f"- [{priority}] {gap['gap']}")
            if suggestion:
                lines.append(f"  → {suggestion}")
        lines.append("")

    # Count entries for confidence
    total = sum(len(v) for v in insights.values())
    lines.append(f"### Recommended Changes")
    lines.append(f"Based on {total} accumulated entries, consider updating SKILL.md or references.")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: skill-memory.py <command> [args...]")
        print("Commands:")
        print("  add <category> <skill> <content>")
        print("  get <skill>")
        print("  suggest <skill>")
        print("  list")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "add":
        category = sys.argv[2]
        skill = sys.argv[3]
        content = sys.argv[4]
        entry_id = add_entry(category, skill, content)
        print(f"Added entry: {entry_id}")

    elif cmd == "get":
        skill = sys.argv[2]
        insights = get_skill_insights(skill)
        print(json.dumps(insights, indent=2))

    elif cmd == "suggest":
        skill = sys.argv[2]
        print(suggest_improvements(skill))

    elif cmd == "list":
        memory = load_memory()
        for cat in ["lessons", "gaps", "patterns"]:
            print(f"\n### {cat.title()}")
            for entry in memory[cat]:
                print(f"  [{entry['skill']}] {entry.get('pattern', entry.get('gap', ''))}")

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
