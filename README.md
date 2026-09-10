# 岚栖 / MistRoost

一款 **UE 制作的 2.5D 手绘风格中式种田生活模拟游戏**：以星露谷物语式的生活经营为骨架，
以**玩家手绘符咒**为核心差异，围绕种田、畜牧、钓鱼、矿洞、岚兽与轻量剧情，
讲述一个架空近海山谷（重庆式山地 + 海滩）里「以岚养灵、与兽相随」的惬意故事。

> A UE 2.5D hand-drawn Chinese-style farming/life-sim (Stardew-like), with a hand-drawn
> talisman (符咒) system as its core differentiator.

## 文档 / Docs

设计与实现文档在 [`Docs/`](Docs/)：

- [游戏总览](Docs/00-游戏总览.md) · [文档索引与决定清单](Docs/README.md)
- 玩法：[符咒](Docs/玩法/00-核心-符咒系统.md) · [岚气与岚兽](Docs/玩法/01-岚气与岚兽.md) · [种田](Docs/玩法/02-种田.md) 等
- 框架：[运气系统](Docs/框架/00-运气系统.md) · [计时与产出](Docs/框架/01-计时与产出系统.md) · [技术架构与实现路线](Docs/框架/02-技术架构与实现路线.md)

## 工程 / Project

- 引擎：Unreal Engine（模块 `MistRoost`；Enhanced Input / StateTree / AIModule）。
- C++ 代码约定：新代码 `.h` 放 `Source/MistRoost/Public/<域>/`，`.cpp` 放 `Private/<域>/`。
- **版本管理范围：仅代码/配置/文档**（`Source/ Config/ Docs/ *.uproject`）。
  游戏资产 `Content/`、构建产物 `Binaries/ Intermediate/ Saved/ .vs/` 均在 `.gitignore` 中，**不纳入 git**——`Content/` 由作者本地/单独备份维护（独立开发）。
- 因此仅克隆本仓库**不含资产**；需要另行放入 `Content/` 才能在编辑器打开完整项目。将来若要改为版本化资产，去掉 `.gitignore` 里的 `Content/` 即可（建议配 Git LFS）。

### 打开工程 / Open the project

右键 `MistRoost.uproject` → Generate project files，用 Rider / Visual Studio 打开并构建。
