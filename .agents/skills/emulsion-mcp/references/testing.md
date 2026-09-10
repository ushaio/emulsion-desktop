# Emulsion MCP testing playbook

## Minimal startup

```powershell
cd desktop
wails dev -appargs "--automation"
```

In another terminal, build the server when needed:

```powershell
pnpm --filter @mo-gallery/emulsion-mcp build
node packages/emulsion-mcp/dist/index.js
```

An MCP client connects to the last command over stdio. The server discovers `automation.json`; `EMULSION_AUTOMATION_FILE` can override its path for isolated runs.

## Deterministic editor setup

1. Call `emulsion_status`.
2. Call `editor_status` and use `data.activeTarget` (or call `app_location`) to obtain `documentId` and `documentKind`.
3. Call `editor_open_document` with `source: "draft"`.
4. For a mutation case, call `draft_get` with `story_editor_<documentId>` or `blog_draft_<documentId>` and retain the entire `data` object.
5. Use `editor_set_content` with empty content, then construct Markdown/list input with `editor_type_text` and `editor_press_key` so input rules and keymaps are exercised.

## High-value regression sequences

## Case template

Use this shape for a new manual MCP regression report. A case represents a meaningful user workflow or acceptance goal, not an isolated tool invocation. Combine the dependent actions a user would perform, preserve the resulting state between steps, and assert both intermediate transitions and the final user-visible outcome. Split a case only when setup, teardown, or expected behavior is genuinely independent. Every case-result table must use exactly these columns, in this order:

`编号 | 标题 | 用户角度操作步骤 | MCP调用步骤 | 预期结果 | 实际结果 | 判断 | 复测判定`

`判断` records the result of the original run. `复测判定` is the authoritative post-fix result; use `待复测` when no fix verification has been run yet, and do not erase the historical judgment.

```markdown
### <case id> <short name>

- Target: `{ documentId: "...", documentKind: "story|blog" }`
- Draft key: `story_editor_<id>` or `blog_draft_<id>`
- Preconditions: Emulsion automation enabled; target document opened from draft
- Baseline: `draft_get.data.savedAt = <n>`
- Steps:
  1. Navigate to the feature and open the target document.
  2. Prepare content and perform the complete user sequence, chaining `editor_type_text`, `editor_press_key`, and toolbar calls as needed.
  3. Check intermediate state after each meaningful transition.
  4. Wait for autosave and compare persisted state.
  5. Restore the baseline and reopen the document.
- Expected: intermediate transitions, final user-visible state, persistence result, and unaffected neighboring content
- Actual: observed transitions, final state, persistence result, and any MCP error
- Result: pass / fail / blocked (include why)
- Teardown: `draft_restore(...)`, reopen draft, verify `editor_compare_draft(...)`
```

Do not turn the workflow into one row per MCP call. The rows should describe user-level scenarios; list the ordered MCP calls in the `MCP调用步骤` cell. Add separate rows for meaningful branches such as undo, cancel, permission denial, mixed list types, or persistence failure.

The existing toolbar and Markdown reports are historical coverage records; their older atomic rows are evidence, not the model for new cases. When extending or rewriting those reports, preserve historical values but express new coverage as complete user workflows.

Before calling a case complete, check that it states:

- the user's goal and starting UI/document state;
- the ordered actions and dependencies between them;
- at least one meaningful intermediate assertion and the final visible result;
- persistence, error, or permission behavior when the workflow touches it;
- cleanup that leaves the user's document unchanged.

Table header example:

```markdown
| 编号 | 标题 | 用户角度操作步骤 | MCP调用步骤 | 预期结果 | 实际结果 | 判断 | 复测判定 |
|---:|---|---|---|---|---|---|---|
| 1 | 用户编辑并保存一段带列表和粗体的故事正文 | 用户进入故事编辑器，输入标题和列表，使用 Ctrl+B 加粗关键词，切换工具栏格式，保存后重新打开确认内容仍在 | `app_navigate` → `editor_open_document` → `draft_get` → `editor_set_content` → `editor_type_text` → `editor_press_key` → `editor_toolbar_click` → `editor_get_state` → `draft_wait_saved` → `editor_compare_draft` → `draft_restore` → `editor_open_document` → `editor_compare_draft` | 输入规则、快捷键和工具栏变更按顺序生效；草稿持久化一致；恢复后原始内容不丢失 | 记录每个关键状态和最终 HTML/JSON | 通过/未通过 | 待复测 |
```

### Markdown and shortcuts

- `set_content("")` → `type_text("# ")` → `get_state`: expect an empty `h1` block.
- Repeat with `"* "`, `"1. "`, and `"> "` for list/ordered-list/blockquote input rules.
- `type_text("**bold**")`: expect a `strong` mark.
- `type_text("x")` → `press_key({key:"b",code:"KeyB",ctrlKey:true})` → `type_text("y")`: expect only `y` to be bold.

### Nested lists and keymaps

```text
set_content("")
type_text("- one")
press_key({key:"Enter", code:"Enter"})
type_text("two")
press_key({key:"Tab", code:"Tab"})
get_state()
```

Expect a nested `ul > li` under the first item. Repeat with `shiftKey: true` to test unindent. Replace `- ` with `1. ` for ordered lists. Use `editor_list_metrics` when the assertion concerns marker/font inheritance.

### Toolbar behavior

1. `editor_toolbar_state` to capture available commands and select options.
2. `editor_set_selection` over the exact text under test.
3. Apply `editor_toolbar_click`, `editor_toolbar_select`, or `editor_toolbar_color`.
4. Assert HTML/JSON with `editor_get_state`; verify scope so parent, sibling, and nested list items are unchanged.

### Persistence and teardown

After a mutation, call `draft_wait_saved` with the baseline `savedAt`, then `editor_compare_draft`. Always restore the retained snapshot with `draft_restore` and reopen with `source: "draft"`. If the replacement equals the original content, autosave may not run because the editor is not dirty; restoration itself is the reliable teardown.

## Known limits to report, not hide

- This is development-only and stdio-only; HTTP/SSE MCP servers are outside this integration.
- Image/table/link insertion is not exposed by the current toolbar tool set.
- Keyboard behavior depends on the bridge's synthetic event path. `Home`/`ArrowLeft` selection movement and some browser-native key behavior may not be reliable; document the observed result.
- Keep list boundary assertions explicit. Backspace behavior around empty paragraphs and mixed list types has historically regressed; assert that `listItem` boundaries are preserved rather than only checking concatenated text.
- Do not use direct database edits or DOM scripting as a substitute for an MCP regression unless the task specifically targets the bridge/storage layer.

## Verification baseline

- MCP-only changes: `pnpm --filter @mo-gallery/emulsion-mcp build`.
- Desktop bridge Go changes: `cd desktop; go build ./...` (and `go vet ./...` when practical).
- Frontend editor bridge changes: `cd desktop/frontend; npm run build`.
- Re-run only the focused MCP sequences affected by the change; do not add broad test scaffolding for a manual regression.
