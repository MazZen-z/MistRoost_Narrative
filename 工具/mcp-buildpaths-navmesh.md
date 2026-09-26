# UE 5.8.2 `Build Paths` 生成 NavMesh 规则源码核对

> 核对日期：2026-09-21
> 引擎源码：`E:/_UE_Engine/UnrealEngine-5.8.2-release`
> 主题：编辑器 `Build Paths`（`FBuildOptions::BuildAIPaths`）、NavMesh 生成边界、World Partition、DataLayer。
> 证据边界：以下结论来自 UE 5.8.2 引擎源码静态阅读；本次没有编译工程、运行 PIE、执行 Cook，也没有据此断言 MistRoost 当前地图配置已经满足这些条件。

## 1. 结论先行

### 1.1 普通世界的 `Build Paths` 调用链

编辑器菜单的 `Build Paths` 不是一个独立的 NavMesh 算法入口，而是以下调用链：

```text
FLevelEditorActionCallbacks::BuildPathsOnly_Execute
  -> FEditorBuildUtils::EditorBuild(World, FBuildOptions::BuildAIPaths)
  -> FEditorBuildUtils::TriggerNavigationBuilder
  -> FNavigationSystem::Build(World)
  -> UNavigationSystemV1::Build()
  -> UNavigationSystemV1::RebuildAll()
  -> ANavigationData::RebuildAll()
  -> FRecastNavMeshGenerator::RebuildAll()
  -> 标记脏 Tile、收集导航八叉树几何、生成 Recast Tile
```

入口证据：

- `Engine/Source/Editor/LevelEditor/Private/LevelEditorActions.cpp:1125-1129`：`BuildPathsOnly_Execute()` 传入 `FBuildOptions::BuildAIPaths`。
- `Engine/Source/Editor/UnrealEd/Private/EditorBuildUtils.cpp:442-453`：`EditorBuild()` 对 `BuildAIPaths` 检查隐藏关卡，然后调用 `TriggerNavigationBuilder()`。
- `Engine/Source/Editor/UnrealEd/Private/EditorBuildUtils.cpp:954-990`：非分区构建路径调用 `FNavigationSystem::Build(*InOutWorld)`。

### 1.2 World Partition 下有一个决定性分支

`EditorBuildUtils.cpp:97-99` 将 `ai.nav.bNavmeshAllowPartitionedBuildingFromEditor` 的默认值设为 `false`，并注明这是尚未默认开启的实验性分区 NavMesh 构建。

因此，在 World Partition 世界中：

1. **默认情况下**，`Build Paths` 不进入 `WorldPartitionNavigationDataBuilder`，而是落到 `FNavigationSystem::Build()` 的普通内存构建路径。它只会使用当前已经加载到编辑器世界中的内容。
2. 只有同时满足以下条件，才会进入分区构建器：
   - `ai.nav.bNavmeshAllowPartitionedBuildingFromEditor=1`；
   - `UWorld::IsPartitionedWorld()` 为真。
3. 分区路径会启动 `WorldPartitionBuilderCommandlet`，参数包含 `-Builder=WorldPartitionNavigationDataBuilder`，逐个加载二维构建单元并保存 `ANavigationDataChunkActor` 包。

分支和命令行证据：

- `Engine/Source/Editor/UnrealEd/Private/EditorBuildUtils.cpp:954-991`：CVar 开启且世界分区时调用 `WorldPartitionBuildNavigation()`，否则调用普通 `FNavigationSystem::Build()`。
- `Engine/Source/Editor/UnrealEd/Private/EditorBuildUtils.cpp:1019-1040`：分区路径以 `-run=WorldPartitionBuilderCommandlet` 和 `-Builder=WorldPartitionNavigationDataBuilder` 启动构建器。

**这意味着：如果目标是生成可随 World Partition 流式加载的持久 NavMesh chunk，只点击默认的 `Build Paths` 不能直接证明分区数据已经生成。** 必须确认实际走了分区构建器，或显式运行等价的 World Partition builder 流程。

### 1.3 `Build()` 真正决定“在哪里生成”的规则

`UNavigationSystemV1::Build()` 的顺序是：

1. 丢弃 `ULevel::NavDataChunks` 中的旧 chunk 引用；
2. 检查是否存在可构建区域，以及是否被 Navigation Build Lock 阻止；
3. 必要时生成缺失的 NavigationData，并处理延迟注册；
4. 如果设置了 `BuildBounds`，只把该范围内的 Tile 标脏；
5. 调用 `RebuildAll()`；
6. 对所有已注册 `ANavigationData` 调用 `EnsureBuildCompletion()`，阻塞到生成任务完成。

