# ShunCode Bridge 接入记录与操作规则

> 建立：2026-09-26 · 状态：**已实测连通**（`initialize` HTTP 200、`tools/list` 返回 15 个工具）· 协议：MCP 2024-11-05 · 服务端：`shuncode-bridge` v0.7.6
> 端点：`https://<ngrok 域名>/mcp/<token>`——**token 即凭证，不写入本仓库**，需要时向负责人索取。
> 证据范围：MCP 协议层实测 + 本机只读探测（2026-09-26）。**未做** UE 编译、PIE、Cook 验证。

## 1. 结论先行

| 项 | 结论 |
|---|---|
| 本桥是什么 | ShunCode 编辑器暴露的 MCP 服务端，把**当前打开工作区所在的本机**（默认整个设备）交给外部 AI 代理操作 |
| 与 Unreal MCP 的关系 | **两个不同的服务端**，见 §2；本桥不依赖 UE 编辑器 |
| 当前可用性 | 协议层可用；UE 编辑器未运行，Unreal MCP 侧不可用（§7） |
| 权限性质 | 本桥只扩大**执行能力**，不改变 [AI必读](../../AI必读.md) 的批准链：AI 仍无批准权 |
| 与程序设计准则 §9.1.6 的关系 | 待确认，见 §8 问题 1，不擅自改准则 |

## 2. 两套 MCP 不要混用

| 对比项 | ShunCode Bridge（本文） | Unreal MCP（[程序设计准则 §9.1](../../MistRoost/程序设计准则.md)） |
|---|---|---|
| 来源 | ShunCode 编辑器自带桥 | Epic 官方 Experimental 插件（`ModelContextProtocol`） |
| 端点 | ngrok 隧道 URL（见文首） | `http://127.0.0.1:8000/mcp`（工程 `.mcp.json` 配置） |
| 宿主进程 | ShunCode 进程 | UE 编辑器进程 |
| 能力范围 | 文件读写与补丁、命令执行、诊断、LSP、任务看板 | 编辑器内关卡／Actor／资产／自动化测试工具集 |
| 使用前提 | ShunCode 打开工作区 | 编辑器运行且插件启用 |

两者不互相替代：本桥管**设备与仓库**，Unreal MCP 管**编辑器会话内**的装配与验证。

## 3. 连通与调用规则（实测）

- `initialize` 在响应头返回 `mcp-session-id`，后续请求须带同名请求头。
- 响应 `Content-Type` 为 `text/event-stream`，报文是 SSE：取 `data:` 行即 JSON-RPC 响应体。
- **同一端点同一时刻只接受一个在途请求**：并发 POST 返回 `HTTP 409 Conflict`。客户端必须串行化（本会话用一个全局文件锁 + 单会话复用实现）。
- 超时按用途放宽：读大文件、跑文档校验器等给 60–300 秒。
- 调用示例（任意外部机器可复现，串行调用）：

```bash
ENDPOINT='https://<ngrok 域名>/mcp/<token>'
# 1) 握手，从响应头取 mcp-session-id
curl -si -X POST "$ENDPOINT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'
# 2) 调用工具（勿并发）
curl -s -X POST "$ENDPOINT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_directory","arguments":{"depth":1}}}'
```

- 若为此写客户端脚本：属一次性工具，按 [AI必读 §1](../../AI必读.md) **放 AI 自己的临时目录，不进仓库**。

## 4. 可用工具清单（15 个）

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `list_directory` | 列目录（可设深度） | 工作区内 |
| `find_files` | 按文件名／路径 glob 查找 | 不搜内容；默认 100 条、上限 500 |
| `search_files` | 文本正则／字面检索（可带上下文行） | 与 `find_files` 分工：内容 vs 名字 |
| `read_files` | 批量读文件，返回行号、总行数与 `sha256` 版本 | 一次最多 20 个文件 |
| `read_image` | 读取图片（可选 data URI） | 用于看图核对 |
| `apply_patch` | Codex 风格多文件补丁：Add/Update/Delete/Move | **主力编辑工具**；带 `expected_versions` 防陈旧覆盖；失败不部分应用 |
| `run_command` | 执行命令（pty，bash），可后台 | 支持超时；日志可增量取回 |
| `get_command_output` | 取回命令输出（含后台任务） | 不排队，长任务随时可查 |
| `send_command_input` / `cancel_command` | 向运行中命令送输入／中止 | 不排队 |
| `get_diagnostics` | 取诊断（编译／语法） | 无打开文件时返回 0 条 |
| `lsp` | 语义导航：定义、引用、符号、类型 | **优先于**大范围文本搜索定位符号 |
| `set_todos` | 任务看板：整份计划 + 生命周期状态 | 多步工作开工前先调，结束前发终态 |
| `update_plan` | `{step,status}` 形式的等价看板 | 与 `set_todos` 二选一，别混用 |
| `report_progress` | 上报"正在做什么" | 只作过程播报，不承担任务状态 |

