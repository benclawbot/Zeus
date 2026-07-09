import type { ProviderKeysStatus } from "../providers/providers";
import type { MinimalLevel } from "../providers/minimalCodeSkill";
import type { TerseLevel } from "../providers/terseOutputSkill";

interface ProviderKeyRow {
  id: "minimax" | "openai" | "anthropic";
  label: string;
  help: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

interface SettingsViewProps {
  terseLevel: TerseLevel;
  setTerseLevel: (value: TerseLevel) => void;
  minimalLevel: MinimalLevel;
  setMinimalLevel: (value: MinimalLevel) => void;
  providerKeysStatus: ProviderKeysStatus;
  providerKeyDrafts: Record<string, string>;
  setProviderKeyDrafts: (
    update: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  testResults: Record<
    string,
    { status: "running" | "ok" | "error"; message: string; baseUrl?: string; model?: string; preview?: string } | undefined
  >;
  handleSaveProviderKey: (id: ProviderKeyRow["id"], value: string) => Promise<void> | void;
  handleClearProviderKey: (id: ProviderKeyRow["id"]) => Promise<void> | void;
  handleTestProvider: (id: ProviderKeyRow["id"]) => Promise<void> | void;
  handleSaveProviderOverrides: (id: ProviderKeyRow["id"], baseUrl: string, model: string) => Promise<void> | void;
}

const PROVIDER_ROWS: ProviderKeyRow[] = [
  { id: "minimax", label: "MiniMax (MINIMAX_API_KEY)", help: "Default provider. Get a key from https://www.minimax.io/platform/user-center/basic-information/interface-key.", defaultBaseUrl: "https://api.minimax.io/v1", defaultModel: "MiniMax-M3" },
  { id: "openai", label: "OpenAI (OPENAI_API_KEY)", help: "Set if you want to route through OpenAI's API.", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic (ANTHROPIC_API_KEY)", help: "Set if you want to route through Anthropic's API.", defaultBaseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-3-5-sonnet-latest" },
];

const TERSE_LEVELS: ReadonlyArray<{ value: TerseLevel; label: string }> = [
  { value: "off", label: "off — baseline verbosity" },
  { value: "lite", label: "lite — drop preamble only" },
  { value: "full", label: "full — default terse mode" },
  { value: "ultra", label: "ultra — minimum grammatical form" },
];

const MINIMAL_LEVELS: ReadonlyArray<{ value: MinimalLevel; label: string }> = [
  { value: "off", label: "off" },
  { value: "lite", label: "lite — ladder steps 1–3" },
  { value: "full", label: "full — full ladder + audit comments" },
  { value: "strict", label: "strict — full + deviation justification" },
];

export function SettingsView(props: SettingsViewProps) {
  const {
    terseLevel,
    setTerseLevel,
    minimalLevel,
    setMinimalLevel,
    providerKeysStatus,
    providerKeyDrafts,
    setProviderKeyDrafts,
    testResults,
    handleSaveProviderKey,
    handleClearProviderKey,
    handleTestProvider,
    handleSaveProviderOverrides,
  } = props;

  return (
    <div className="utility-card settings-card">
      <div className="token-efficiency-row">
        <label className="token-efficiency-field">
          <span>Terse-output skill (Spec 04)</span>
          <select
            aria-label="Terse-output level"
            onChange={(event) => setTerseLevel(event.target.value as TerseLevel)}
            value={terseLevel}
          >
            {TERSE_LEVELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="token-efficiency-field">
          <span>Minimal-code skill (Spec 05)</span>
          <select
            aria-label="Minimal-code level"
            onChange={(event) => setMinimalLevel(event.target.value as MinimalLevel)}
            value={minimalLevel}
          >
            {MINIMAL_LEVELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="section-label">Provider API keys</p>
      <p className="skills-muted">Keys are stored in the app data folder and never leave your machine. The frontend never sees the raw value — only whether a key is configured.</p>
      {PROVIDER_ROWS.map((row) => {
        const savedBaseUrl = (providerKeysStatus as unknown as Record<string, string | null>)[`${row.id}BaseUrl`] ?? null;
        const savedModel = (providerKeysStatus as unknown as Record<string, string | null>)[`${row.id}Model`] ?? null;
        const draftBaseUrl = providerKeyDrafts[`${row.id}BaseUrl` as keyof typeof providerKeyDrafts] ?? "";
        const draftModel = providerKeyDrafts[`${row.id}Model` as keyof typeof providerKeyDrafts] ?? "";
        return (
          <form
            key={row.id}
            aria-label={row.label}
            className="provider-key-row"
            onSubmit={(event) => {
              event.preventDefault();
              const value = providerKeyDrafts[row.id];
              if (value.trim()) {
                void handleSaveProviderKey(row.id, value);
              }
              void handleSaveProviderOverrides(row.id, draftBaseUrl, draftModel);
            }}
          >
            <div className="provider-key-meta">
              <strong>{row.label}</strong>
              <span className={providerKeysStatus[row.id] ? "provider-key-status ok" : "provider-key-status missing"}>
                {providerKeysStatus[row.id] ? "configured" : "not configured"}
              </span>
            </div>
            <p className="skills-muted">{row.help}</p>
            <div className="provider-key-input-row">
              <input
                aria-label={`${row.label} value`}
                onChange={(event) => setProviderKeyDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                placeholder={providerKeysStatus[row.id] ? "•••••••• (leave blank to keep current)" : "paste your key here"}
                type="password"
                value={providerKeyDrafts[row.id]}
              />
              <button type="submit" disabled={!providerKeyDrafts[row.id].trim() && !draftBaseUrl.trim() && !draftModel.trim()}>Save</button>
              {providerKeysStatus[row.id] ? (
                <button type="button" onClick={() => void handleClearProviderKey(row.id)}>Clear</button>
              ) : null}
              <button
                type="button"
                disabled={!providerKeysStatus[row.id] || testResults[row.id]?.status === "running"}
                onClick={() => void handleTestProvider(row.id)}
              >
                {testResults[row.id]?.status === "running" ? "Testing…" : "Test connection"}
              </button>
            </div>
            <div className="provider-key-input-row">
              <label className="provider-key-field-label">
                <span>Base URL</span>
                <input
                  aria-label={`${row.label} base URL`}
                  onChange={(event) => setProviderKeyDrafts((current) => ({ ...current, [`${row.id}BaseUrl`]: event.target.value }))}
                  placeholder={`Default: ${row.defaultBaseUrl}`}
                  value={draftBaseUrl}
                />
              </label>
              <label className="provider-key-field-label">
                <span>Model</span>
                <input
                  aria-label={`${row.label} model`}
                  onChange={(event) => setProviderKeyDrafts((current) => ({ ...current, [`${row.id}Model`]: event.target.value }))}
                  placeholder={`Default: ${row.defaultModel}`}
                  value={draftModel}
                />
              </label>
            </div>
            {testResults[row.id] ? (() => {
              const test = testResults[row.id]!;
              return (
                <div className={test.status === "ok" ? "provider-test-result ok" : test.status === "error" ? "provider-test-result error" : "provider-test-result running"}>
                  {test.status === "running" ? "Testing…" : (
                    <>
                      <strong>{test.status === "ok" ? "OK" : "Failed"}</strong>
                      <span>{test.message}</span>
                      {test.baseUrl ? <small>base: {test.baseUrl}</small> : null}
                      {test.model ? <small>model: {test.model}</small> : null}
                      {test.preview ? <pre className="provider-test-preview">{test.preview}</pre> : null}
                    </>
                  )}
                </div>
              );
            })() : null}
            {savedBaseUrl || savedModel ? (
              <p className="skills-muted">
                Currently using: {savedBaseUrl ?? row.defaultBaseUrl}
                {savedModel ? ` · model: ${savedModel}` : ` · model: ${row.defaultModel} (default)`}
              </p>
            ) : null}
          </form>
        );
      })}
    </div>
  );
}