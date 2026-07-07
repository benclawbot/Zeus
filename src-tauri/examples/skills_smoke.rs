//! Smoke test: walk the bundled `skills/` directory the same way
//! `list_skills_from_dir` does and report how many skills load. Useful
//! to confirm the resolver hits the right path before chasing a
//! frontend bug.

use std::path::Path;

fn collect_skill_dirs(root: &Path, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() { continue; }
        if path.join("SKILL.md").is_file() {
            out.push(path);
        } else {
            collect_skill_dirs(&path, out)?;
        }
    }
    Ok(())
}

fn main() {
    let candidates = vec![
        std::env::var("ZEUS_SKILLS_DIR").ok().map(std::path::PathBuf::from),
        std::env::current_dir().ok().map(|c| c.join("skills")),
        std::env::current_dir().ok().map(|c| c.join("..").join("skills")),
        Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("skills")),
    ];
    for (idx, candidate) in candidates.into_iter().enumerate() {
        let Some(path) = candidate else { continue };
        if !path.is_dir() {
            println!("[{idx}] {} -> not a directory", path.display());
            continue;
        }
        let mut dirs = Vec::new();
        let collect_result = collect_skill_dirs(&path, &mut dirs);
        match collect_result {
            Ok(_) => {
                let with_skill_md: Vec<_> = dirs
                    .iter()
                    .filter(|d| d.join("SKILL.md").is_file())
                    .collect();
                println!("[{idx}] {} -> {} skill dirs ({} with SKILL.md)",
                    path.display(), dirs.len(), with_skill_md.len());
                for d in with_skill_md.iter().take(5) {
                    println!("       {}", d.display());
                }
            }
            Err(e) => println!("[{idx}] {} -> error: {e}", path.display()),
        }
    }
}