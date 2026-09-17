# 本地小模型落地方案

> 日期：2026-09-16
> 前置文档：`requirement-review.md`（需求评审）
> **产品决策：引入本地小模型实现相关能力。** 本文档按该决策展开技术落地设计。

---

## 0. 一处必须先校准的认知

模型在五项能力中扮演的角色**并不相同**，混淆会导致实现走偏：

| 能力 | 模型 | 模型的角色 |
|---|---|---|
| 相似照片查找 | Embedding | **直接产出**向量 |
| 文本描述查找照片 | 同一个 Embedding 的文本塔 | **直接产出**向量 |
| 图片描述 | VLM | **直接产出**文本 |
| 标签建议 | VLM 或零样本分类 | 产出文本/类别 |
| **主色卡** | 显著性模型 | **只做"主体在哪"，不产出颜色值** |

**关键**：不存在"输入图片、输出色卡"的模型。主色提取必须拆成两步——

> ① 模型给出显著性 mask（主体区域）→ ② 在 mask 上做颜色聚类，色值仍由算法算出

所谓"用模型取主色"，实质是**用模型替代"中心先验"这个启发式权重**。上一版评审中"不需要模型"的判断，是在未取得 `u2netp` 体积数据（**4.7MB**）时作出的；以这个代价衡量，引入模型是划算的，该判断应修正。

---

## 1. 模型选型

### 1.1 模型 A — Embedding（必需，全库批处理）

| 候选 | 参数量 | 维度 | 中文 | 体积(FP16) | 许可 | 结论 |
|---|---|---|---|---|---|---|
| **Chinese-CLIP ViT-B/16** | 188M | 512 | **强**（MUGE R@1 71.2%，对比模型 60.9%） | 约 380MB | 需确认 | ⭐ 首选实测对象 |
| **SigLIP base multilingual** | 86M | 768 | 中 | 约 280MB | Apache-2.0 | ⭐ 许可清晰，次选 |
| CN-CLIP RN50 | 77M | 512 | 中 | 约 150MB | 需确认 | 体积敏感时选 |
| ~~jina-clip-v2~~ | 865M | 1024→可截断 | 强 | 大 | ❌ **CC-BY-NC-4.0 非商业** | **排除** |

> ⚠️ **合规红线**：`jina-clip-v2` 虽支持 89 语言且效果最好，但许可为 **CC-BY-NC-4.0（非商业用途）**，商业产品不可使用。选型时务必逐个核对许可，不要只看效果。

Chinese-CLIP 官方提供 ONNX / TensorRT 导出，支持 CN-CLIP-RN50 / ViT-B/16 / ViT-L/14 多规格，可按体积需求降级。

**决定项**：中文 query 召回率是本项目成败关键，标准 CLIP 文本塔对中文支持弱。建议**在 30–50 张真实照片上实测 Chinese-CLIP ViT-B/16 与 SigLIP multilingual 的中文召回**，再定选型。

### 1.2 模型 B — 显著性检测（主色辅助，代价极低）

| 候选 | 体积 | 输入 | 速度(CPU) | 许可 | 结论 |
|---|---|---|---|---|---|
| **U²-Net `u2netp`** | **4.7MB** | `[1,3,320,320]` RGB | 约 30ms/图 | Apache-2.0 | ⭐ 推荐 |
| U²-Net 完整版 | 约 170MB | 同上 | 慢 | Apache-2.0 | 边缘更精细，按需 |
| IS-Net (q8) | 小于 176MB | 1024×1024 | 慢 | Apache-2.0 | 备选 |

**为什么是 `u2netp`**：自动显著性检测（无需点击/框提示，区别于 MobileSAM 的交互式），体积仅 4.7MB，Apache-2.0，ONNX 官方 checkpoint 现成，输出 7 个张量取 `d0` 即可。

4.7MB 的代价几乎可以忽略，**建议直接纳入，不再纠结**。

### 1.3 模型 C — VLM（描述/标签，按需生成）

| 候选 | 体积 | 中文 | 许可 | CPU 速度 |
|---|---|---|---|---|
| Florence-2-base | 约 230MB (INT8) | 弱（英文为主） | MIT | 快 |
| SmolVLM2 256M / 2.2B | 0.25–2.2B | 弱 | Apache-2.0 | 中 |
| **Qwen2.5-VL-3B** (GGUF Q4_K_M) | **约 2–3GB** | **强** | Apache-2.0 | 慢（每张数秒） |

