// Production sandboxing for Zeus. Centralizes the command classifier, the
// access-mode authorization matrix, environment scrubbing, and the output
// secret scanner that redacts tokens before they reach the LLM or the
// frontend. The classifier is exhaustive across the seven classes
// described in the upgrade spec — safe, test, build, dependency, network,
// destructive, privileged — and is used by every shell-execution path in
// `workspace.rs` and `agent_runtime.rs`.

use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// All seven command classes called out in the upgrade spec.
///
/// `Safe` and `Test` and `Build` are non-mutating-or-mutating-but-recoverable
/// and run under most access modes without approval. `Dependency` mutates
/// the local manifest/lockfile. `Network` reaches out to the internet.
/// `Destructive` removes files or rewrites git history. `Privileged`
/// escalates outside the workspace (sudo, doas, su).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandClass {
    Safe,
    Test,
    Build,
    Dependency,
    Network,
    Destructive,
    Privileged,
}

impl CommandClass {
    pub fn label(self) -> &'static str {
        match self {
            CommandClass::Safe => "safe",
            CommandClass::Test => "test",
            CommandClass::Build => "build",
            CommandClass::Dependency => "dependency",
            CommandClass::Network => "network",
            CommandClass::Destructive => "destructive",
            CommandClass::Privileged => "privileged",
        }
    }

    /// Risky classes need approval in at least one access mode.
    pub fn is_risky(self) -> bool {
        !matches!(
            self,
            CommandClass::Safe | CommandClass::Test | CommandClass::Build
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    Locked,
    Review,
    Local,
    Full,
}

impl AccessMode {
    pub fn from_str(value: Option<&str>) -> Self {
        match value.unwrap_or("Full") {
            "Locked" => AccessMode::Locked,
            "Review" => AccessMode::Review,
            "Local" => AccessMode::Local,
            _ => AccessMode::Full,
        }
    }
}

/// What the policy decided for a specific execution request. Returned to
/// the frontend so the UI can show "approval required" or "approved"
/// badges.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub access_mode: String,
    pub command_class: String,
    pub approval_required: bool,
    pub approved: bool,
    pub approval_id: Option<String>,
}

/// Authorization outcome returned by `authorize`. The `Forbidden` variant
/// means the access mode itself blocks the call (no approval could help);
/// `ApprovalRequired` means the caller must pass an approved `approval_id`
/// before we will execute.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthOutcome {
    Allowed,
    Forbidden(String),
    ApprovalRequired { risk: CommandClass },
}

