# cnipa-patent-quick

> 专利年费速查 —— 给什么输入，都出同一张 4 列的表：**专利号 / 名称 / 年费 / 截止日**

基于 [CNIPA 中国及多国专利审查信息查询](https://cpquery.cponline.cnipa.gov.cn)（cpquery）的 WorkBuddy 技能。
**每号只发 2 次请求**（申请信息 `sqxx` + 费用 `fyxx`），比档案版 `cnipa-patent-dossier` 快 **2~3 倍**。

---

## 核心能力：输入自动识别

前置第 0 步自动判断你给的是什么，判完自动走对应检索路径：

| 识别结果 | 判据 | 检索方式 | 输出 |
|---|---|---|---|
| **专利号** | 去 `CN`/`ZL` 前缀、校验位点后是 8/9/12/13 位纯数字 | `zhuanlisqh` 逐号检索 + 完全相等 | 该号的 名称 / 年费 / 截止日 |
| **专利名称** | 命中显式标签，或既非号码、又无机构名后缀 | `zhuanlimc` 检索 + 完全相等 | 该名称对应专利的 号 / 年费 / 截止日 |
| **申请人** | 命中机构名后缀词表（公司/有限/股份/研究院/大学/医院/集团/事务所…） | `shenqingrxm` 检索 + 段完全相等 | **该申请人名下全部专利**的 号 / 年费 / 截止日 |

判定优先级：**显式标签 > 号码形态 > 机构名后缀 > 默认按名称**。

- **显式标签最高**：`专利号：CN202422940446.4`、`名称：一种分切机`、`申请人：某某机械厂` 直接采纳
- **兜底不误伤**：`专利号牌识别装置` 这种以「专利号」开头的**专利名称**，会识别为名称而非号码
- **12 位号会告警**：`202422940446` 缺第 13 位校验位，CNIPA 库里查不到，会标「未查到」
- 每条判定理由都会打印（`[识别] 输入类型判定：…`），可追溯

★ **输出列永远是这 4 列**（顺序固定、无序号），与输入类型无关。

---

## 快速开始

```bash
# <node>  = Node.js ≥22 可执行文件的绝对路径（自查：where node && node -v）
# <skill> = 本技能目录

# 按专利号查
<node> <skill>/scripts/cnipa-quick-run.mjs --input "CN202422940446.4"

# 按名称查
<node> <skill>/scripts/cnipa-quick-run.mjs --input "一种分切机"

# 按申请人查（出该申请人名下全部专利）
<node> <skill>/scripts/cnipa-quick-run.mjs --input "江西创导动物保健品有限公司"

# 混着给、或从文件读（一行一条，可混类型，# 注释）
<node> <skill>/scripts/cnipa-quick-run.mjs --input-file 清单.txt

# 锁定基准日（复现某天的表）
<node> <skill>/scripts/cnipa-quick-run.mjs --input-file 清单.txt --as-of 2026-09-15 --out 年费速查.csv
```

产物：`专利年费速查.csv`（**带 BOM**，Excel 双击不乱码）+ 中间文件 `rows.json` / `quick-detail.json`。
**中断了直接重跑同一条命令**：采集自动续抓，已成功的号不重抓。

---

## 年费 / 截止日分档规则

| 档 | 案件状态 | 年费 | 截止日 |
|---|---|---|---|
| ① | 含 **`等年费滞纳金`** | 「缴费时段**包含今天**」那一段的**总计**（当期年费 + 滞纳金） | 该时段**原文**：`2026年08月18日到2026年09月15日` |
| ② | 其它（含 `专利权维持`） | 最近的**未缴**年费金额 | 该笔年费缴费截止日 `YYYY-MM-DD` |
| ③ | 实用新型 + `未缴年费专利权终止，等恢复` | `等恢复·按口径未取年费`（**连 `fyxx` 都不发**） | 空 |
| ④ | 无未缴年费 | `无未缴年费` | 空 |
| ⑤ | 接口失败 / 号不在库 | `数据缺口(...)` / `未查到` | 同左 |

★ **① 取哪一段是关键**：CNIPA 从宽限期末一路排到缴费截止日，滞纳金逐月递增（每月 +5%），
用户要的是「**今天落在哪一段**」，不是最晚一段。
实测 `2023211657312` 共 5 段（总计 180/225/270/315/360）：基准日 09-15 → **270**，09-16 → **315**。

其它口径约定：

- **默认不过滤** —— 给多少号出多少行，便于对账。`--status-filter "专利权维持,等年费滞纳金"` 可选
- **日期写法**默认时段原文；`--slashes` 切到斜杠写法（`2026/8/18到2026/9/15`）
- **「查不到数据」与「确实没有」严格分开**：取不到接口一律写 `数据缺口`，绝不静默当 0
- **状态不一致如实报**：检索行与详情状态冲突时写 `数据缺口(检索行与详情的案件状态不一致)`，不藏真实年费

---

## 前置条件

1. **browser-skill（bsk）可用** —— CLI 在 `~/.local/bin/bsk.exe`，daemon 运行中且扩展已连接浏览器。
   自检 `bsk doctor` 全 `ok`。
2. **Node.js ≥ 22** —— 用到内置 `fetch` / `AbortSignal.timeout`。
3. **cpquery 登录态** —— 判据为 cpquery 列表页 `localStorage.ACCESS_TOKEN` 存在且未过期。
   token 约 **8~10 小时**过期，过期需**重新登录**，且要登在 **bsk 的 Agent Window** 里。
   **只需 cpquery 这一套登录态**，不碰专利业务办理系统 / 票据系统。

---

## 脚本清单

| 脚本 | 作用 |
|---|---|
| `cnipa-quick-input.mjs` | ★ 第 0 步：输入类型识别 + 归一化 + 查询计划；`--self-test` 离线跑 29 条用例 |
| `cnipa-quick-search.mjs` | 第 1 步：按识别结果走三路检索 + 精确过滤 + 行序确定化 + 同号去重 → `rows.json` |
| `cnipa-quick-detail.mjs` | 第 2 步：逐号采集（每号 2 次请求）→ `quick-detail.json`；等恢复件只发 1 次 |
| `cnipa-quick-report.mjs` | 第 3 步：出 4 列 CSV（**列定义与取值口径的唯一来源**） |
| `cnipa-quick-run.mjs` | 一键：代理自检 → 识别 + 检索 → 采集 → 出表 |
| `cnipa-quick-cdp.mjs` | CDP 通信层：`evalJs` / `probeJs` / `findOrOpenTab` / `ensureLiveSession` |
| `bsk-cdp-shim.mjs` | 把 bsk 包装成 CDP 兼容代理（127.0.0.1:3456），与档案版同源同码可直接复用 |
| `tests/report-selftest.mjs` | ★ 离线回归：造全部分档假数据跑出表脚本，断言 4 列表头与各档取值 |

## 自测（改完口径先跑这两个，都不用联网）

```bash
<node> <skill>/scripts/cnipa-quick-input.mjs --self-test   # 输入识别：29 条用例
<node> <skill>/tests/report-selftest.mjs                     # 出表口径：18 条断言
```

---

## 分步执行（想手工控制进度时）

```bash
# 0) 起 CDP 代理（另开终端常驻；一键脚本会自动后台拉起）
<node> <skill>/scripts/bsk-cdp-shim.mjs --keep-session

# 1) 识别 + 检索 → rows.json
<node> <skill>/scripts/cnipa-quick-search.mjs --input "一种分切机"

# 2) 采集 → quick-detail.json（可中断、重跑续抓）
<node> <skill>/scripts/cnipa-quick-detail.mjs rows.json

# 3) 出 4 列 CSV（不重抓就能改基准日 / 写法 / 输出名重出）
<node> <skill>/scripts/cnipa-quick-report.mjs --rows rows.json --detail quick-detail.json --as-of 2026-09-15 --out 专利年费速查.csv
```

## 限流与续跑

- 详情接口是**令牌桶**限流，撞上返回 **400**（响应体只有空行）且会**连坐**
- 节奏默认 `--gap 2000 --batch 4 --batch-gap 1500`（中节奏，100 件以内稳态 0 限流）
- 请求内即时重发（`--retry` 默认 2）**只对 `404/5xx/0/-1` 补发**；`400`（限流）与 `401`（令牌失效）**绝不补发**
- **每批落盘**，杀进程不丢进度；`--max-min` 默认 120 分钟主动收工

| 现象 | 含义与处置 |
|---|---|
| `400` | 接口限流冷却中。等 3~5 分钟重跑，**不要重新登录** |
| `401` | 令牌过期 → 重新登录 CNIPA（登在 bsk 的 Agent Window 里） |
| `-1` / `Failed to load ...?hHp4Kgam=` | 标签页请求层整体坏掉 → **开新 cpquery 标签页立刻恢复**（脚本已内置自愈） |

---

## 与 cnipa-patent-dossier 的关系

同源（bsk + CDP shim + cpquery 接口），本技能是**只保留四列的瘦身版**：

| 维度 | cnipa-patent-dossier | cnipa-patent-quick（本技能） |
|---|---|---|
| 输入 | 三种，但需显式选参数 | **同样三种，会先自动识别**（还支持混类型清单） |
| 每号请求 | 5~6 次 | **2 次**；等恢复件只 1 次 |
| 输出 | 17 列合并表 / 14 列档案 / 6 列年费表 | **固定 4 列** |
| 默认过滤 | 只出「专利权维持 / 等年费滞纳金」 | 不过滤（`--status-filter` 可选） |
| 日期写法 | `2026/9/16到2026/10/15` | 时段原文 `2026年09月16日到2026年10月15日`（`--slashes` 可切） |

年费 / 截止日的**选段口径两边完全一致**，可以对表。
要分案 / 通知书 / 质押 / 许可 / 变更费请用档案版。

---

## 安全与合规说明

- 脚本**不做任何认证绕过**：所有请求都带 `Authorization: Bearer <localStorage.ACCESS_TOKEN>`，即用户**本人合法登录的会话**
- `ACCESS_TOKEN` **只在浏览器上下文内用于判断登录态**，不外传、不落盘、不写入任何输出文件
- 无 `eval`、无任意文件删除、无第三方外网请求；命令执行**一律不经 shell**（无命令注入面）
- 唯一的环境变量读取是 `process.env.BSK_BIN`，仅用于定位 bsk 可执行文件
- 仅访问 CNIPA **公开查询系统** `cpquery.cponline.cnipa.gov.cn`，不触碰专利业务办理系统 / 票据系统
- 默认节奏保守（2 秒间隔 / 4 条一批），并带指数冷却，避免给站点造成压力

**请遵守 CNIPA 站点的使用条款与 robots 协议，仅将本技能用于你有合法访问权限的查询场景。**

## License

[MIT](LICENSE) © 2026 annekidding