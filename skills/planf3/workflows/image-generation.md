# Image Generation

Fill or update the embedded images in an existing plan `.html` file. Pick the sub-workflow based on the incoming `USER_PROMPT`:

| Sub-workflow | When to call it |
| --- | --- |
| Create | The prompt asks to generate, fill, or add the plan's images from scratch (empty `{{...IMAGE` slots) |
| Update | The prompt asks to change, refine, regenerate, or replace images that already exist in the plan |

Scripts (run with `uv run`; the scripts source `OPENAI_API_KEY` from `~/.claude/skills/planf3/.env` automatically — see pre-flight below):
- Create image: `uv run scripts/generate_gpt_image.py "<prompt>" <output.png> --size 1024x640 --quality high`
- Edit image: `uv run scripts/edit_gpt_image.py "<instruction>" <output.png> <input.png> --size 1024x640 --quality high`

## Pre-flight (mandatory before the first image call)

`OPENAI_API_KEY` is sourced from `~/.claude/skills/planf3/.env` (maintained by `hermes-oauth-openai-codex`). The scripts re-read the .env on every invocation, so no shell restart is needed.

1. Check `~/.claude/skills/planf3/.env` exists. If missing, install + run:
   ```
   pip install --user C:\Users\thoma\hermes-oauth-openai-codex
   hermes-oauth-codex login
   ```
2. Decode the JWT in `OPENAI_API_KEY` (any tool, or `python -c "import base64,json; print(json.loads(base64.urlsafe_b64decode(os.environ['OPENAI_API_KEY'].split('.')[1]+'==').decode())['exp'])"`). If `exp` is within ~48 hours, the next `generate_gpt_image.py` call will auto-refresh via `_codex_common.refresh_if_needed()`. If the refresh fails (revoked refresh token, network down), surface the unblock command in the chat reply and stop the image generation step.

Never ask the user to paste an API key when the OAuth module is installed — the right unblock is always `hermes-oauth-codex login` (or `hermes-oauth-codex refresh` if the access token has expired but the refresh token is still good).

## Shared rules

- always generate in a wide aspect (`--size 1024x640`, ~16:10) at high quality (`--quality high`) — small enough to embed inline without breaking the page, large enough to stay sharp on retina. Avoid `1536x1024` for inline use; reserve it for hero/banner usage where the larger surface is justified.
- always constrain the image in the plan's CSS so it fits inside its `<figure>` regardless of source size. The minimum rule:
  ```css
  figure img { max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: var(--r-md); }
  ```
  Add this once to the plan's `<style>` block; every figure on the page scales automatically.
- **Anchor every prompt in the section it illustrates.** Before writing the prompt, open the plan file and read the section's `<h2>`/`<h3>` heading and the first paragraph after it. The prompt must reference the *specific* entities, terms, and relationships named in that section — not abstract shapes that could illustrate any plan. A reader who only sees the image (no surrounding text) should be able to tell which section of the plan it belongs to.
- **Prompt structure** — use this template:
  ```
  Visualize [the specific concept this section teaches, in one sentence].
  Show [the 1–4 named entities, modules, files, or relationships that appear in the section, by name].
  Layout: [a concrete spatial arrangement that reflects the actual relationship — funnel, sequence, two-column, side-by-side, before/after, etc.].
  Style: indigo gradient background, minimal, professional, technical.
  Text shown in image: [list any labels the image must render, total ≤ 10 words; omit this line if the image carries no text].
  ```
  Concrete entity names beat abstract labels every time. "ProjectProfile → ContextOptimizer" is better than "Step 1 → Step 2". "JSON / YAML / CSV / ZIP / Office / PDF / Markdown validators" is better than "validators".
- convey the one or two core ideas of that section for a professional software engineer
- match the plan's synced visual identity (professional, focused, minimal)
- keep total words shown in the image under 10
- save images to `IMAGES_OUTPUT_DIR` (create it if missing)

## Prompt quality checklist (run before generating)