源码：`Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:4441-4510`。

可构建区域由以下任一条件满足即可：

- `bWholeWorldNavigable=true`；
- 已注册的导航边界存在有效 `AreaBox`；
- 世界中存在有效的 `ANavMeshBoundsVolume`。

源码：`Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:2583-2614`。

### 1.4 NavMesh 的空间边界与 Agent 过滤

`FRecastNavMeshGenerator::UpdateNavigationBounds()` 在未启用全世界导航时，调用 `GetNavigationBoundsForNavData()`，按当前 NavData 对应的 Agent 索引筛选 `ANavMeshBoundsVolume::SupportedAgents`，把匹配的体积作为 `InclusionBounds`。全世界导航时则使用整个世界边界。

源码：

- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:4395-4420`：从有效 `ANavMeshBoundsVolume` 收集边界和 SupportedAgents。
- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:6277-6296`：按 NavData 的 AgentIndex 筛选边界。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:5564-5604`：形成 `InclusionBounds` / `TotalNavBounds`。

所以，**NavMesh Bounds Volume 存在不等于每一个 Agent 都会在其中生成数据**；该体积还必须支持当前 NavData 对应的 Agent。

### 1.5 全量构建与局部构建不是同一条分支

- 普通全量构建时，`UNavigationSystemV1::RebuildAll()` 只有在 `BuildBounds` 无效时，才对每个 NavData 调用 `NavData->RebuildAll()`。
- 有效 `BuildBounds` 时，`UNavigationSystemV1::Build()` 先调用 `DirtyTilesInBuildBounds()`，只把范围内 Tile 标脏；随后 `RebuildAll()` 的全量条件因 `BuildBounds.IsValid` 而不成立，最终由生成器处理这些脏 Tile。

源码：

- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:4846-4879`：`RebuildAll()` 的全量条件。
- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:6182-6191`：`DirtyTilesInBuildBounds()`。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:5786-5820`：`FRecastNavMeshGenerator::RebuildAll()` 重建 Detour NavMesh 并标记 `InclusionBounds`。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:5822-5854`：`EnsureBuildCompletion()` 处理所有剩余 Tile 任务。

## 2. 生成数据的实际来源

### 2.1 先进入导航八叉树，再按 Tile 查询

导航系统在 `ConditionalPopulateNavOctree()` 中构建导航八叉树，并把可见 Level 的导航元素注册进去；随后 Recast Tile 生成器在 Tile 范围扩大后的盒体内查询八叉树元素。

源码：

- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:1214-1265`：构造导航八叉树并注册可见 Level。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:2084-2116`：按 Tile 范围查询八叉树并调用 `Element.ShouldUseGeometry(NavDataConfig)`。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:2118-2172`：收集当前 Tile 的相关几何和 Modifier。

因此，Build Paths 并不是遍历所有磁盘上的 Actor 直接生成 NavMesh。能够进入本次生成的前提是：Actor/Component 已经加载、导航相关元素已注册到导航八叉树、元素对当前 NavData/Agent 的 `ShouldUseGeometry()` 判断为真，并且其范围与待生成 Tile 相交。

### 2.2 Recast 全量构建

`FRecastNavMeshGenerator::RebuildAll()` 在存在可构建区域时释放旧 Detour NavMesh、构造新的 Tiled NavMesh，然后对所有 `InclusionBounds` 标记 `All | NavigationBounds` 脏区。最终各 Tile 由生成器收集导航几何、体素化、生成 Recast 数据。

源码：`Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp:5786-5820`、`:6697-6713`。

## 3. World Partition 分区构建器的规则

以下规则只适用于真正执行 `UWorldPartitionNavigationDataBuilder` 的路径，不适用于上面所说的“CVar 关闭时普通内存 Build”。

### 3.1 构建器的单元、重叠与加载

`UWorldPartitionNavigationDataBuilder` 在头文件中将加载模式固定为 `ELoadingMode::IterativeCells2D`，并且不要求 Commandlet 渲染：

- `Engine/Source/Editor/UnrealEd/Public/WorldPartition/WorldPartitionNavigationDataBuilder.h:22-32`。

`PreRun()` 的规则：

1. 读取 `AWorldSettings::BaseNavmeshDataLayers`；其中运行时 DataLayer 会加入 `IncludedDataLayers`。
2. 从 `ANavigationDataChunkActor` 的默认网格大小获得 `GridSize`。
3. 将 `NavigationDataBuilderLoadingCellSize` 向上按 `GridSize` 的整数倍取整，得到迭代加载单元大小。
4. 初始化 `EditorWorldPartitionBuildMode` 的 NavigationSystem，并以所有 NavData 的最大 TileSizeUU 作为迭代重叠范围。

