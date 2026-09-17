# Emulsion Desktop

MO Gallery 桌面管理客户端（Go + Wails v2 + React/Vite）。从 mo-gallery-web 仓库拆分而来，版本独立演进。

## 开发

依赖 Go 1.25+、Node 24+、pnpm 11+、Wails CLI v2.14+。

```bash
pnpm install          # 安装 frontend 与 packages/* 依赖
wails dev             # 本地开发（自动拉起 frontend dev server）
wails build           # 构建桌面应用
```

前端单独构建：

```bash
pnpm build            # frontend 的 tsc + vite build
```

## 结构

- `frontend/` — React/Vite 前端（Wails 前端目录）
- `packages/plugin-sdk` — 存储插件 TypeScript SDK
- `packages/emulsion-mcp` — 编辑器 MCP 服务器
- `storage_plugins/` — 存储插件运行时（构建时签名打包 Node 运行时）

## 共享包

根目录 `packages/*` 下有 `@mo-gallery/api-client`、`@mo-gallery/ai-agent`、`@mo-gallery/milkdown`、`@mo-gallery/tiptap-editor` 的 workspace 副本（pnpm workspace 成员，以 `workspace:*` 引用），源在 [mo-gallery-shared](https://github.com/ushaio/mo-gallery-shared)。在 shared 仓库运行 `pnpm sync` 即可把改动单向同步到这里的 `packages/*`；请勿直接编辑镜像文件（有漂移检测），更新方式见该仓库 README。

## 发版

版本号维护在 `frontend/package.json` 与 `wails.json`（两者必须一致），发版说明写在 `RELEASE.md`。推送到 master 触发 `.github/workflows/release.yml` 完成三平台构建与发布。版本流程参考 mo-gallery-web 仓库的 `mo-release` 约定。