## 5. 桥侧协作协议（Bridge 要求 AI 遵守）

| 要求 | 要点 |
|---|---|
| 任务看板 | 多步工作开始前 `set_todos`（`new_task=true` 给全量计划）；复用 `task_id` 与 `task_revision`；**回复前**必须发 `lifecycle=completed`（或如实 blocked/cancelled）并等确认 |
| 进度上报 | 每到有意义的步骤转换再报，别每个工具调用都报 |
| 并行 | 独立调用可并发提交，桥会排队；只有真实依赖才串行；同一文件的写入不并发 |
| 交付物归位 | 本会话产生的分析／审计／计划／复核写入 `Docs/`，沿用 `mcp-<主题>.md` 命名；探针脚本、日志、基线不进 `Docs/` |
| 范围 | 默认整个本机可读，优先当前打开的工作区；工作区外的目标先用 `run_command` 只读探测 |

## 6. 仓库对本接入的硬约束

来自 [AI必读](../../AI必读.md)（v2.2）与根层 `CLAUDE.md`（该文件只做指路，规则正文在 AI必读）：

1. **🔴 需明确许可，不得擅自改**：`Docs/美术/美术准则/**`、`Docs/美术/设计方向/**`、`Docs/策划/游戏设计案准则/**`、`Docs/剧情/剧情编写准则/**`、`游戏制作准则.md`、`AI必读.md`、`MistRoost/程序设计准则.md`。发现问题 → 说明 + 建议 + 等回复。
2. **只做被要求的事**；顺手发现的问题报告，不顺手改。
3. **不 commit、不 push**（Git 由负责人管理）；**不执行下载脚本**。
4. 脚本按用途归位，一次性脚本进临时目录；同名用途只留一个脚本。
5. **验证等级 L0–L5**，说到哪级只能宣称到哪级；失败贴原始输出，不做"基本完成"式包装。
6. 改完文档必须跑 `cd Docs && node 工具/validate-docs.mjs --workspace`（**必须带 `--workspace`**）。
7. 文档一律 UTF-8 / LF / 行尾无空格 / 文件末尾有换行；UE 的 `.ini` 保持 CRLF。
8. 不删除记录，只标注状态；删除或覆盖任何文件前先看目标内容。
9. `.uasset` / `.umap` 不用文本或脚本改写，必须走编辑器或 API。

## 7. 环境探测结果（2026-09-26，只读）

| 项 | 结果 |
|---|---|
| 工作区 | `E:\_My_Game_Project`；**不是 Git 仓库**（`git rev-parse` 失败） |
| 顶层结构 | `Docs/`、`MistRoost/`、`美术资产/`、`下载资产/`、`概念设计/` + 根层规则文件 |
| 根层规则文件 | `AI必读.md`（v2.2）、`CLAUDE.md`、`游戏制作准则.md`、`项目规范.md`、`.mcp.json` |
| Node | v24.15.0，`Docs/工具/validate-docs.mjs` 可运行（无 npm 依赖） |
| 文档校验基线 | **FAIL**：1 条既有错误——`策划/游戏玩法/系统/16-NPC对话.md` 引用的 `美术资产/人物/NPC/立绘/木匠立绘占位.png` 缺失。与本次改动无关，未处理（§8 问题 2） |
| UE 编辑器 | `UnrealEditor.exe` 不在进程表；`http://127.0.0.1:8000/mcp` 无响应 ⇒ Unreal MCP 当前不可用 |
| 诊断 | `get_diagnostics` 返回 0 条（无打开文件／编译单元） |

## 8. 待确认问题

| 编号 | 问题 | 需要负责人决定的原因 |
|---|---|---|
| Q1 | 程序设计准则 §9.1.6「不引入第三方 MCP 服务端」是否覆盖本桥？ | 该条写在 UE 工程 MCP 章节，语境指向"加进工程的 MCP 服务端"；本桥是设备级外部通道，不由工程承载。判定不同结论会影响后续能否常态使用本桥，**不擅自改准则** |
| Q2 | 校验基线那条缺失链接（木匠立绘占位图）如何处理？ | 修复失效链接属 🟢，但本次未被要求，未动手 |
| Q3 | 范围边界：本桥默认暴露整个设备，是否约定"只在 `E:\_My_Game_Project` 内写入"？ | 属权限口径问题，需负责人定 |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 建立：接入方式与调用规则、15 个可用工具清单、桥侧协作协议、仓库硬约束、环境基线、3 条待确认问题 |