源码：`Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp:36-76`。

对应的 WorldSettings 字段和默认值：

- `Engine/Source/Runtime/Engine/Classes/GameFramework/WorldSettings.h:565-575`：`NavigationDataChunkGridSize`、`NavigationDataBuilderLoadingCellSize`。
- `Engine/Source/Runtime/Engine/Classes/GameFramework/WorldSettings.h:586-591`：`BaseNavmeshDataLayers`，注释明确其意图是把运行时 DataLayer 放入 base navmesh，同时包含编辑器 DataLayer 和不属于 DataLayer 的 Actor。
- `Engine/Source/Runtime/Engine/Private/WorldSettings.cpp:119-123`：默认 `NavigationDataChunkGridSize=102400`，`NavigationDataBuilderLoadingCellSize=102400*4`。
- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:6342-6362`：以 NavData 的最大 `GetWorldPartitionNavigationDataBuilderOverlap()` 作为重叠值；`ARecastNavMesh` 在 `RecastNavMesh.cpp:3784-3789` 返回 `TileSizeUU`。

通用 `UWorldPartitionBuilder::Run()` 先执行 `PreRun()`，再加载 DataLayer，然后按二维单元计算 `BoundsToLoad`，扩展重叠，使用 `FLoaderAdapterShape` 加载该范围，最后调用派生类 `RunInternal()`：

- `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionBuilder.cpp:188-204`：PreRun、DataLayer 加载、加载模式。
- `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionBuilder.cpp:222-275`：二维迭代、重叠范围、加载单元和 `RunInternal()`。

### 3.2 DataLayer 在构建器中的加载状态

`UWorldPartitionBuilder::LoadDataLayers()` 对每个 `UDataLayerInstance` 计算最终编辑器加载状态：

```text
bForceIncludeEditorDataLayer
  = bLoadNonDynamicDataLayers && !DataLayer->IsRuntime()

bForceIncludeInitiallyActivatedRuntimeDataLayer
  = bIncludeInitiallyActivatedRuntimeDataLayers
    && DataLayer->IsRuntime()
    && InitialRuntimeState == Activated

bIsForceIncluded
  = IncludedDataLayers.Contains(asset)
    || 上述任一强制包含条件

bIsForceExcluded
  = ExcludedDataLayers.Contains(asset)
    || 显式的强制排除条件

bShouldBeLoaded = !bIsForceExcluded && (bIsForceIncluded || bIsDefaultLoaded)
```

源码：`Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionBuilder.cpp:326-372`。基类默认值在 `WorldPartitionBuilder.h:164-177`：

- `bLoadNonDynamicDataLayers=true`；
- `bIncludeInitiallyActivatedRuntimeDataLayers=false`；
- `bExcludeNonInitiallyActivatedRuntimeDataLayers=false`。

因此，`WorldPartitionNavigationDataBuilder` 的具体结果是：

- **编辑器 / non-runtime DataLayer**：默认被强制加载；
- **`BaseNavmeshDataLayers` 中的 runtime DataLayer**：在 `PreRun()` 中加入 `IncludedDataLayers`，被强制加载并参与 base navmesh 生成；
- **不在 `BaseNavmeshDataLayers` 中的 runtime DataLayer**：不会因为“它是 runtime 且初始激活”就自动被该构建器强制加入；只有默认编辑器加载状态或其他显式 include 条件使它加载时，才会进入本轮生成；
- **不属于任何 DataLayer 的 Actor**：不受 DataLayer 加载开关排除，随所在 World Partition cell 加载。

### 3.3 每个单元怎样落盘

`RunInternal()` 会：

1. 以 `InCellInfo.Bounds.ExpandBy(-IterativeCellOverlapSize)` 得到真正的 `GeneratingBounds`；
2. 删除生成范围内已有的 `ANavigationDataChunkActor`；
3. 完成静态网格编译；
4. 调用 `GenerateNavigationData(WorldPartition, LoadedBounds, GeneratingBounds)`；
5. 保存新建或删除的 chunk actor 包。

源码：`Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp:135-177`。

`GenerateNavigationData()` 对当前加载范围调用：

1. `FNavigationSystem::AddNavigationSystemToWorld(...EditorWorldPartitionBuildMode)`；
2. 检查 `LoadedBounds` 是否与可导航世界边界相交；
3. `NavSystem->SetBuildBounds(LoadedBounds)`；
4. `FNavigationSystem::Build(*World)`；
5. 对与 `GeneratingBounds` 相交的 NavigationData chunk 网格单元调用 `CollectNavData()`；
6. 将当前 NavMesh Tile 复制到 `URecastNavMeshDataChunk`，由 `ANavigationDataChunkActor` 持有。

源码：

- `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp:378-418`：设置 BuildBounds 并生成。
- `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp:421-487`：按 chunk 网格收集和创建 `ANavigationDataChunkActor`。
- `Engine/Source/Runtime/Engine/Private/WorldPartition/NavigationData/NavigationDataChunkActor.cpp:81-93`：`CollectNavData()` 转发到 NavigationSystem。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMesh.cpp:3655-3680`：按 QueryBounds 找 Tile，并写入 `URecastNavMeshDataChunk`。

