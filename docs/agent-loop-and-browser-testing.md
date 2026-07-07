# Agent loop, tool use, web research, and browser testing

This note records the production behavior Zeus should keep enforcing in code.

## Agent loop

Zeus must not stop after the first failed tool action. A failed tool result is an observation. The next loop iteration should classify the failure, preserve the exact output in context, pick a narrower next action, and only stop after the bounded recovery budget is exhausted or a policy guard requires a human decision.

Recommended loop:

1. define the objective;
2. produce a small plan;
3. execute one or a few safe tool calls;
4. observe structured output;
5. classify failures as workspace, argument, policy, transient, or unknown;
6. re-plan with the failure output;
7. verify with tests, focused reads, git diff, or browser checks;
8. summarize only after completion or a real blocker.

## Tool registry

Tools should be listed in the system prompt with exact schemas. Every tool result should return a normalized envelope with `ok`, `label`, `summary`, raw stdout/stderr when applicable, files touched, and recovery hints.

## Web research tool

A web research tool belongs in the same registry as file, shell, git, and test tools. It should be permission-gated by access mode and return source titles, urls, snippets, and retrieval timestamps. The agent should use it before changing behavior that depends on current external facts.

## Browser testing

Playwright should be available as a first-class verification tool for UI tasks. It should support headless and headed execution, retain screenshots/traces on failure, and feed failure artifacts back into the agent loop so Zeus can repair generated UI instead of just stopping.