**这是本方案最大的成本分叉点**：中文描述能力需要付出 10 倍以上的体积与显著更慢的推理速度。

**关键工程判断 —— caption 不应该全库批处理**：

- **Embedding 必须全量**：检索依赖全库向量，缺一张就搜不到
- **Caption 只需按需**：用户点开某张照片时才需要描述

因此 VLM **按单张、按需、用户显式触发**生成，并缓存结果。这把 VLM 的成本从"全库 N 倍"降到"实际查看的少量照片"，使 3GB 的 Qwen2.5-VL 变得可接受。

**建议**：首版可用 Florence-2 快速跑通链路；中文描述作为可选项，由用户在设置中主动开启后再下载 Qwen2.5-VL。

---

## 2. 架构

### 2.1 形态：sidecar 进程（沿用既有范式）

延续 `requirement-review.md` 第 4.1 节结论：`emulsion-inference` sidecar，主进程经 **JSON-RPC over stdio** 调用，主进程保持零 CGO，模型按需下载不进安装包。

既有可复用资产：
- `agent_extensions/mcp.go:60` — stdio 子进程管理范式
- `build/prepare-node-runtime.mjs` / `fetch-node-runtime.mjs` — Node runtime 下载打包管道
- `local_library/clip_export.go` — 外部二进制（`emulsion-ffmpeg`）发现与调用范式

### 2.2 一个新增约束：可能需要两套推理后端

| 模型 | 推荐后端 |
|---|---|
| Embedding（ONNX） | `onnxruntime-node` |
| U²-Net（ONNX） | `onnxruntime-node` |
| VLM（Florence-2） | `transformers.js` |
| VLM（Qwen2.5-VL） | **llama.cpp（GGUF）**，非 ONNX Runtime |

若最终选用 Qwen2.5-VL，sidecar 内部需挂载**两个后端**（ONNX Runtime + llama.cpp）。这对 sidecar 的进程/依赖管理提出更高要求，是选型时必须计入的隐形成本——**Florence-2 胜在能用 transformers.js 统一后端**。

### 2.3 模型生命周期

- 懒启动：首次调用时拉起，空闲超时退出
- 分档下载：默认仅 Embedding + U²-Net（约 300–400MB）；VLM 由用户在设置中主动开启后下载
- 模型版本记录进库（`embedding_model` 列），换模型后可识别并触发全量重算

---

## 3. 主色卡的模型化实现（本方案新增重点）

### 3.1 流程

```
原图解码
  │
  ├─ 缩放到 320×320，ImageNet 归一化
  │     ↓
  ├─ u2netp 推理 → saliency mask (0–1)      ← 模型负责"主体在哪"
  │     ↓
  ├─ mask 上采样回采样尺寸
  │     ↓
  ├─ Lab 空间分桶，权重 = 面积 × 饱和度 × (0.2 + 0.8 × mask)   ← 算法负责"取色"
  │     ↓
  ├─ ΔE76 < 12 去重
  │     ↓
  └─ top5 色卡
```

### 3.2 与旧实现的对比

| 项 | 现有实现 | 模型化实现 |
|---|---|---|
| 暗部处理 | 无过滤，暗部全保留 | mask 外像素权重降至 0.2，暗背景被压制 |
| 主体定位 | 无（纯面积竞争） | 显著性 mask |
| 空间加权 | 无 | mask 值加权 |
| 感知均匀 | RGB 4bit 分桶 | CIELAB 分桶 |
| 去重 | 无 | ΔE76 < 12 |

注意：**暗部过滤仍应保留**。mask 解决"主体在哪"，但不能替代"极暗像素本身没有色彩信息"这一事实。两者是叠加关系，不是替代关系。

### 3.3 兜底（必须实现）

- mask 有效像素占比 < 阈值（如 2%）→ 判定显著性失败，回退到全局聚类（含暗部过滤）
- 主体本身为低饱和/极暗（雾天、黑白摄影）→ 放宽 chroma 与 L 阈值重算一轮
- sidecar 不可用（未下载 / 崩溃）→ 回退到现有 `extractDominantColors`，保证功能不中断

### 3.4 成本评估