## 4. DataLayer 与“base navmesh / 动态重建”的精确关系

### 4.1 `BaseNavmeshDataLayers` 的语义

WorldSettings 的字段注释是：

> runtime DataLayer 列表，应该被包含到 base navmesh；编辑器 DataLayer 和不属于 DataLayer 的 Actor 也会被包含。

构建器侧确实把其中的 runtime asset 放入 `IncludedDataLayers`，从而保证这些层在生成 base chunk 时加载。源码入口是 `WorldPartitionNavigationDataBuilder::PreRun()` 的 `:38-52`。

### 4.2 `IsInBaseNavmesh()` 是另一套“分类”而不是构建器加载列表

`FNavigationSystem::IsInBaseNavmesh()` 的实际判断是：

1. Actor 没有 DataLayer：返回 `true`；
2. Actor 包含 `WorldSettings->BaseNavmeshDataLayers` 中任一 asset：返回 `true`；
3. 其他情况：返回 `false`。

源码：`Engine/Source/Runtime/Engine/Private/AI/Navigation/NavigationTypes.cpp:49-76`。

该结果在 `FNavigationElement` 创建时保存到 `bIsInBaseNavigationData`，见 `Engine/Source/Runtime/Engine/Private/AI/Navigation/NavigationElement.cpp:32-64`。

**重要区分：**

- “某个 DataLayer 在本轮 World Partition builder 中被加载，因此它的几何可能参与本轮 Tile 生成”；
- “某个 NavigationElement 被 `IsInBaseNavmesh()` 标记为 base data”。

这两者不是同一个判断函数，不能把 `bIsInBaseNavigationData` 当成构建器的完整 DataLayer 加载清单。尤其是源码中 `LoadDataLayers()` 明确默认强制加载 non-runtime DataLayer，而 `IsInBaseNavmesh()` 的 true 分支只显式检查“无 DataLayer”或“命中 BaseNavmeshDataLayers”。

### 4.3 World Partition 动态 NavMesh 的 DataLayer 行为

只有 Recast NavMesh 同时满足 `bIsWorldPartitioned` 且支持 runtime generation 时，NavigationSystem 才会打开 `WorldPartitionedDynamicMode`：

- `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp:1528-1538`。
- `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMesh.cpp:4379-4405`：`SupportsRuntimeGeneration()`、`IsWorldPartitionedDynamicNavmesh()` 和 active tile 判断。

在该模式下：

- 导航数据 chunk 流入时，`ARecastNavMesh::OnStreamingNavDataAdded()` 会挂接 chunk，并查找范围内的预存导航元素；对于不属于 base navmesh 的元素，添加 dirty area，促使动态导航重新生成。源码：`Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMesh.cpp:3684-3727`。
- `FNavigationDirtyAreasController::AddAreas()` 只有在“这是可见性变化，并且元素已经在 base navmesh”时才忽略 dirty；如果是加载 DataLayer 但元素不在 base，dirty 必须保留。源码：`Engine/Source/Runtime/NavigationSystem/Private/NavigationDirtyAreasController.cpp:134-152`。

可简化为：

```text
base navmesh 元素 + DataLayer/Cell 可见性变化
  -> 不重复把同一份 base 几何作为动态 dirty 重建

非-base 元素 + DataLayer/Cell 加载
  -> 产生 dirty area
  -> World Partition 动态 NavMesh 重新生成受影响 Tile
```

如果 NavMesh 是 Static，`IsWorldPartitionedDynamicNavmesh()` 不成立，以上动态 dirty 机制不能被当作 Static NavMesh 的运行时补救方案。Static 情况下，运行时 DataLayer 是否有可用导航数据，必须依赖已经生成并可流式加载的对应导航数据或项目自己的运行时策略；本次源码核对没有替项目配置做这个运行验证。

### 4.4 当前引擎源码明确暴露的限制