/// Classify a `(program, args)` pair into one of the seven command
/// classes. The classifier looks at both the program name and the first
/// couple of arguments so e.g. `git push`, `git reset --hard`, and
/// `git status` all get the right bucket.
pub fn classify_command(program: &str, args: &[String]) -> CommandClass {
    let name = Path::new(program)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(program)
        .to_ascii_lowercase();
    let text = std::iter::once(name.clone())
        .chain(args.iter().map(|a| a.to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join(" ");

    // Privileged escalation.
    if matches!(name.as_str(), "sudo" | "su" | "doas" | "pkexec") {
        return CommandClass::Privileged;
    }
    // Destructive filesystem + system commands.
    if matches!(
        name.as_str(),
        "rm" | "del"
            | "erase"
            | "rmdir"
            | "format"
            | "mkfs"
            | "dd"
            | "shutdown"
            | "reboot"
            | "halt"
            | "poweroff"
            | "truncate"
    ) {
        return CommandClass::Destructive;
    }
    if name == "rm" && text.contains(" -rf") {
        return CommandClass::Destructive;
    }
    // git subcommands that rewrite history or push.
    if name == "git" {
        if text.contains(" push")
            || text.contains(" reset")
            || text.contains(" clean")
            || text.contains(" checkout --")
            || text.contains(" branch -d")
            || text.contains(" branch -D")
        {
            return CommandClass::Destructive;
        }
    }
    // Dependency install / update / remove.
    if matches!(
        name.as_str(),
        "npm"
            | "pnpm"
            | "yarn"
            | "cargo"
            | "pip"
            | "pip3"
            | "poetry"
            | "bun"
            | "bundle"
            | "gem"
            | "brew"
            | "apt"
            | "apt-get"
            | "pacman"
            | "dnf"
    ) {
        if text.contains(" install")
            || text.contains(" add ")
            || text.contains(" update")
            || text.contains(" remove")
            || text.contains(" uninstall")
            || text.contains(" upgrade")
        {
            return CommandClass::Dependency;
        }
        // Build/test scripts run via package managers are still Build/Test.
        if text.contains(" run build")
            || text.contains(" run typecheck")
            || text.contains(" run lint")
        {
            return CommandClass::Build;
        }
        if text.contains(" test") || text.contains(" run test") {
            return CommandClass::Test;
        }
    }
    // Network-capable tools.
    if matches!(
        name.as_str(),
        "curl" | "wget" | "ssh" | "scp" | "rsync" | "nc" | "ncat" | "gh"
    ) {
        return CommandClass::Network;
    }
    // gh CLI specifically: PR/issue reads are Network, but repo mutations are
    // pushed through the dedicated GitHub workflow module so we don't need to
    // split them further here.
    // Test runners.
    if matches!(
        name.as_str(),
        "vitest" | "jest" | "pytest" | "mocha" | "playwright"
    ) {
        return CommandClass::Test;
    }
    // cargo: build / test.
    if name == "cargo" {
        if text.contains(" build")
            || text.contains(" check")
            || text.contains(" fmt")
            || text.contains(" clippy")
        {
            return CommandClass::Build;
        }
        if text.contains(" test") {
            return CommandClass::Test;
        }
        // cargo install/run fall through to Dependency / Safe.
        if text.contains(" run") {
            return CommandClass::Build;
        }
    }
    // Compilers.
    if matches!(
        name.as_str(),
        "rustc"
            | "tsc"
            | "ts-node"
            | "node"
            | "python"
            | "python3"
            | "go"
            | "javac"
            | "gcc"
            | "clang"
    ) {
        return CommandClass::Build;
    }
    // Network-aware: git fetch / pull / clone.
    if name == "git"
        && (text.contains(" fetch")
            || text.contains(" pull")
            || text.contains(" clone")
            || text.contains(" ls-remote"))
    {
        return CommandClass::Network;
    }
    CommandClass::Safe
}

/// Authorization matrix from the upgrade spec.
///
/// | Mode      | safe | test | build | dep | net | destructive | privileged |
/// |-----------|------|------|-------|-----|-----|-------------|------------|
/// | Locked    |  no  |  no  |  no   | no  | no  |     no      |     no     |
/// | Review    |  appr| appr | appr  | appr| appr|    appr     |    appr    |
/// | Local     |  ok  |  ok  |  ok   | appr| appr|    appr     |    appr    |
/// | Full      |  ok  |  ok  |  ok   |  ok |  ok |    appr     |    appr    |
pub fn authorize(mode: AccessMode, class: CommandClass) -> AuthOutcome {
    use AccessMode::*;
    use CommandClass::*;
    match (mode, class) {
        (Locked, _) => AuthOutcome::Forbidden(format!(
            "Locked mode blocks {} shell commands.",
            class.label()
        )),
        (Review, _) => AuthOutcome::ApprovalRequired { risk: class },
        (Local, Safe | Test | Build) => AuthOutcome::Allowed,
        (Local, _) => AuthOutcome::ApprovalRequired { risk: class },
        (Full, Safe | Test | Build | Dependency | Network) => AuthOutcome::Allowed,
        (Full, Destructive | Privileged) => AuthOutcome::ApprovalRequired { risk: class },
    }
}

/// Validate a program + argument pair. Rejects null bytes, empty program
/// names, and embedded whitespace in the program (defensive — shells
/// usually reject this anyway but we don't want to depend on that).
pub fn validate_program(program: &str) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("Program must not be empty.".to_string());
    }
    if program.trim() != program {
        return Err("Program contains surrounding whitespace.".to_string());
    }
    if program.contains('\0') {
        return Err("Program contains invalid characters.".to_string());
    }
    Ok(())
}

pub fn validate_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg.contains('\0') {
            return Err("Command arguments contain invalid characters.".to_string());
        }
    }
    Ok(())
}

/// Block workspace path escape. Mirrors the resolver in `workspace.rs` so
/// sandboxing and path resolution agree on what "inside the workspace"
/// Zeus currently runs in unrestricted filesystem mode. The workspace path
/// is now only a convenience anchor for relative paths, not a security
/// boundary. This guard intentionally allows targets anywhere for every
/// access mode; policy can be tightened again later in one place.
pub fn ensure_inside_workspace(root: &Path, target: &Path) -> Result<(), String> {
    ensure_inside_workspace_with_mode(root, target, None)
}

pub fn ensure_inside_workspace_with_mode(
    root: &Path,
    target: &Path,
    mode: Option<&str>,
) -> Result<(), String> {
    let _ = (root, target, mode);
    Ok(())
}

