# 数据源详情：PRTS Wiki

> 配套文档，上级总报告见 [调研报告-数据源.md](file:///d:/游戏活动数据源整合和提醒助手/调研报告-数据源.md)
> 最后实测：2026-09-30。所有结论基于真实请求，原始响应在 [_research/raw/](file:///d:/游戏活动数据源整合和提醒助手/_research/raw)

## 1. 它是什么

PRTS（prts.wiki）是基于 MediaWiki + Semantic MediaWiki（SMW，语义媒体维基）的明日方舟中文 Wiki，CC BY-NC-SA 4.0。

页面的结构化属性可通过两种官方 API 获取：
- **Ask API**（`action=ask`）：SMW 提供，按条件查询属性，返回 JSON。本项目主用。
- **标准 MediaWiki API**（`action=query`）：取分类、页面文本、链接等。

## 2. 它实际提供哪些数据（仅列已实测确认）

| 数据 | 来源属性/接口 | 类型 | 实测覆盖率 |
|------|--------------|------|-----------|
| 活动开始时间 | `活动开始时间` | Unix 秒（字符串） | 296/296 |
| 活动结束时间 | `活动结束时间` | Unix 秒（字符串） | 296/296 |
| 活动商店/里程碑结束时间 | `兑换结束时间` | Unix 秒 | 仅部分页面填写（如矢量突破#3） |
| 卡池关闭时间（国服） | `寻访关闭时间cn` | Unix 秒 | 仅标准寻访页面填写；定向甄选等非标卡池为空 |
| 官网公告 id | `官网链接` | 文本 | 282/296，存在异常值 |
| 页面业务分类 | `action=query&prop=categories` | 分类标题列表 | 仅 27/296 直接挂业务类 |
| 页面标题 / 显示标题 / URL | `fulltext` / `displaytitle` / `fullurl` | 文本 | 全部；个别 displaytitle 为空（如"稳态测定"） |

未实测但 SMW 理论支持：更多自定义属性、链查询（沿关系跳转）。需进一步采样验证。

## 3. URL 书写规则与请求方法

### 3.1 端点

| 域名 | 本机可达性 |
|------|-----------|
| `https://prts.wiki/api.php` | **403（Tengine WAF 拦截，多种 UA 均失败）** |
| `https://m.prts.wiki/api.php` | **200，使用此域名** |

### 3.2 全量活动查询

PowerShell 正确写法（参数全部经 `--data-urlencode` 编码）：

```powershell
curl.exe -sS -G 'https://m.prts.wiki/api.php' `
  --data-urlencode 'action=ask' `
  --data-urlencode 'query=[[分类:有活动信息的页面]][[!分类:愚人节活动]]|?活动开始时间|?活动结束时间|?官网链接|limit=1000' `
  --data-urlencode 'format=json'
```

查询语句（SMW Ask 语法）组成：
- `[[分类:有活动信息的页面]]`：页面集合；
- `[[!分类:愚人节活动]]`：排除愚人节（`!` = 否定）；
- `|?属性名`：要输出的属性；
- `|limit=1000`：条数上限。

加查子阶段时在 query 中追加 `|?兑换结束时间|?寻访关闭时间cn`。

### 3.3 单页分类查询

```
GET https://m.prts.wiki/api.php
    ?action=query&prop=categories&cllimit=50
    &titles=矢量突破/03&format=json
```

批量取全部分类：用 `generator=categorymembers&gcmtitle=分类:有活动信息的页面&gcmnamespace=0&gcmlimit=500` 配合 `prop=categories`。

### 3.4 踩坑记录

| 错误写法 | 后果 |
|----------|------|
| 裸 `!` 不编码 | API 报"无法理解查询" |
| 把 `&format=json` 写进 query（`%26format=json`） | 返回 API 帮助 HTML |
| 省略 `format=json` | 返回 HTML 调试页 |
| 直连 www 域名 | 403 |

## 4. 返回结构

### 4.1 Ask 响应骨架

```json
{
  "query": {
    "printrequests": [ { "label": "活动开始时间", "typeid": "_dat" } ],
    "results": {
      "<页面全名>": {
        "fulltext": "矢量突破/03",
        "displaytitle": "矢量突破#3「拟生态」",
        "fullurl": "//prts.wiki/w/矢量突破/03",
        "namespace": 0,
        "exists": "1",
        "printouts": {
          "活动开始时间": [ { "timestamp": "1790668800", "raw": "1/2026/9/29/8/0/0/0" } ],
          "活动结束时间": [ { "timestamp": "1792439940", "raw": "..." } ],
          "官网链接": [ "1455" ]
        }
      }
    }
  }
}
```

要点：
- `results` 是以页面名为键的**对象**，不是数组；
- 时间 `timestamp` 是**字符串 Unix 秒**，需 `Number()` 转换；
- `raw` 是 MediaWiki 内部日期 `1/年/月/日/时/分/秒/...`，不要解析；
- 属性值都是**数组**，缺失时为空数组 `[]`。

### 4.2 官网链接字段的异常

多数为短数字公告 id（拼 `https://ak.hypergryph.com/news/{id}.html`）。
实测存在异常值，如 `"2020107970"`（10 位，疑编辑错误），消费端必须做数字范围/位数校验。

### 4.3 query&prop=categories 响应骨架

```json
{ "query": { "pages": { "96813": {
  "title": "矢量突破/03",
  "categories": [ { "ns": 14, "title": "分类:矢量突破" } ]
} } } }
```

业务分类与技术性分类（如"使用 Tabber 解析器标签的页面"）混在一起，需按名称白名单过滤。

## 5. 证据文件

- [prts_ask_all.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/prts_ask_all.json)：全量 296 条（148KB）
- [prts_ask_stages_03.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/prts_ask_stages_03.json)：含子阶段属性
- [prts_categories_03.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/prts_categories_03.json) / [prts_all_categories.json](file:///d:/游戏活动数据源整合和提醒助手/_research/raw/prts_all_categories.json)：单页/全量分类