`WorldPartitionNavigationDataBuilder::GenerateNavigationData()` 在创建 chunk actor 前保留了注释：

```cpp
//@todo_ow: Properly handle data layers
```

位置：`Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp:458`。

这与实际代码一致：构建器按“加载范围 + 生成范围 + NavigationData chunk 网格”收集 Tile，并没有在这里为每个 DataLayer 创建独立的 NavData chunk 资产。当前可确认的模型是：**DataLayer 通过加载哪些 Actor 进入本轮 NavMesh 生成，以及在动态 WP NavMesh 中是否被标成 base/non-base 来影响生成/重建；不是“每个 DataLayer 自动得到一套独立 NavMesh chunk”。**

## 5. 规则矩阵

| 情况 | World Partition builder 是否强制加载 | `IsInBaseNavmesh()` 分类 | 动态 WP NavMesh 的直接效果 |
|---|---|---|---|
| Actor 不属于任何 DataLayer | 不由 DataLayer 开关排除，随 cell 加载 | `true` | 可视性变化不因 base 分类重复 dirty |
| runtime DataLayer 在 `BaseNavmeshDataLayers` | 是；`PreRun()` 加入 `IncludedDataLayers` | `true`（Actor 命中该 asset） | 作为 base 几何处理 |
| runtime DataLayer 不在 `BaseNavmeshDataLayers` | 仅当默认已加载或其他 include 条件使其加载 | `false` | 加载时需要 dirty / 动态重建受影响 Tile |
| non-runtime / editor DataLayer | 默认 `bLoadNonDynamicDataLayers=true`，强制加载 | `IsInBaseNavmesh()` 不会仅因 non-runtime 而自动返回 true | 不应把“被 builder 加载”与“base 分类”混为一谈 |
| World Partition + Static NavMesh | 取决于构建时加载内容和已保存 chunk | 仍按上述分类 | 不进入 `WorldPartitionedDynamicMode` 的动态 dirty 逻辑 |

## 6. 对项目使用的直接建议

1. **先确认构建路径**：在 World Partition 地图中，先确认 `ai.nav.bNavmeshAllowPartitionedBuildingFromEditor` 是否开启，以及日志是否出现 `WorldPartitionNavigationDataBuilder`；否则“Build Paths 完成”只说明普通 NavigationSystem Build 跑过，不能证明 chunk 已按全图生成。
2. **需要进入 base navmesh 的 runtime DataLayer**：将对应 `UDataLayerAsset` 放进 `WorldSettings.BaseNavmeshDataLayers`，并用分区 builder 生成保存的导航 chunk。
3. **需要运行时按 DataLayer 动态出现/消失的导航几何**：确认 Recast NavMesh 同时是 World Partition NavMesh，并启用了非 Static 的 RuntimeGeneration；否则不要依赖源码中仅在动态模式存在的 dirty/rebuild 路径。
4. **不要按 DataLayer 数量预期 chunk 数量**：当前 builder 的落盘单位是 NavigationData chunk 网格，源码还明确标注了 DataLayer 独立处理 TODO。
5. **调大构建加载单元要受内存约束**：`NavigationDataBuilderLoadingCellSize` 会按 `NavigationDataChunkGridSize` 向上取整，并且加载范围还会额外扩展 NavMesh TileSizeUU 的 overlap；单元越大并不只影响速度，也直接影响单次加载内存峰值。

## 7. 对“BaseNavmeshDataLayers 不完整”和构建变慢的解释

### 7.1 为什么加入 BaseNavmeshDataLayers 仍可能比直接设为可见少数据

`BaseNavmeshDataLayers` 不是编辑器 DataLayer 面板中的“可见”开关，至少有三个容易混淆的层次：

1. **Build Paths 的入口分支**：如果 `ai.nav.bNavmeshAllowPartitionedBuildingFromEditor` 没有开启，World Partition 地图也会直接调用 `FNavigationSystem::Build()`。这条路径不会执行 `WorldPartitionNavigationDataBuilder::PreRun()`，所以不会因为 `BaseNavmeshDataLayers` 自动加载对应 DataLayer 的 WP actors。直接把 DataLayer 设为可见/已加载时，actors 进入当前编辑器世界、对应 Level 可见并注册到 NavOctree，普通 Build 才能采集到它们。
2. **分区 builder 的 include 语义**：真正进入 `WorldPartitionNavigationDataBuilder` 后，`PreRun()` 只把列表中 `DataLayerInstance->IsRuntime()` 为真的层加入 `IncludedDataLayers`。因此，把 editor/non-runtime 的 TA 层加入该列表，并不会走这个强制 include 分支；builder 默认的 `bLoadNonDynamicDataLayers=true` 会加载 non-runtime 层，但这仍不等于把它设为可见。
3. **base 分类不负责加载**：`FNavigationSystem::IsInBaseNavmesh()` 只在导航元素已经创建时，把“无 DataLayer”或命中列表 asset 的元素标记为 base。它不会加载 WP cell，也不会把隐藏 Level 加入 NavOctree；`ConditionalPopulateNavOctree()` 仍按可见 Level 注册内容。因此，层没有加载/可见时，`IsInBaseNavmesh()` 的分类不会凭空产生几何。