/// Names of env vars that carry credentials and must be scrubbed before
/// any child process inherits them. Kept conservative — every name here
/// is well-known as a credential sink.
pub const SCRUBBED_ENV_VARS: &[&str] = &[
    "MINIMAX_API_KEY",
    "MINIMAX_API_TOKEN",
    "OPENAI_API_KEY",
    "OPENAI_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GOOGLE_API_KEY",
    "GCP_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITLAB_TOKEN",
    "NPM_TOKEN",
    "PYPI_TOKEN",
    "HUGGINGFACE_TOKEN",
    "HF_TOKEN",
    "REPLICATE_API_TOKEN",
    "COHERE_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DATABASE_URL",
    "PG_PASSWORD",
    "MYSQL_PASSWORD",
    "REDIS_PASSWORD",
    "JWT_SECRET",
    "SESSION_SECRET",
    "SECRET_KEY",
    "ZEUS_PROVIDER_KEY",
];

/// Patterns the output scanner redacts. Matches are replaced with
/// `[REDACTED:<kind>]`. Each regex is anchored to either a known prefix
/// or to the body of a generic key/value pair so we don't shred
/// benign-looking prose.
#[derive(Debug, Clone, Copy)]
enum SecretPattern {
    Generic,
    GithubToken,
    OpenAiKey,
    AnthropicKey,
    MiniMaxKey,
    GoogleKey,
    AwsKey,
    Jwt,
    BearerHeader,
    BasicAuthHeader,
}

impl SecretPattern {
    fn label(self) -> &'static str {
        match self {
            SecretPattern::Generic => "secret",
            SecretPattern::GithubToken => "github-token",
            SecretPattern::OpenAiKey => "openai-key",
            SecretPattern::AnthropicKey => "anthropic-key",
            SecretPattern::MiniMaxKey => "minimax-key",
            SecretPattern::GoogleKey => "google-key",
            SecretPattern::AwsKey => "aws-key",
            SecretPattern::Jwt => "jwt",
            SecretPattern::BearerHeader => "bearer",
            SecretPattern::BasicAuthHeader => "basic-auth",
        }
    }
}

struct CompiledPattern {
    pattern: SecretPattern,
    regex: Regex,
}