U²-Net 在 320×320 输入下约 30ms/图（CPU）。若与缩略图生成同批次处理，摊销后对扫描耗时影响有限。建议**与现有缩略图管线合并**，避免额外一次全库遍历。

---

## 4. 存储

沿用 `requirement-review.md` 第 4.3 节：

- `modernc.org/sqlite/vec`（纯 Go、零 CGO、blank import 注册）
- `vec0` 虚拟表存 embedding，`vec_distance_cosine` 做 KNN
- 本地规模（几千至几万张）**不需要 ANN 索引**，暴力 KNN 足够

数据模型补充：

```
assets
  + dominant_colors_version   INTEGER   -- 色卡算法版本，驱动 backfill
  + ai_caption                TEXT      -- AI 描述，与用户 notes 分离
  + embedding_status          TEXT      -- pending/ready/failed/skipped
  + embedding_model           TEXT      -- 模型标识，换模型后触发重算

asset_tags
  + source                    TEXT      -- manual/ai
```

---

## 5. 处理管线与触发时机

| 能力 | 触发时机 | 批处理规模 | 落库 |
|---|---|---|---|
| Embedding | 扫描/导入后后台批处理 | **全库** | `asset_embeddings` |
| U²-Net 主色 | 随缩略图生成合并处理 | 全库（摊销） | `dominant_colors` |
| VLM 描述 | **用户打开照片时按需** | 单张 | `ai_caption` |
| VLM 标签建议 | 用户显式请求 | 单张 | `asset_tags(source=ai)` |

所有批处理任务需支持：进度事件（复用 `scan_pipeline.go` 的进度机制）、中断续跑、失败重试、跳过已处理项。

---

## 6. 风险清单（相对评审版的新增/变化）

| # | 风险 | 变化 | 缓解 |
|---|---|---|---|
| 1 | **jina-clip-v2 为 CC-BY-NC-4.0 非商业许可** | 🆕 合规红线 | 排除；选型逐项核对许可 |
| 2 | Chinese-CLIP 许可条款未确认 | 🆕 | 落地前法务确认 |
| 3 | Qwen2.5-VL 体积 2–3GB 且 CPU 慢 | 🆕 | 按需生成 + 分档下载 + 缓存 |
| 4 | 双推理后端（ONNX Runtime + llama.cpp）复杂度 | 🆕 | 优先 Florence-2 统一后端 |
| 5 | 中文 query 召回不确定 | 沿用 | 实测后再定选型 |
| 6 | 模型分发（国内网络、体积） | 沿用 | 自建镜像、断点续传、校验 |
| 7 | 杀软拦截下载的模型文件 | 沿用 | 临时目录落盘校验后改名；引导加白名单 |
| 8 | sqlite-vec 为 pre-v1 | 沿用 | 薄封装隔离 |
| 9 | 显著性在特殊题材失效（无明确主体） | 🆕 | 3.3 兜底逻辑 |

---

## 7. 落地步骤建议

**Phase 1 — 打通最小闭环（Embedding 优先）**
1. `emulsion-inference` sidecar 骨架（stdio JSON-RPC + 模型下载管理）
2. Chinese-CLIP ViT-B/16 与 SigLIP multilingual **实测中文召回**，定选型
3. sqlite-vec 建表，embedding 批处理接入扫描管线
4. 文本搜图 + 相似照片两个入口（配合 FTS5 做混合检索）

**Phase 2 — 主色模型化**
5. 接入 `u2netp`（4.7MB），实现 mask 加权取色
6. 与缩略图管线合并，避免额外全库遍历
7. 版本号驱动 backfill + 兜底回退

**Phase 3 — 生成能力（按需）**
8. Florence-2 跑通按需描述链路（统一后端优先）
9. 中文描述作为可选项，用户开启后下载 Qwen2.5-VL
10. 标签建议，带 `source=ai` 标记，需用户确认

---

## 8. 待确认事项

1. **中文描述的必要性**：接受英文 caption（Florence-2，约 230MB）还是必须中文（Qwen2.5-VL，2–3GB）？这决定了 Phase 3 的形态与体积。
2. **Chinese-CLIP 许可**是否可用于本产品（需法务确认）。
3. 主色卡是否接受"模型 + 聚类"的组合（而非模型端到端输出色值）——若坚持端到端，技术上不可行，需重新对齐预期。
4. 首版是否接受下载 Node runtime（约数十 MB）作为 sidecar 依赖。
