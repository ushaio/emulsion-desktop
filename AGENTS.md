# Emulsion Desktop — MO Gallery 桌面客户端

Go 1.25 + Wails v2.14 桌面应用，前端在 `frontend/`（React 19 + Vite 6 + TS + Tailwind 4，pnpm workspace 含 `packages/*`）。

## 目录

- `frontend/` — Wails 前端（`pnpm --filter mo-gallery-desktop-frontend dev`）
- `services/` — Go 服务层（auth、photo、upload、zine、editor-ai 代理、official_auth、updater、usage 等）
- `storage_plugins/` — 插件宿主（市场解析 `marketplace.go` 为 index.json 的权威实现、签名校验、Node 运行时）
- `packages/desktop-plugin-sdk` — 插件 TS SDK（JSON-RPC over stdio）
- `packages/emulsion-mcp` — 编辑器 MCP server
- `agent_extensions/` — 编辑器 AI 的 MCP/Skill 运行时
- `db/`、`config/`、`local_library/`、`types/`、`storage/` — 数据与基础设施

## 命令

`wails dev` / `wails build`；前端单独构建 `pnpm build`。

## 跨仓库联动（重要）

- `frontend/package.json` 中 `@mo-gallery/*` 来自 mo-gallery-shared 的 **git tag 依赖**，禁止改 `file:`/`link:`；共享编辑器/AI 逻辑去 shared 包改，不要在本仓库复制。
- 调用官网（mo-gallery-offical）API：`services/official_auth.go`（/api/auth/*）、`services/usage.go`（/api/desktop/usage）、`frontend/src/lib/zine/plaza.ts` 与 `lib/official-ai.ts`（/api/templates*、/api/ai/catalog）。改官网接口时需同步这里。
- 改 `packages/desktop-plugin-sdk` 或 `storage_plugins/marketplace.go` 时，检查 `../plugins/` 下三个插件与 `../mo-gallery-plugin/index.json`。

## 注意

`app.go.<数字>`、`services/*.go.<数字>` 等带时间戳后缀的文件是过期自动备份，**不是源码**，忽略。