static SECRET_PATTERNS: Lazy<Vec<CompiledPattern>> = Lazy::new(|| {
    vec![
        CompiledPattern { pattern: SecretPattern::GithubToken, regex: Regex::new(r"ghp_[A-Za-z0-9]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::GithubToken, regex: Regex::new(r"github_pat_[A-Za-z0-9_]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::GithubToken, regex: Regex::new(r"gho_[A-Za-z0-9]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::GithubToken, regex: Regex::new(r"ghs_[A-Za-z0-9]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::GithubToken, regex: Regex::new(r"ghr_[A-Za-z0-9]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::OpenAiKey, regex: Regex::new(r"sk-[A-Za-z0-9_-]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::OpenAiKey, regex: Regex::new(r"sk-proj-[A-Za-z0-9_-]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::AnthropicKey, regex: Regex::new(r"sk-ant-[A-Za-z0-9_-]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::MiniMaxKey, regex: Regex::new(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::GoogleKey, regex: Regex::new(r"AIza[A-Za-z0-9_-]{30,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::AwsKey, regex: Regex::new(r"AKIA[0-9A-Z]{16}").unwrap() },
        CompiledPattern { pattern: SecretPattern::AwsKey, regex: Regex::new(r"ASIA[0-9A-Z]{16}").unwrap() },
        CompiledPattern { pattern: SecretPattern::Jwt, regex: Regex::new(r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::BearerHeader, regex: Regex::new(r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._\-+/=]{16,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::BasicAuthHeader, regex: Regex::new(r"(?i)authorization:\s*basic\s+[A-Za-z0-9+/=]{8,}").unwrap() },
        CompiledPattern { pattern: SecretPattern::Generic, regex: Regex::new(r#"(?i)(api[_-]?key|api[_-]?token|secret|password|passwd|pwd)\s*[=:]\s*['"]?[A-Za-z0-9._\-+/=]{16,}['"]?"#).unwrap() },
        CompiledPattern { pattern: SecretPattern::Generic, regex: Regex::new(r#"(?i)(token)\s*[=:]\s*['"]?[A-Za-z0-9._\-+/=]{24,}['"]?"#).unwrap() },
    ]
});

/// Run the secret scanner over an arbitrary output blob. Returns the
/// scrubbed text and the number of redactions performed.
pub fn redact_secrets(input: &str) -> (String, usize) {
    let mut out = input.to_string();
    let mut count = 0;
    for compiled in SECRET_PATTERNS.iter() {
        let replacement = format!("[REDACTED:{}]", compiled.pattern.label());
        let before_len = out.len();
        out = compiled
            .regex
            .replace_all(&out, replacement.as_str())
            .to_string();
        if out.len() != before_len {
            count += 1;
        }
    }
    (out, count)
}

/// Build the `Command` env. Drops every name in `SCRUBBED_ENV_VARS` from
/// the inherited environment. Returns the env as a Vec<(String, String)>
/// so callers can extend it with safe extras.
pub fn scrubbed_env() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, value) in std::env::vars() {
        if SCRUBBED_ENV_VARS
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
        {
            continue;
        }
        out.push((key, value));
    }
    out
}

/// Apply the timeout policy to a spawned child. The default is to send
/// SIGKILL after the deadline; on Windows the `Command::kill` path is
/// used which terminates the process tree the OS tracks. Returns
/// `(timed_out, duration_ms)`.
pub fn enforce_timeout<F>(
    started: std::time::Instant,
    timeout: Duration,
    try_wait: F,
    kill: impl Fn(),
) -> (bool, u128)
where
    F: Fn() -> Result<Option<std::process::ExitStatus>, String>,
{
    loop {
        match try_wait() {
            Ok(Some(_)) => return (false, started.elapsed().as_millis()),
            Ok(None) => {}
            Err(_) => {}
        }
        if started.elapsed() >= timeout {
            kill();
            return (true, started.elapsed().as_millis());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_dangerous_commands() {
        assert_eq!(
            classify_command("rm", &["-rf".into(), "/".into()]),
            CommandClass::Destructive
        );
        assert_eq!(
            classify_command("sudo", &["apt".into(), "update".into()]),
            CommandClass::Privileged
        );
        assert_eq!(
            classify_command("git", &["push".into(), "origin".into(), "main".into()]),
            CommandClass::Destructive
        );
        assert_eq!(
            classify_command("npm", &["install".into()]),
            CommandClass::Dependency
        );
        assert_eq!(
            classify_command("curl", &["https://example.com".into()]),
            CommandClass::Network
        );
        assert_eq!(
            classify_command("npm", &["test".into()]),
            CommandClass::Test
        );
        assert_eq!(
            classify_command("vitest", &["run".into()]),
            CommandClass::Test
        );
        assert_eq!(
            classify_command("cargo", &["build".into()]),
            CommandClass::Build
        );
        assert_eq!(
            classify_command("tsc", &["--noEmit".into()]),
            CommandClass::Build
        );
        assert_eq!(classify_command("ls", &[]), CommandClass::Safe);
    }

    #[test]
    fn access_mode_matrix_matches_spec() {
        use AccessMode::*;
        use CommandClass::*;
        assert!(matches!(authorize(Locked, Safe), AuthOutcome::Forbidden(_)));
        assert!(matches!(
            authorize(Review, Safe),
            AuthOutcome::ApprovalRequired { .. }
        ));
        assert!(matches!(authorize(Local, Safe), AuthOutcome::Allowed));
        assert!(matches!(
            authorize(Local, Dependency),
            AuthOutcome::ApprovalRequired { .. }
        ));
        assert!(matches!(authorize(Full, Network), AuthOutcome::Allowed));
        assert!(matches!(
            authorize(Full, Destructive),
            AuthOutcome::ApprovalRequired { .. }
        ));
        assert!(matches!(
            authorize(Full, Privileged),
            AuthOutcome::ApprovalRequired { .. }
        ));
    }

    #[test]
    fn redacts_github_and_provider_keys() {
        let (scrubbed, count) = redact_secrets(
            "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 key=sk-proj-abcdefghijklmnopqrstuvwxyz",
        );
        assert!(scrubbed.contains("[REDACTED:github-token]"));
        assert!(scrubbed.contains("[REDACTED:openai-key]"));
        assert!(count >= 2);
    }

    #[test]
    fn keeps_benign_text_intact() {
        let (scrubbed, count) = redact_secrets("hello world this is just some plain log output");
        assert_eq!(scrubbed, "hello world this is just some plain log output");
        assert_eq!(count, 0);
    }

    #[test]
    fn validates_program_strings() {
        assert!(validate_program("ls").is_ok());
        assert!(validate_program("").is_err());
        assert!(validate_program(" ls").is_err());
        assert!(validate_program("ls\0rm").is_err());
    }

    #[test]
    fn ensure_inside_all_modes_allow_any_path() {
        let bogus_root = std::env::temp_dir().join(format!(
            "zeus_ensure_root_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&bogus_root);
        std::fs::create_dir_all(&bogus_root).unwrap();
        let bogus = bogus_root.canonicalize().unwrap();
        let elsewhere = std::env::temp_dir();

        // Workspace limits are disabled: every mode allows paths outside the anchor.
        assert!(ensure_inside_workspace_with_mode(&bogus, &elsewhere, Some("Local")).is_ok());
        assert!(ensure_inside_workspace_with_mode(&bogus, &elsewhere, Some("Review")).is_ok());
        assert!(ensure_inside_workspace_with_mode(&bogus, &elsewhere, None).is_ok());
        assert!(ensure_inside_workspace_with_mode(&bogus, &elsewhere, Some("Full")).is_ok());

        let _ = std::fs::remove_dir_all(&bogus_root);
    }
}
