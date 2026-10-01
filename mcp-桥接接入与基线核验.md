# MCP 桥接接入与基线核验

> 编号：MCP-001 · 日期：2026-09-27 · 类型：接入记录与只读基线
> 范围：外部 Agent 经 ShunCode Bridge（MCP）接入本工作区的连接方式、可用工具、约束边界，以及接入当次的只读基线核验结果。
> 本文不含规则条款；规则正文见 [AI必读](../AI必读.md) 与 [游戏制作准则](../游戏制作准则.md)。

## 1. 连接事实

| 项 | 实测值 |
|---|---|
| 服务端 | `shuncode-bridge` v0.7.6 |
| 协议版本 | `2025-06-18`（Streamable HTTP + SSE） |
| 会话 | 服务端下发 `mcp-session-id`，后续请求需回传该头 |
| 宿主 | `DESKTOP-SL4G7T4`，用户 `Administrator`，Windows + Git Bash |
| 工作区 | `/e/_My_Game_Project`（即 `E:\_My_Game_Project`） |
| Node | v24.15.0 |
| Git | 2.55.0.windows.5 |
| Python | **无**（`python --version` 无输出，宿主未装 Python） |

两个接入期踩到的坑，已确认为客户端侧问题，记录以免重复：

1. **请求 `id` 必须唯一。** 固定 `id` 并发调用会被服务端拒绝：HTTP 409 / `-32009 Duplicate JSON-RPC request id is already in flight`。改用唯一 `id` 后 6 路并发全部成功。
2. **不要并发各自 `initialize`。** 每个客户端各自初始化会互相顶掉会话，表现为后续调用拿到"session not found"。正确做法是初始化一次、复用同一 `mcp-session-id` 并发发调用；服务端支持同会话并行。

## 2. 可用工具（15 个）

| 分组 | 工具 |
|---|---|
| 发现 | `list_directory`、`find_files`、`search_files`、`lsp` |
| 读取 | `read_files`、`read_image` |
| 写入 | `apply_patch` |
| 校验 | `get_diagnostics` |
| 命令 | `run_command`、`get_command_output`、`send_command_input`、`cancel_command` |
| 任务 | `set_todos`、`update_plan`、`report_progress` |

调用约定：

- `read_files` 一次可带多个文件（上限 20），独立文件应合并成一次调用。
- `run_command` 返回 `command_id`；超时不杀进程，用 `get_command_output` 续读。
- `set_todos` 的条目字段是 `id` / `title` / `status`（不是 `content`）；`status` 仅 `pending`/`in_progress`/`completed`，最多一个 `in_progress`，上限 24 条。
- 新任务用 `new_task=true` 起，之后复用返回的 `task_id` 与 `task_revision`（作 `expected_revision`）。
- **收尾必须显式送终态**：全部完成送 `lifecycle=completed`，否则送 `blocked`/`cancelled` 并如实保留未完成项；断连与空闲都不算完成。
- 独立调用可并行，服务端按波次执行；同一文件的写入不得并行。

## 3. 工作区约束要点（来自根层规则，未复述全文）

- 🔴 未经许可不得改：`Docs/美术/美术准则/**`、`Docs/美术/设计方向/**`、`Docs/策划/游戏设计案准则/**`、`Docs/剧情/剧情编写准则/**`、`游戏制作准则.md`、`AI必读.md`、`MistRoost/程序设计准则.md`。发现问题只报告并等回复。
- 验证分级 L0–L5，措辞不得越级；"没报错""文件存在""工具跑完了"都不算通过。
- 不 commit、不 push；Git 由用户管理。
- 脚本单独存放：UE 编辑器 Python 进 `MistRoost/Tools/`，文档校验进 `Docs/工具/`，一次性试验进临时目录不进仓库。
- 文档一律 UTF-8 / LF / 行尾无空格 / 末尾有换行；UE 的 `.ini` 保持 CRLF。
- 改完文档跑 `cd Docs && node 工具/validate-docs.mjs --workspace`（必须带 `--workspace`）。

## 4. 只读基线（2026-09-27）

`cd Docs && node 工具/validate-docs.mjs --workspace` 实测输出：

```text
mode: complete-workspace
files: 87 · markdownFiles: 72 · checkedLocalLinks: 889
warnings: 0
errors: 3
result: FAIL
```

三条错误全部指向 `美术/设计方向/04-首关-半山庄园.md` 引用的三张预览图缺失：

```text
../../../美术资产/关卡/半山庄园/预览_游戏俯角全景110m_v002.png
../../../美术资产/关卡/半山庄园/预览_游戏机位远档_v002.png
../../../美术资产/关卡/半山庄园/预览_游戏机位标准档_v002.png
```

已核对 `美术资产/关卡/半山庄园/` 实际内容：该目录存在，含 `HM_FarmHillside_505_v001/v002` 系列（`.png`、`.r16`、`.json`、`.raw` 分层）、`布局图_v001/v002.svg`、`build_HM_FarmHillside.py`，但**不存在任何 `预览_游戏*.png`**。因此这是接入前既有的链接失效，非本次操作造成。按 [AI必读](../AI必读.md) §6，此处只登记状态，不删行、不代做补图。

仓库状态（实测）：

| 仓库 | 分支 | 未提交条目 |
|---|---|---|
| `Docs/` | `main` | 16 |
| `MistRoost/` | `main` | 129 |
| 工作区根 | 非 Git 仓库 | — |

## 5. 接入时观察到的不一致（仅报告，未改动）

1. **`项目规范.md` 疑似他项目遗留。** 其 §2 引用的 `../项目/世界观设定_v0.1.md`、`美术规范_v0.3.md`、`角色3C/` 等路径在本工作区不存在；[AI必读](../AI必读.md) 变更记录 2.0 也写明"并入根目录 `项目规范.md`（从他项目抄来，已适配本项目）"。该文件仍要求"首次先问身份"，与 `AI必读` §2.1"本工作区不设 AI 岗位身份系统、权限按路径划分"存在张力。属 🔴 层邻近的根规则文件，**未改**，请负责人裁定是否退役或改写。
2. **`游戏制作准则.md` §2 权威表把"决策历史"指向 `Docs/项目管理/01-决策记录.md`**，而 [Docs/README](README.md) 说明 `项目管理/` 目录已退役、决策编号改由 Git 历史追溯，且 `Docs/` 下确无 `项目管理/` 目录。两份根层文档口径不一致，**未改**。
3. 上述两项校验器均未报错（`项目规范.md` 的失效相对链接未被计入，推测因该文件不在 `--workspace` 的链接扫描范围或其写法未被识别为链接）——即校验 PASS 不等于根层文档自洽。

## 6. 未做与原因

- 未运行 UE 编辑器、未编译、未做 PIE：本次为接入与只读核验，无对应任务授权。
- 未补三张缺失预览图：属美术产出，需负责人决定由谁补、按哪份合同补。
- 未修正第 5 节两处不一致：涉及 🔴 层根规则文件，等许可。
- 未 commit、未 push。