所以最常见的解释是：**测试实际跑的是普通 Build，或 TA 层仍是 hidden/unloaded；而“直接设为可见”的对照组改变了 actor/Level 的加载与注册状态。** 若确实跑的是 WP builder，仍需确认 TA 层是 runtime DataLayer、列表引用的是同一个 `UDataLayerAsset`，并查看 builder 的 DataLayer load 日志。

此外，builder 的落盘单位仍是 NavigationData chunk 网格，不是每个 DataLayer 一套独立 NavMesh；源码在创建 chunk actor 处仍保留 `//@todo_ow: Properly handle data layers`。因此不能用“列表里有几个 DataLayer”推断会得到几套互相独立的导航数据。

### 7.2 当前项目中值得优先怀疑的慢点

已读取 `MistRoost/Config/DefaultEngine.ini`，当前导航配置包含：

- `RuntimeGeneration=Dynamic`（第 48、51 行）；DataLayer/cell 加载和可见性变化可能继续产生 dirty/rebuild 工作，不能把一次 Build 只看成单次静态烘焙。
- `bForceRebuildOnLoad=True`（第 47 行）；它控制导航数据的 load-time skip 行为，不是手动 Build 必然重复的证据，但应确认地图、cell 或导航数据加载时是否因此增加重建。
- `bDoFullyAsyncNavDataGathering=False`（第 40 行）；源码的 `ShouldGatherDataOnGameThread()` 会因此返回 true，导航数据收集没有配置为 fully async，编辑器主线程更容易成为体感瓶颈。
- `bUseVoxelCache=False`（第 43 行）；源码将该开关定义为“缓存栅格化 voxel 而非仅缓存碰撞顶点/索引”，关闭时重复生成相同区域缺少这层复用。
- `MaxSimultaneousTileGenerationJobsCount=1024`（第 28 行）；这不是越大越快，也不等于同时启动 1024 个任务。引擎实际将它限制为 `min(WorkerThreads * 2, 配置值)`，应以日志 `Using max of ... workers to build navigation` 的实际值判断，而不是先把 1024 当作直接根因。
- `TileSizeUU=1000`、`CellSize=19`（第 17-18 行）；在很大的 NavMesh bounds 下，Tile 数量和每 Tile 的体素化工作会快速增加。若地图存在多个 Agent 对应 NavData，工作量还会按 NavData 重复。

引擎路径本身还会放大以下成本：

- 普通 `FNavigationSystem::Build()` 最后对所有 NavData 调用 `EnsureBuildCompletion()`，编辑器会等待全部 Tile 任务完成；无效 `BuildBounds` 时 `RebuildAll()` 会走全量重建。
- WP builder 每个迭代 cell 都会先 `FStaticMeshCompilingManager::Get().FinishAllCompilation()`，再设置 `BuildBounds`、生成 Tile、收集 chunk 并保存 package；cell 数量多时，加载、编译、生成和磁盘 I/O 会重复发生。
- 加载/可见的 TA DataLayer 可能带来大量 Landscape、StaticMesh、Foliage、NavModifier 或自定义 `INavRelevantInterface` 元素。每个 Tile 都会查询 NavOctree，并按 `ShouldUseGeometry()` 决定是否导出和栅格化；复杂碰撞和 Modifier 数量通常比 DataLayer 名称本身更直接决定耗时。
- NavMesh Bounds 过大、`bWholeWorldNavigable`、多个 Agent、过小的 `TileSizeUU`，都会把待生成 Tile 数量放大。WP builder 还会按最大 `TileSizeUU` 扩展 cell overlap，导致相邻迭代重复加载/查询边界内容。

相关源码：`NavigationData.h:559-562,680`、`RecastNavMesh.h:764-766,864-866,931-933,1499`、`RecastNavMeshGenerator.cpp:5463-5472`。

### 7.3 建议按此顺序定位