Before running `generate_gpt_image.py` for any slot, walk this list. If any answer is "no", rewrite the prompt.

1. Did I read the section this image illustrates, or am I working from the placeholder comment alone?
2. Does the prompt name at least two specific entities (modules, files, relationships, concepts) that appear in that section's text?
3. Does the spatial arrangement I described match the *actual* relationship (funnel for "narrowing", sequence for "ordered steps", two-column for "split routing", before/after for "transformation")?
4. Is the visual style consistent with the rest of the plan (indigo gradient, minimal, technical)?
5. Will the labels the image renders total under 10 words?

## Good vs. bad prompts

| Section context | Bad prompt (generic — do not use) | Good prompt (anchored — what to write) |
| --- | --- | --- |
| Phase 1 introduces `schema.py`, `classifier.py`, `contract.py`, `config.py`, `policy.py` | "Row of four connected boxes, indigo background" | "Five labeled boxes in a row: schema → classifier → contract → policy, sitting on a ruamel.yaml round-trip backbone, indigo gradient background" |
| Problem section describes "model self-attests 'done' without test evidence" | "Speech bubble with question mark, indigo background" | "A 'Done?' chat bubble above scattered broken artifacts: a missing test report, a torn PDF, an oversized diff, an ungrounded README claim, indigo background" |
| Phase 3 introduces the seven artifact validators | "Funnel with checkmarks, indigo background" | "Funnel labeled 'Verifier' with seven labeled input streams: tests, build, lint, typecheck, JSON, PDF, Markdown; green checks on passed, red X on failed, indigo gradient background" |
| Phase 10 routes ChatGPT 5.5 to plan / verify and MiniMax M3 to implement | "Two columns, indigo background" | "Two columns of labeled stage cards: left 'ChatGPT 5.5' with plan / spec-clarify / verify / hard-debug / review; right 'MiniMax M3' with implement / multi-file build / long-context reader / cost-sensitive loop; indigo gradient background" |

## Anti-patterns to avoid

- **Generic geometric shapes** ("boxes", "circles", "arrows") with no specific entities named — these read as template art, not as plan illustrations.
- **Abstract labels** ("Step 1", "Process A", "Module") instead of the actual module / phase / file names from the section.
- **Illustrating the *shape* of a relationship** (e.g., "funnel") without showing *what* flows through it.
- **Repeating the section title as the only text in the image** — the title is already on the page; the image must add visual information that the title alone doesn't carry.
- **Two images that look interchangeable.** If swapping two images produces no visible difference, at least one of them is not anchored to its section.

## Create

1. Find slots - Grep the plan for `{{...IMAGE` placeholders (hero + per-phase). Each comment names the intended subject.
2. **Anchor each prompt in its section.** For every slot, open the plan file, locate the surrounding `<section>` or `.phase`, read its heading + first paragraph, and write the prompt using the structure under "Shared rules" above. The placeholder comment is a starting hint, not the prompt.
3. Run the prompt through the quality checklist before generating.
4. Generate - Run `generate_gpt_image.py` once per slot, writing to `IMAGES_OUTPUT_DIR`.
5. Embed - Replace each `<!-- {{...IMAGE: ...}} -->` placeholder with `<img src="<plan-name>/<file>.png" alt="...">`, keeping the existing `<figure>`/`<figcaption>`. The `alt` text should name the specific entities in the image, not just say "diagram" — screen readers and grep will thank you.
6. Report - List the images generated and the slots filled. For each, include the one-line section heading it illustrates, so the user can verify the anchoring.

## Update

1. Identify targets - From the `USER_PROMPT`, determine which embedded `<img>` images to change.
2. Write instruction - Write an edit instruction describing the change, following the shared rules above.
3. Edit - Run `edit_gpt_image.py` with the existing PNG as input, overwriting it (the script backs up the original first).
4. Verify embed - Confirm the `<img>` still points at the updated file; update `src`/`alt`/`<figcaption>` if the change warrants it.
5. Report - List the images updated and what changed.
