# Emulsion MCP tool catalog

This is the maintained contract for the 20 tools currently registered by `packages/emulsion-mcp`. Tool responses are MCP text content containing pretty-printed JSON. Errors are returned as `isError: true`; a successful business response can still contain `isError: true` for `tools/call` payloads.

## Common target

Editor tools accept optional `documentId` and `documentKind` (`story` or `blog`). Omit both to use the most recently registered target. Pass both for deterministic tests.

## App and editor tools

| Tool | Input | Purpose and assertion hints |
|---|---|---|
| `emulsion_status` | `{}` | Reads the opt-in automation endpoint; fails if descriptor is absent/invalid or process is unreachable. |
| `editor_status` | `{}` | Lists registered TipTap targets and `activeTarget`. |
| `app_navigate` | `{ menu }` | Navigates one of `home`, `library`, `local-library`, `cloud-library`, `photos`, `albums`, `film-rolls`, `upload`, `photo-journal`, `design`, `ai-assistant`, `inspiration`, `storage`, `settings`, `friends`. |
| `app_location` | `{}` | Returns committed `path`, `menu`, `search`, and active editor target. |
| `editor_open_document` | `{ documentId, documentKind, source? }` | Opens `story`/`blog`; `source` is `draft` (default) or `database`, and waits for the target. |
| `editor_focus` | common target | Focuses the live editor. |
| `editor_set_content` | target + `{ content }` | Replaces active draft content. Use Markdown for portable restoration; HTML can fail if ProseMirror versions are duplicated. |
| `editor_type_text` | target + `{ text }` | Sends text through text-input handlers, so Markdown input rules run. |
| `editor_press_key` | target + `{ key, code?, ctrlKey?, altKey?, shiftKey?, metaKey? }` | Sends a structured keyboard event. Use `{key:"b",code:"KeyB",ctrlKey:true}` for Ctrl+B, not a combined key string. |
| `editor_set_selection` | target + `{ from, to? }` | Sets a ProseMirror selection position; positions must be positive integers. |
| `editor_get_state` | common target | Returns live HTML/JSON, selection, block type, and active marks. |
| `editor_toolbar_state` | common target | Returns rendered toolbar command state plus select values/options. Read before `editor_toolbar_select`. |
| `editor_list_metrics` | common target | Returns list item text/type/depth, rendered `li`/`::marker` font size and font family, and inline style for each rendered item. Use it for list marker inheritance assertions. |
| `editor_toolbar_click` | target + `{ commandId }` | Clicks rendered controls. IDs: `bold`, `italic`, `underline`, `strike`, `inlineCode`, `bulletList`, `orderedList`, `blockquote`, `alignLeft`, `alignCenter`, `alignRight`, `clearFormatting`, `undo`, `redo`, `textColor`, `backgroundColor`. |
| `editor_toolbar_select` | target + `{ controlId, value }` | Changes rendered select. `controlId`: `headingLevel`, `fontFamily`, `fontSize`; values must come from `editor_toolbar_state`. |
| `editor_toolbar_color` | target + `{ kind, value }` | Sets/clears `textColor` or `backgroundColor`; use a hex value or `""` to clear. |

## Draft tools

| Tool | Input | Purpose and assertion hints |
|---|---|---|
| `draft_get` | `{ key }` | Reads a persisted draft, e.g. `story_editor_<id>` or `blog_draft_<id>`. The returned `data` is the complete restore payload. |
| `draft_wait_saved` | `{ key, afterSavedAt, timeoutMs? }` | Polls until `savedAt` is newer; timeout is capped at 30s. |
| `draft_restore` | `{ key, data }` | Writes a complete snapshot back to `drafts.db`; do not pass only `content`. |
| `editor_compare_draft` | target + `{ key }` | Reads live state and draft, reporting HTML equality and structural JSON equality (object key order ignored). |

## Protocol and lifecycle facts

- Transport is stdio MCP to Node, then authenticated bearer HTTP to `127.0.0.1` using the short-lived descriptor in the Emulsion config directory.
- Automation is opt-in (`--automation` or `EMULSION_AUTOMATION=1`); the descriptor is removed on exit.
- Desktop accepts only the editor methods listed in the source bridge. Unsupported methods must not be added to a test case without changing both bridge and MCP registration.
- The bridge has an 8-second command wait and a 1 MiB request limit. The MCP draft wait accepts 100-30,000 ms and defaults to the bridge's 5-second polling window.