1. **先判定走哪条路径**：输出只有 `UNavigationSystemV1::Build started...` 且没有 `Starting NavigationDataBuilder`，就是普通 Build；看到 `Starting NavigationDataBuilder`、`IterativeCellSize` 和 `Iteration ... GenerateNavigationData`，才是 WP builder。
2. **做最小对照**：保持地图和 NavMesh 设置不变，只比较“DataLayer 可见/已加载”和“加入 Base 列表但不改变可见/加载状态”。若前者有数据、后者没有，先修正构建路径和 DataLayer 加载状态，不要先调 Tile 参数。
3. **检查 TA 层类型与 asset 引用**：确认它是 runtime 还是 editor/non-runtime，WorldSettings 列表引用的是 DataLayer asset 而不是另一个同名实例；查看 builder 是否报告 `Missing UDataLayerInstance`。
4. **再看规模因素**：记录 NavMesh Bounds 面积、有效 Agent/NavData 数量、Tile 数量，以及单个 TA 层加载后新增的导航相关 Actor/Component。先缩小 Bounds 或只加载一个 cell 做时间对照。
5. **最后看项目配置与硬件争用**：重点对照 `bForceRebuildOnLoad`、`RuntimeGeneration`、`bDoFullyAsyncNavDataGathering`、`bUseVoxelCache` 和过高的并发任务数；任何配置修改都应以一次可重复的时间/日志对照为依据。

以上是源码和当前 `DefaultEngine.ini` 形成的高概率解释，不是对具体 `.umap` 当前结果的实测判定；仍需要编辑器 Output Log、DataLayer runtime/loaded/visible 状态和一次可重复的 Build 时间样本才能确定主因。

## 8. “只构建选定 Nav Bounds”的可行性

### 8.1 普通编辑器 Build：可行，优先使用引擎已有 BuildBounds

UE 5.8.2 已有可用的局部构建入口，不必复制 Recast 生成算法：

```cpp
UNavigationSystemV1* NavSystem = FNavigationSystem::GetCurrent<UNavigationSystemV1>(World);
NavSystem->SetBuildBounds(SelectedBounds);
FNavigationSystem::Build(*World);
NavSystem->SetBuildBounds(FBox(EForceInit::ForceInit));
```

`UNavigationSystemV1::Build()` 在 `BuildBounds` 有效时先调用 `DirtyTilesInBuildBounds()`，由每个 `ARecastNavMesh` 只把该盒体相交的 Tile 标脏，然后等待这些生成任务完成。`SetBuildBounds()` 和 `FNavigationSystem::Build()` 都是引擎导出的接口，适合由 Editor-only C++ 模块/插件绑定到一个按钮。

推荐的编辑器工具形态：

1. 做一个 Editor-only 工具或插件，不修改引擎源码；
2. 用当前选择的一个或多个 `ANavMeshBoundsVolume`，或自定义 `ANavBuildRegion` 盒体，得到 `FBox`；
3. 按钮执行 `SetBuildBounds()`、`FNavigationSystem::Build()`，完成后清空临时 `BuildBounds`；
4. 在按钮执行期间暂时避免 DataLayer/Actor 加载导致的额外 dirty 更新，并显示实际构建范围。

这会限制“生成哪些 NavMesh Tile”，但不是严格的 Actor 白名单：盒体内的所有已加载导航元素仍会按 NavOctree、Agent 和 `ShouldUseGeometry()` 参与构建。它也不会阻止导航系统做注册、加载和任务等待，因此如果主要瓶颈是大量 Actor 注册或 `bDoFullyAsyncNavDataGathering=false`，耗时不会按面积等比例下降。

`BuildBounds` 是单个 `FBox`：多个不相连的选择如果直接求总包围盒，中间空白区域也会被构建；要严格按多个区域处理，应逐个区域构建，或实现自己的多区域 dirty/调度逻辑。已有的 `BuildSelectedAIPaths` 名称也不等于“按选定 Nav Bounds 构建”，源码最终仍进入同一导航构建分支，没有替工具设置选定 `BuildBounds`。

相关源码：

- `NavigationSystem.h:748-749`、`NavigationSystem.cpp:2443-2446`：`SetBuildBounds()`；
- `NavigationSystem.cpp:4441-4509`：Build、局部 dirty、等待完成；
- `NavigationSystem.cpp:6182-6191`：`DirtyTilesInBuildBounds()`；
- `RecastNavMesh.cpp:4801`：Recast NavMesh 的 bounds dirty 入口。

### 8.2 World Partition 持久化 chunk：可行，但不能只调用 SetBuildBounds

如果目标只是当前编辑器中快速刷新局部 NavMesh，8.1 的方案足够；如果目标是生成可被 WP streaming/cook 使用的 `ANavigationDataChunkActor` 持久化数据，则必须走 WP builder 语义。

