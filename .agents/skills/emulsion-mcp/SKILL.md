---
name: emulsion-mcp
description: Use the Emulsion desktop MCP server to inspect and automate the live TipTap story/blog editor, verify draft persistence, and write focused MCP regression cases. Apply when testing or changing packages/emulsion-mcp, desktop/automation.go, or the editor automation bridge; do not use for unrelated MCP servers.
---

# Emulsion MCP

This skill is the compact operating guide for the development-only Emulsion MCP integration. It is also the maintained capability index: do not rediscover the MCP source for ordinary test-case writing.

## Scope and source of truth

- MCP server: `packages/emulsion-mcp/src/index.ts` (stdio, JSON-RPC via the MCP SDK).
- Desktop bridge: `desktop/automation.go` and `desktop/frontend/src/lib/editor-automation.ts` (opt-in loopback HTTP plus Wails events).
- Persistence: `desktop/db/drafts_local.go` / `drafts.db` through the `draft_*` tools.
- Existing behavioral evidence: `docs/emulsion-tiptap-markdown-test-report.md` and `docs/emulsion-tiptap-toolbar-style-coverage.md`.

Read [references/tools.md](references/tools.md) for the tool catalog and contracts. Read [references/testing.md](references/testing.md) for startup, test sequencing, save/restore, and known limitations. Only read implementation files when the references are stale or the task changes the protocol.

## Operating workflow

1. Start Emulsion with automation explicitly enabled: `cd desktop; wails dev -appargs "--automation"` (or set `EMULSION_AUTOMATION=1`). Never assume the endpoint exists in a release build.
2. Build the MCP server when source changed: `pnpm --filter @mo-gallery/emulsion-mcp build` (equivalent project script: `pnpm run desktop:mcp:build`). Run it from the repository root or configure an MCP client with `node packages/emulsion-mcp/dist/index.js`.
3. Check `emulsion_status`, then `editor_status`/`app_location`. Open a target with `editor_open_document` before editor operations; pass `documentId` and `documentKind` when more than one target may be mounted.
4. For destructive scenarios, call `draft_get` first and restore the complete returned `data` with `draft_restore` in teardown. Use `editor_compare_draft` after autosave when persistence is part of the assertion.
5. Prefer real UI paths exposed by the MCP (toolbar click/select/color and keyboard events) over direct DOM or TipTap command calls. Treat tool errors as test results, not as permission to bypass the bridge.
6. Design cases around a real user task and its complete interaction logic, not around one MCP tool. A normal case may chain navigation, document opening, mixed typing/keyboard/toolbar actions, intermediate state checks, autosave comparison, and restoration. Keep the scenario reproducible and bounded, but do not split a complex workflow into tiny cases that miss state transitions. Single-tool checks are for protocol smoke tests or isolating a known failure only. The repository guideline says not to add test code unless necessary; use an MCP runbook/report for manual regressions and add automated tests only when a protocol or shared behavior change warrants it.

## Maintenance contract

When changing any MCP tool name, schema, description, allowed automation method, route, editor command, menu, draft payload, or lifecycle behavior:

- Update this skill's relevant reference table and examples in the same change.
- Update `packages/emulsion-mcp/README.md` if user-facing startup or usage changed.
- Update the two Emulsion test reports when a known limitation or expected result changes.
- Keep every test-case table in those reports on the fixed eight-column format documented in `references/testing.md` (case id, title, user steps, MCP steps, expected, actual, original judgment, retest judgment). When a fix is verified, write the new outcome in the retest-judgment column rather than rewriting the historical judgment.
- Run the MCP build; for bridge/editor changes also run the smallest applicable desktop/frontend build or Go build. Record failures caused by unrelated baseline issues instead of hiding them.

Do not document capabilities that are not registered in `packages/emulsion-mcp/src/index.ts` and accepted by `desktop/automation.go`.
