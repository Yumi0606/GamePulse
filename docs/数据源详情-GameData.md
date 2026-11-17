# 数据源详情：ArknightsGameData（游戏官方配置解包）

> 配套文档，上级见 [调研报告-数据源.md](file:///d:/游戏活动数据源整合和提醒助手/调研报告-数据源.md)
> 最后实测：2026-09-30

## 1. 它是什么

仓库 `Kengxxiao/ArknightsGameData`，明日方舟客户端数据的解包/导出仓库，含各服务器目录。数据是游戏官方配置的原样导出，非社区编辑。

更新机制：随客户端数据更新，实测最近提交 **2026-09-29**（CN UPDATE，约每 1~9 天一次），客户端版本 2.7.71。

## 2. 它提供哪些数据（全部实测）

核心文件：`zh_CN/gamedata/excel/activity_table.json`（约 **14MB**）。

| 数据 | 位置 | 类型 | 实测覆盖 |
|------|------|------|----------|
| 活动开始时间 | `basicInfo.*.startTime` | **数字** Unix 秒 | **318/318** |
| 活动结束时间 | `basicInfo.*.endTime` | 数字 Unix 秒 | 318/318 |
| 奖励期结束 | `basicInfo.*.rewardEndTime` | 数字 Unix 秒 | **318/318**（奖励期定义见下，**不是分段**） |
| **活动分段** | `zone_table.json → zoneValidInfo` | 每 zone 独立 startTs/endTs | 103 个活动含多 zone，实测可用 |
| 活动类型 | `basicInfo.*.type` | 枚举字符串 | 318/318 |
| 是否复刻 | `basicInfo.*.isReplicate` | 布尔 | 全部 |
| 关联 zone/关卡 | `zoneToActivity`、`activity` | 对象 | 存在 |
| 奖章组 | `medalGroupId` | 字符串 | 部分 |

#### 卡池表 gacha_table.json（已实测，460KB）

路径同目录，字段在 `gachaPoolClient` 数组（**451 条**）：

| 字段 | 含义 |
|------|------|
| `gachaPoolId` | 卡池 id |
| `gachaRuleType` | 卡池类型枚举（DOUBLE / CLASSIC_DOUBLE / LIMITED / LINKAGE…） |
| `openTime` / `endTime` | 数字时间戳 |
| `gachaPoolName` / `gachaPoolSummary` / `gachaPoolDetail` | 名称/简述/详述（detail 多为 null） |
| `dynMeta.main6RarityCharId` / `rare5CharList` | UP 六星/五星干员 id |
| `guaranteeName` / `guarantee5Count` | 保底类型/次数 |

顶层另有 `newbeeGachaPoolClient`（新手池）、`specialRecruitPool`、`carousel`（357 条轮播图配置）、`gachaTags`（公招标签）等。

#### 分段 vs 奖励期（概念澄清，2026-09-30）

这两个是**不同概念**，不可混用：

- **活动分段（Stage）**：活动内关卡分批开放。如 SideStory 两周，第一周普通关、第二周加开 EX 关，分段在活动结束（endTime）时终止。
  - 数据来源：`zone_table.json` 的 `zoneValidInfo`，键为 `<活动id>_zone1/zone2/...`，每段有独立 `startTs/endTs`。
  - 实测：103 个活动含多 zone。例：`act9d0` 三批 2020-04-21 / 04-28 / 05-05 开放；`act3break` zone1 9/29、zone2 10/6。
  - zone 名称/类型在同一文件的 `zones.<zoneID>`（type、zoneNameFirst 等）。
- **奖励期**：活动结束后兑换/商店继续开放的时间，**不属于分段**。
  - 数据来源：`basicInfo.rewardEndTime`，通常晚于 endTime。
  - 例：矢量突破 endTime 10-20，rewardEndTime 10-23。

## 3. 活动类型枚举（实测分布）

```
63 CHECKIN_ONLY    60 TYPE_ACT9D0   28 LOGIN_ONLY   18 MINISTORY
16 PRAY_ONLY       11 COLLECTION     8 SWITCH_ONLY    6 BOSS_RUSH
5 APRIL_FOOL       4 UNIQUE_ONLY    4 GRID_GACHA_V2  4 CHECKIN_VS ...
```

枚举值是稳定的程序标识，天然适合做"类别开关"，不依赖人工分类——**直接解决 PRTS 的类别缺口**。

## 4. URL 规则

文件 URL（raw 直连国内不稳，curl 18 断流过；推荐 jsDelivr）：

```
https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/activity_table.json
```

仓库文件树（用于查其他配置表）：

```
https://api.github.com/repos/Kengxxiao/ArknightsGameData/git/trees/master?recursive=1
```

文件很大（14MB / 14565 个文件），客户端不应全量拉取仓库；只拉 activity_table.json。

## 5. 返回结构（骨架）

```json
{
  "basicInfo": {
    "act3break": {
      "id": "act3break",
      "type": "VEC_BREAK_V2",
      "name": "矢量突破#3 拟生态",
      "startTime": 1790668800,
      "endTime": 1792439999,
      "rewardEndTime": 1792699199,
      "isReplicate": false,
      "medalGroupId": "medalGroupActivityAct3break",
      "hasStage": true,
      "displayOnHome": true
    }
  },
  "zoneToActivity": { },
  "activity": { },
  "homeActConfig": {}, "actTimeTrackPoint": {}, "missionData": {}
}
```

要点：
- `basicInfo` 是以活动 id（如 `act3break`）为键的对象，共 **318** 条；
- 时间是**数字**，可直接比较，注意 endTime 是 `...59`（含最后一秒），做边界时按 `endTime+1` 或用 `>=` 判断；
- 顶层还有大量域（missionData、carData、autoChessData 等 30+），MVP 只用 basicInfo。

## 6. 与 PRTS 对比（关键结论）

| 维度 | GameData | PRTS |
|------|----------|------|
| 数据性质 | 官方配置，权威 | 社区编辑 |
| 活动数 | 318 | 296 |
| 时间字段 | 数字、无缺失 | 字符串、无缺失 |
| 类别 | **稳定枚举，全覆盖** | 稀疏，仅 27 页直挂 |
| 子阶段 | rewardEndTime 全覆盖 | 兑换结束时间部分填 |
| 及时性 | 随客户端更新（1~9 天） | 依赖编辑者 |
| 体积 | 14MB | 148KB |

结论：**GameData 应作为首选数据源**（类别和权威性都更强），代价是 14MB 体积；PRTS/BWIKI 作轻量或交叉参考。最终取舍由用户判定。

## 7. 证据

- [gamedata_activity_table.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/gamedata_activity_table.json)：完整 14MB
- [gamedata_tree.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/gamedata_tree.json)：全仓库文件树
- [gamedata_gacha_table.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/gamedata_gacha_table.json)：卡池表 460KB（451 条）