原因是 `WorldPartitionNavigationDataBuilder` 不只负责 Tile 生成，还负责：

- 按 DataLayer 和 WP cell 加载 Actor；
- 每个迭代 cell 设置 `LoadedBounds`；
- 删除生成范围内旧的 NavigationDataChunkActor；
- 收集 Tile 到 chunk；
- 保存/删除对应 package。

`UWorldPartitionBuilder::Run()` 会从 `IterativeWorldBounds` 计算迭代 cell，再对每个 cell 调用 `FLoaderAdapterShape` 加载范围和派生 builder 的 `RunInternal()`。因此真正的“选择区域构建”应做一个 Editor-only 自定义 WP builder/包装层，把用户选择的 `FBox` 作为迭代边界或 cell 过滤条件，同时复用现有导航 builder 的 DataLayer 加载、Tile 收集和 package 保存逻辑。

需要接受两个边界：

1. 选择范围通常会被对齐/扩展到 WP 迭代 cell、NavMesh Tile overlap 和 NavigationData chunk grid，不一定是像素级精确的盒体；
2. 只重建局部 chunk 时，必须只删除和保存相交的 chunk package，并确保边界 overlap 足够，否则容易出现跨区域连接断裂、旧 Tile 残留或相邻 chunk 不一致。

不要把普通 `SetBuildBounds()` 调用当成 WP chunk 生成替代品：它主要解决“当前已加载世界中的局部 Tile Build”，不会自动完成 WP cell 加载、chunk 复制和持久化。

### 8.3 建议的实现分层

```text
按钮 / Editor Command
  -> 读取 ANavBuildRegion 或当前选择的 NavMesh Bounds
  -> FBox SelectedBounds
  -> 非 WP 持久化需求：SetBuildBounds + FNavigationSystem::Build
  -> WP chunk 持久化需求：启动带 SelectedBounds 的自定义 WorldPartitionBuilder
```

对当前 MistRoost 项目，建议先实现 **Editor-only 局部 Build 预览版**，验证选定 Bounds 确实能把时间和 Tile 数量降下来；再决定是否投入 WP chunk 的局部保存工具。这样可以先区分“Tile 生成慢”和“WP cell/StaticMesh 编译/保存慢”，避免一开始复制整套 `WorldPartitionNavigationDataBuilder`。

## 9. 源码索引

| 主题 | UE 5.8.2 源码 |
|---|---|
| 编辑器 Build Paths 入口 | `Engine/Source/Editor/LevelEditor/Private/LevelEditorActions.cpp`：`FLevelEditorActionCallbacks::BuildPathsOnly_Execute` |
| Build 分支与 WP builder 启动 | `Engine/Source/Editor/UnrealEd/Private/EditorBuildUtils.cpp`：`EditorBuild`、`TriggerNavigationBuilder`、`WorldPartitionBuildNavigation` |
| 普通导航构建总入口 | `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp`：`UNavigationSystemV1::Build` |
| 全量 / 局部边界 | `Engine/Source/Runtime/NavigationSystem/Private/NavigationSystem.cpp`：`RebuildAll`、`DirtyTilesInBuildBounds` |
| NavMesh Tile 生成 | `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMeshGenerator.cpp`：`RebuildAll`、`UpdateNavigationBounds`、`MarkNavBoundsDirty`、Tile geometry gather |
| WP 分区构建 | `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionNavigationDataBuilder.cpp` |
| WP builder DataLayer 加载 | `Engine/Source/Editor/UnrealEd/Private/WorldPartition/WorldPartitionBuilder.cpp`：`LoadDataLayers` |
| base navmesh DataLayer 配置 | `Engine/Source/Runtime/Engine/Classes/GameFramework/WorldSettings.h`：`BaseNavmeshDataLayers` |
| base/non-base 分类 | `Engine/Source/Runtime/Engine/Private/AI/Navigation/NavigationTypes.cpp`：`FNavigationSystem::IsInBaseNavmesh` |
| 动态 WP dirty 处理 | `Engine/Source/Runtime/NavigationSystem/Private/NavMesh/RecastNavMesh.cpp`、`NavigationDirtyAreasController.cpp` |

## 10. 本次核对的未覆盖项

- 未读取 MistRoost 当前具体地图的 World Partition、RecastNavMesh、NavMeshBoundsVolume、DataLayer asset 配置。
- 未执行编辑器菜单操作、World Partition builder commandlet、PIE、Cook 或打包。
- 因此本文确认的是 **UE 5.8.2 源码规则和调用条件**，不是当前项目已经生成成功的运行验收结论。

