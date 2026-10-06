# 一刻

[![CI](https://github.com/LHC728/yike/actions/workflows/ci.yml/badge.svg)](https://github.com/LHC728/yike/actions/workflows/ci.yml)

> 想到的那一刻，就记下来。

极简、本地优先、跨设备同步的「灵感 + 待办 + 大事 + 时间线」工具。

只解决三件事：

1. 我突然想到一个东西 → 立即记下来。
2. 我突然想到一件要做的事 → 立即记下来，并可以完成它。
3. 我最近在推进一件大事 → 记下来，随时看进度和还剩几天，
   还能在详情里**逐条写下「做到哪一步了」**，回头看就知道当时卡在哪。

核心体验：**想到 → 写下 → 继续做自己的事情。**

浅色 / 深色 / 跟随系统三态主题，在「设置 → 外观」里切。
主题只是一组 CSS 令牌换值（`html.dark`），组件里没有任何一处判断当前主题。

---

## 快速开始

```bash
npm install
npm run setup      # 启用 git 提交门禁（跑一次即可）
npm run dev        # 开发（http://localhost:5173）
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览构建产物
npm run verify     # 一键门禁：类型 + Lint + 单元测试
```

开箱即用：**不配置云端也能完整使用**，此时进入「本机模式」，
所有数据保存在浏览器 IndexedDB，离线、断网、飞行模式都正常工作。

> `npm run setup` 只是把 git 的 `core.hooksPath` 指向仓库内的 `.githooks/`，
> 不安装任何依赖。不跑也不影响开发，只是提交前不会自动检查。

想装到手机或 Linux 桌面上用？见 **[部署与安装](#部署与安装)** ——
这一步有个硬性前提，不看会白折腾。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite |
| UI | Tailwind CSS v4 + Lucide |
| 本地数据库 | IndexedDB（Dexie 4） |
| PWA | vite-plugin-pwa（Workbox） |
| 云（二选一） | Cloudflare Workers + D1 ／ Supabase Auth + PostgreSQL + Realtime |
| 测试 | Vitest + Playwright |

---

## 目录结构

```
src/
  app/          router / AppShell / uiStore / navItems / themeStore（三态主题）
  pages/        HomePage  IdeasPage  CalendarPage  TodosPage  LoginPage
  components/   QuickCapture RecordRow RecordNode CompletedTodoRow RecordDetail
                ProjectModule ProjectEditor ProjectProgress ProjectLogs
                （大事模块 / 编辑器 / 进度条 / 逐条进展）
                TodoCheckbox DateGroup MonthCalendar BottomNav DesktopSidebar
                SyncIndicator ConflictDialog SearchPanel SettingsSheet Modal Toaster
                ErrorBoundary
  domain/       record.ts（Record 领域模型）  mutation.ts（同步单元）
  db/           db.ts  recordRepository.ts  outboxRepository.ts
  sync/         SyncEngine PullService ReconcileService PushService
                RealtimeService ConflictService NetworkWatcher syncStatus
  cloud/        CloudAdapter（唯一边界）  cloudProvider（选后端）
                CloudflareAdapter  cloudflareClient  cloudflareSession  cloudConfig
                SupabaseAdapter  supabaseClient
  auth/         AuthService
  hooks/        useRecords  useSyncStatus  useMediaQuery  useToday（跨午夜刷新）
  utils/        time  timezone  id
worker/         Cloudflare Workers 后端（可选，不用就不部署）
  schema.sql    D1 建表 + 把产品红线写成触发器的脚本（⚠️ 只对全新库有效）
  migrations/   增量迁移；0002 是「大事」、0003 是「进展」要的那两次
                （都必须重建 records 表）
    __fixtures__/  各次迁移**之前**那份 schema 的冻结副本（历史事实，不许改）
  src/core.ts   鉴权与「原子应用一次 Mutation」（纯逻辑，好测）
  src/index.ts  HTTP 层：CORS / 路由 / 请求体校验
  wrangler.toml database_id 由 npm run cloudflare:setup 回填
scripts/
  gen-icons.mjs           生成 PWA 图标（手写 PNG 编码）
  check-base.mjs          校验构建产物路径与部署基路径一致
  check-contrast.mjs      从 index.css 解析真实令牌算 WCAG 对比度（浅色 + 深色）
  check-installable.mjs   实测某个地址能否被安装为 PWA（CDP 权威判据）
  check-sync.mjs          对着真实后端跑一遍同步接口（幂等/并发/软删除/进展）
  check-app-sync.mjs      真浏览器走真界面 → 确认真落到线上数据库（双向）
  cloudflare-setup.mjs    一键部署 Cloudflare 同步后端（幂等，含自测）
  verify-d1-migration.mjs 在真实 SQLite 上验迁移（CI 里由 vitest 跑同一套）
```

依赖方向（严格单向）：

```
UI → Repository / Domain → IndexedDB → SyncEngine → CloudAdapter → 后端
```

React 页面不直接调用任何后端。`cloud/cloudProvider.ts` 是唯一的选路点，
`cloudConfig` 里存着当前选的是哪一个。

> 两套后端（Cloudflare / Supabase）语义完全等价，`CloudAdapter` 是唯一边界，
> 同步引擎不感知差别。`src/test/workerSchema.test.ts` 会逐列比对两边的表结构 ——
> 只改一边就会红，防止「可互换」这句话在半年后变成空话。

---

## 核心数据理念

整个 APP 只有一种核心数据：`Record`。

```
灵感 = Record(type = "idea")
待办 = Record(type = "todo")
大事 = Record(type = "project")
进展 = Record(type = "log")        ← 挂在某件大事下（parent_id）
```

四个页面只是对同一份数据的不同观察方式：

| 页面 | 语义 | 过滤条件 |
| --- | --- | --- |
| 首页 | 我什么时候记下了什么（时间线） | `deleted_at = null AND type != log` |
| 灵感 | 只显示灵感 | `type = idea AND deleted_at = null` |
| 待办 | 现在还有什么没做 | `type = todo AND completed_at = null AND deleted_at = null` |
| 日历 | 我在某一天想到了什么 | 按 `created_local_date` 归档，同样排除 `log` |

导航顺序：首页 / 灵感 / 待办 / 日历。

**大事不是第五个一级页面**，而是首页输入框与时间线之间的一个独立模块
（「目前在做的大事」），理由是它和时间线回答的是两个相反的问题：

- 时间线 = 我什么时候记下了什么（向后看，按日期归档）
- 大事模块 = 我现在该先干哪个（向前看，按截止日升序）

所以它单独排、单独建，且只列**未完成**的大事（进度 < 100%）。
推到 100% 的会从这个模块消失，但**不会丢** —— 它仍然在下面的时间线里，
也在日历里，想再看到点开详情或者翻时间线即可。

待办页底部另有一块默认折叠的「已完成」区，按 `completed_at` 倒序。
它不是归档（归档归首页时间线管），而是一块**后悔药** ——
打勾这个动作太轻，手滑一下那条就从列表里没了，所以任何时候都能从那里撤销。

**时间贯穿整个 APP**：首页 / 灵感 / 待办显示 `HH:mm` 与日期分组，
详情显示 `YYYY年MM月DD日 HH:mm`，日历通过 `created_local_date` 查询。

### 大事（project）

| 字段 | 含义 |
| --- | --- |
| `progress` | 0–100 的整数，**只有大事和进展有**，大事默认 0 |
| `deadline_local_date` | 截止日，纯日期 `YYYY-MM-DD`，可为空（只有大事有） |

三个刻意的设计决定：

1. **进度落库的时机是「动作结束」，不是「值变化」**。
   拖一次滑块会产生几十个 `change` 事件，跟着写库就是几十个 mutation
   打进 outbox、几十次 IndexedDB 事务，而首页那个模块是 liveQuery 驱动的，
   会跟着重渲染几十次。所以拖动只改界面，松手（`pointerup`）或松开按键
   （`keyup`）才落库一次。
2. **截止日存纯日期，不存时刻**。用户想的是「几号之前」，不是「几点之前」。
   纯日期不带时区，换设备不会从 10 月 5 日漂成 10 月 4 日。
3. **两端都改进度时不做「取较大值」**。那看起来聪明，实际会把
   「本机刚把进度退回 0 重新做」直接抹掉。语义不明的合并宁可交给用户裁决。

进度与截止日的收敛（`clampProgress` / `clampDeadlineLocalDate`）放在**边界**上，
两套后端适配器、worker 出口、仓库层都会过一遍 —— 免得界面出现 `width: NaN%`
或者一个不存在的「13月45日」。

### 进展（log）

进度条只回答「多少」，回答不了「具体卡在哪」。所以大事详情里还有一块
**进展记录**：一条进展就是 `Record(type = 'log')`，`parent_id` 指向所属大事。

| 字段 | 含义 |
| --- | --- |
| `parent_id` | 所属大事的 id，**只有 log 有**；非 log 带它是数据库直接拒绝的 |
| `progress` | 写下这条时的进度**快照**，可以为空（「没记」和「记了 0%」是两回事） |

已定的几条：

- 写入口只在**大事详情面板**里（进度区下方），不是第五个一级页面
- **最新在最上** —— 打开详情第一眼要看到「现在到哪了」
- 每条渲染成 `<百分数> <内容>`，配「今天 21:30」这种相对时刻。
  百分数用 `text-project`（靛紫）—— 它标的是**大事**的进度，不是这条记录自己的属性；
  两者靠间距分开，不加 `·` 之类的分隔符
- 写这条时**没记进度就整个不渲染百分数**，不补一个 `0%`：
  「没记」和「记了 0%」是两回事（所以 `progress` 允许为 `null`）
- 能改能删，删除有常驻撤销（和打勾、删除同一条规矩）
- 大事模块那一行显示「N 条进展」，**没写过就不显示**（不写 `0 条进展`）
- **不进首页时间线 / 日历 / 搜索**：一屏里塞满「改了个 bug」会把真正的时间线淹掉；
  而搜到一条「限位搞定了」却看不到它属于哪件大事，是个没有上下文的碎片
- 父级被软删时进展**不连坐**（各自的 `deleted_at_utc` 独立），
  撤销「删除大事」之后写过的进展要原样回来
- `parent_id` 是**不可变**的：进展属于哪件大事是写下来那刻定死的，
  D1 触发器与 Supabase 的 RPC 都不接受更新它

**为什么不新开一张表**：整个 APP 只有一种核心数据。新开表意味着 outbox、
推送、拉取、三方合并、软删除、撤销整套都要再抄一遍 —— 五份代码、
五个新的丢数据点。代价只是 `idea` / `todo` 上多几个恒为 null 的字段，
以及过滤器要显式排除 `log`（好在都集中在 `src/domain/record.ts` 一处）。

不做：提醒、子任务、看板、给进展打勾。

### 时间字段互不混用

| 字段 | 含义 | 会不会被改写 |
| --- | --- | --- |
| `created_at_utc` / `created_timezone` / `created_local_date` | 第一次写下的那一刻 | **永不改变** |
| `updated_at_utc` / `updated_timezone` | 最后一次编辑（改进度、改截止日也算） | 只在编辑时更新 |
| `completed_at_utc` / `completed_timezone` | 完成时间 | 打勾时写入 |
| `deleted_at_utc` | 软删除时间 | 删除时写入 |
| `deadline_local_date` | 大事的截止日（用户自己设的） | 用户改时更新 |
| `server_updated_at` | 服务器同步时间 | 只用于同步，绝不覆盖用户记录时间 |

即使离线 4 小时才同步，创建时间仍然是用户当时写下的那一刻。

---

## 同步设计

### 顺序：Pull → Reconcile → Push → Pull

绝不使用简单的 `Push → Pull`，也绝不使用 Last Write Wins。

1. **Pull**：拉取该用户全部 Record（含软删除 Tombstone）
2. **Reconcile**：对齐服务器与本机状态
   - 本机没有未同步修改 → 采用服务器
   - 本机有修改、服务器没动 → 保留本机，准备 Push
   - 两边都动了 → 三方比较（`Base` / `Local` / `Remote`）
3. **Push**：把本机改动送上去
4. **再 Pull**：应用服务器返回结果并补齐遗漏

### 可靠性机制

- **Version + 乐观并发**：每条 Record 带 `version`，每次成功变化 +1
- **原子检查**：数据库端 `apply_record_mutation` RPC 在同一个事务里完成
  「检查 version → 应用 mutation → version + 1 → 记录 applied_mutations」
- **幂等**：每个 Mutation 带 `mutationId`，服务端 `applied_mutations` 保证
  重试不会重复执行（响应包丢失后重试是安全的）
- **同 Record 串行**：同一条记录一次只发送一个 Mutation；不同 Record 可并行
- **离线压缩**：离线连续修改 5 次只发 1 个 Update，`baseServerVersion` /
  `baseSnapshot` 仍保留最初那一份
- **Realtime 只是加速器**：漏事件不影响最终一致性，Pull 一定能补回来
- **软删除永久保留**：V1 不做 Tombstone GC，最可靠地防止「离线设备复活已删除记录」

### 同步失败与重试

HTTP 请求成功不等于记录已经安全写入。云端回执的状态未知、账号或记录身份不符、
版本非法、或者缺少正文与时间等核心字段时，客户端会拒绝确认。
推送队列中的原 `mutationId` 和完整内容保留为 `failed`，重试仍使用原 ID，
不会为了消除错误提示删掉本机草稿。拉取列表也要完整校验；任何一行或一页异常，
本次拉取都不会交给对账，因此前面收到的部分结果不会覆盖本机记录。

看到「暂时无法同步，内容已经保存在本机」时，可以继续在本机记录。
程序会按退避策略自动重试；确认网络和后端恢复后，也可以在**设置 → 同步状态**点击
**立即同步**。错误持续时保留当前浏览器数据，先检查后端是否返回了完整协议。

### 冲突处理

只有**真正冲突**时才打扰用户：

| 场景 | 处理 |
| --- | --- |
| 一边改正文、一边完成 Todo | 自动安全合并，不打扰用户 |
| 两边都改同一字段且内容不同 | 弹出冲突，展示本机版本 / 另一设备版本 |
| 一边删除、一边编辑 | 破坏性冲突，提示「保留删除」/「恢复并保留本机内容」 |

用户完成选择以前，`Base` / `Local` / `Remote` 三个版本一个都不会丢。

---

## 跨设备同步（可选）

「本地优先」的意思是：**没有云也完全能用**，数据就在你自己设备上。
想让手机和电脑看到同一份记录，才需要后端。两个方案，二选一即可。

> ⚠️ **人在国内的话，直接选方案 B（Supabase）。**
> 方案 A 跑在 `*.workers.dev` 域名上，这个后缀在国内**被 DNS 污染**：
> 解析出来的是一个与 Cloudflare 毫无关系的假地址，应用只会报「连不上这个地址」。
> 实测阿里、腾讯、Google、Cloudflare 四个 DNS 服务器返回**同一个假答案** ——
> 换 DNS 服务器解决不了。后端本身是好的，是域名根本到不了。
> （除非自己买个域名绑到 Worker 上，那算方案 A 的进阶版。）

| | Cloudflare（方案 A） | Supabase（方案 B） |
| --- | --- | --- |
| 你要做什么 | 注册 + 跑一条命令 | 注册 + 建项目 + 贴一段 SQL |
| 登录方式 | 访问令牌（脚本生成） | 邮箱验证码 |
| 免费额度 | 10 万请求/天 + 5GB | 500MB 数据库 |
| **国内可达** | ❌ `*.workers.dev` 被污染，需自备域名 | ✅ 实测可通 |
| 已知的坑 | 要自己跑命令 | ① 项目连续 7 天没有 API 请求会被自动暂停，需要手动恢复 ② 内置邮件服务**每小时只能发 2 封** |
| 适合 | 有自己域名的用户 | **国内用户首选** |

> 无论选哪个，**你手机和电脑上现有的记录都不会丢**。
> 同步引擎的设计是「宁可多存一份也绝不静默覆盖」，
> 第一次同步会把你本机已有的记录一起传上去。

---

### 方案 A：Cloudflare（自建后端，一键部署）

后端代码就在本仓库的 `worker/` 里，部署脚本会把它推到你自己的 Cloudflare 账号下。
免费额度对个人使用远远够，而且没有「闲置就被暂停」的问题。

**你只需要做两件事**：注册一个 Cloudflare 账号（免费、不用绑卡），
然后执行一条命令。

```bash
cd worker && npx wrangler login    # 浏览器里点一下「同意」，一次性
cd .. && npm run cloudflare:setup
```

脚本会依次：

1. 确认已登录
2. 建好（或复用）名为 `yike-sync` 的 D1 数据库
3. 把 `database_id` 回填进 `worker/wrangler.toml`
4. 应用 `worker/schema.sql` 建表
5. 确认账号有 `workers.dev` 子域名（没有就自动注册一个）
6. 部署 Worker
7. 生成一个访问令牌写进数据库（库里只存 SHA-256）
8. **现场请求一次 `/api/health` 和 `/api/me` 自测** —— 通了才说通了

最后打印两样东西：

```
Worker 地址：https://yike-sync.你的子域.workers.dev
访问令牌　：一长串随机字符
```

把它们填进应用「**设置 → 云端同步 → Cloudflare（自建）**」，保存后点「登录」。
手机和电脑填**同一份**地址和令牌。

脚本可以反复执行，不会弄坏已有的东西；先看它打算做什么就加 `--dry-run`：

```bash
npm run cloudflare:setup -- --dry-run      # 只打印，不动手
npm run cloudflare:setup -- --token-only   # 库已建好，只补发一个新令牌
npm run cloudflare:setup -- --subdomain=名字  # 指定 workers.dev 子域名
```

> `--token-only` 也会自测：地址是可以推出来的（`<worker 名>.<子域名>.workers.dev`），
> 所以补发令牌后照样会真的打一次接口，而不是让你填完才发现不通。

> ⚠️ **访问令牌只在屏幕上出现那一次。** 数据库里存的是它的 SHA-256，
> 事后无法从库里取回明文 —— 请当场复制走。
> 丢了不要紧，重跑一次 `--token-only` 就会发一个新的（旧的仍然有效）。

#### 已经部署过？升级到「大事 / 进展」要跑迁移

`worker/schema.sql` 里的 `create table if not exists` 对**已存在的表整段跳过**，
所以光重新部署 Worker 不会给老库加上新列 —— 老库必须单独跑一次迁移。

| 迁移 | 带来什么 | 为什么必须重建 records 表 |
| --- | --- | --- |
| `0002_project_type.sql` | 大事：`progress`、`deadline_local_date` | SQLite 改不了 CHECK 约束，只能重建 |
| `0003_log_type.sql` | 进展：`parent_id`，类型放宽到四种 | 同上（原来那条大 CHECK 要拆成三条） |

```bash
# 1) 先备份（强烈建议，这一步是后悔药）
npx wrangler d1 export yike-sync --remote --output backup-$(date +%F).sql

# 2) 再迁移（没跑过 0002 的从 0002 开始，按顺序来）
npx wrangler d1 execute yike-sync --remote --file=worker/migrations/0002_project_type.sql
npx wrangler d1 execute yike-sync --remote --file=worker/migrations/0003_log_type.sql

# 3) 最后重新部署 Worker —— 后端代码也要认识新列
cd worker && npx wrangler deploy
```

> ⚠️ **三步都要做。** 只做第 2 步的话，老 Worker 收到带 `progress` 的请求
> 会**当作没看见**（payload 里多出来的字段被忽略），于是进度不会报错，
> 但也**同步不过去** —— 本机看着 50%，另一台设备拉下来是 0%。
> 这种「不报错的失效」比报错难查得多。

> ⚠️ **写新迁移时最容易犯的错：照抄上一份的「搬数据」那一段。**
> 0002 搬数据时 `progress` 是刚加的新列，只能写 `select null`；
> 到了 0003，线上已经有大事带着**真实进度**了 —— 照抄 `null` 会把用户
> 攒下的进度**全部清零，而且一句报错都没有**。
> 正确的做法是逐列原样搬过去，只有真正的新列才补 `null`。
> 这一步已由 `src/test/d1Migration.test.ts` 钉住（它会塞一件带进度的大事进去，
> 迁完必须还在）。

怎么确认迁移真的成功了（对着线上库跑一句）：

```bash
npx wrangler d1 execute yike-sync --remote --json --command \
  "select (select count(*) from records) as records,
          (select count(*) from sqlite_master where type='trigger') as triggers,
          (select count(*) from sqlite_master where type='index' and tbl_name='records') as indexes,
          (select count(*) from pragma_table_info('records')
            where name in ('progress','deadline_local_date','parent_id')) as new_cols"
```

期望：`triggers = 4`、`indexes = 5`、`new_cols = 3`，`records` 与迁移前一致。

> 这条命令**不要**写成 `select ... union all select ...` 拼很多行 ——
> D1 对 compound SELECT 的项数有限制，拼多了会报 `too many terms in compound SELECT`。

重建的顺序是：drop 触发器 → rename 留底 → 建新表 → 搬数据 → drop 旧表
→ 重建索引 → 重建触发器。里面任何一步写漏都**不会报错**：

- 索引忘了重建 → 查询悄悄退化成全表扫描，功能看着一切正常
- 触发器忘了重建 → 「创建时间不可变」「只能软删除」这些红线**直接消失**
- 列顺序写错 → 数据静默串列（`content` 里装着时间戳）
- 索引重建**早于** `drop table records_legacy` → `create index if not exists`
  因重名被静默跳过，于是索引干脆不存在

所以迁移有一份**专门的测试**（`src/test/d1Migration.test.ts`），
在真实 SQLite 上从 0001 一路跑到 0003，然后逐项验：
数据一条不少、索引与四个触发器一个不少、红线依然有效、新能力可用，
最后还要求**迁移结果与全新安装逐列、逐触发器完全一致**。

> 迁移测试的输入是 `worker/migrations/__fixtures__/schema-000N.sql` ——
> 各次迁移**之前**那份 schema 的冻结副本。它是历史事实，
> **永远不要跟着 `worker/schema.sql` 一起改**，否则这个测试会彻底失去意义
> （拿新表结构去测新表结构，永远是绿的）。

#### 产品红线是数据库约束，不是文档里的约定

`worker/schema.sql` 里有四个触发器，把「不能丢数据」这件事变成了数据库拒绝执行：

| 红线 | 数据库怎么拦 |
| --- | --- |
| 删除只能是软删除 | `before delete` 直接 `raise(abort)` —— 物理删除永远失败 |
| 创建时间永不改变 | `before update` 逐列比较 `new` 与 `old`，改了就中止 |
| `version` 单调递增 | 任何不让 `version` 变大的 UPDATE 一律中止 |
| 幂等结果不可改写 | 已落定的 `applied_mutations` 行不许再 update |

为什么不只写在文档里：**文档靠人记，触发器不靠。**
将来任何人（包括我）写错一条 SQL，数据库会直接拒绝，而不是悄悄破坏承诺。

#### 写入的原子性靠 `changes()`，不靠「先查再写」

记录写入与幂等记录写在同一个 batch（同一事务）里，而幂等记录**只在
「这一条 INSERT 真的改动了行」时才写**（`where changes() = 1`）。

不用 `where exists (select 1 from records ...)` 那种间接判断：设想两台设备
同时新建同一条记录（同一个 id、两个 mutationId），先到的那条写进去了，
后到的那条被 `on conflict do nothing` 悄悄跳过 —— 但 `exists` 依然为真，
于是后到的那条也会被记成「已应用」，它带的更新内容被丢掉。
客户端以为推送成功，之后 Pull 回来覆盖本地。**这就是静默丢数据。**

这个缺陷是写测试时实测出来的，`src/test/workerCore.test.ts` 里有一组
「读完之后、写下去之前别人插了一脚」的用例专门钉住它 —— 用真实 SQLite 跑。

> 顺带一个实测发现：**D1 返回的 `meta.changes` 对 UPDATE 会报 0**（即使确实改到了行）。
> 所以判据只能取 SQL 里的 `changes()` 函数 —— 那是引擎自己算的，
> 不是 D1 包在外面的统计。`core.ts` 用的是后者，不受影响。

#### 部署出去之后，再对着真后端验一遍

单测跑在 Node 的 SQLite 上，证明不了「部署出去的那一份」也对。
所以还有一个打真接口的校验脚本（同样只在真环境里才有意义，
和 `check-installable.mjs` 一个路子）：

```bash
npm run check:sync -- --url=https://yike-sync.你的子域.workers.dev --token=你的令牌
# 或者走环境变量 YIKE_SYNC_URL / YIKE_SYNC_TOKEN
```

28 项，覆盖本地测不出来的那几件事：鉴权与路由、幂等重推、
**并发新建同一条记录时不能有一方以为成功**、版本冲突不覆盖、软删除后
Tombstone 仍能被 Pull 到、`createdAtUtc` 全程不变，以及
**第四种类型 `log` 与不可变字段 `parentId`**（进展「属于哪件大事」写下来那刻定死，
update 时 payload 里换一个也不生效）。

其中「并发竞态」那三项就是 `changes()` 判据的回归测试 ——
**如果它失败，说明线上后端会静默丢数据，必须立刻回滚部署。**

它会在你的账号下建几条测试记录（id 以 `smoke-` 开头），跑完就地软删除。
按红线不做物理删除，所以这些记录会以 Tombstone 形式留在库里，界面上看不见。

#### 最后一道：真浏览器走真界面

上面那个脚本是**照着后端代码**写的请求，它证明不了「应用真正发出去的请求」
和「后端接受的请求」是同一套 —— 两边字段名差一个字母，接口测试照样全绿，
用户却同步不了。所以还有一层，用真浏览器点真界面：

```bash
npm run preview                                    # 另开一个终端
npm run check:app-sync -- \
  --app=http://127.0.0.1:4173 \
  --url=https://yike-sync.你的子域.workers.dev --token=你的令牌
```

12 项，覆盖：本机模式先记一条 → 在设置里选 Cloudflare、填地址与令牌、保存 →
**待同步归零** → 去线上数据库查这条在不在（类型 / 创建时间 / 版本都对）→
**清空本机 IndexedDB 后还能从云端拉回来**（只推上去不算同步，双向都通才算）。

实测 12/12 通过。它同样会把测试记录就地软删除，界面不会给你留多余的东西。

#### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，不需要令牌 |
| `GET` | `/api/me` | 令牌对应的账号 |
| `POST` | `/api/sync/pull` | 拉取全部 Record（含软删除 Tombstone） |
| `GET` | `/api/sync/record?id=` | 拉取单条 |
| `POST` | `/api/sync/mutate` | 原子应用一次 Mutation |

鉴权：`Authorization: Bearer <访问令牌>`。
出错时**绝不返回看起来成功的响应** —— 客户端会把失败当成已应用，
那才是真正的丢数据。所以一律 500，让 outbox 保留 mutation 稍后重试。

---

### 方案 B：Supabase（用现成的托管服务）

> ⚠️ **国内可达性实测提醒（2026-10）**：`supabase.com`（**官网**，托管在 Vercel）
> 能打开，但**项目 API 走的是另一套 IP（AWS）**，实测在国内被 TLS 层掐断
> （`ERR_CONNECTION_CLOSED`，手机和电脑都是）。这是 2021 年就报过的长期问题
> （supabase/supabase-js#2631）。
>
> 所以：**「官网能开」不等于「项目 API 可用」**，这两件事必须分开测。
> 国内用户请优先用方案 A（Cloudflare）；如果只有 Supabase 能连，也请先
> 用真设备试一次 `POST /rest/v1/` 再往下做。
>
> 同理，`*.workers.dev` / `*.vercel.app` / `*.fly.dev` 这些「免费托管平台
> 自带的后缀域名」在国内基本都被针对。最稳的做法是**买一个自己的域名**
> 绑到后端上 —— 代码和数据一行都不用改。

#### 1. 建组织，再建项目

在 [supabase.com](https://supabase.com) 注册。注册完会停在「你的组织」页面 ——
**Supabase 必须先有组织才能建项目**，第一次用容易卡在这一步：

1. 点「**新组织**」（New organization）
2. Name 随便填；Type 选 **Personal**；Plan 选 **Free**
3. 创建完回到 Dashboard，才会出现「**New project**」

建项目时：Name 随便填，Database Password 设一个并**记下来**，
Region 选 **Southeast Asia (Singapore)** 或 **Northeast Asia (Tokyo)**（离国内近）。
等 1～2 分钟初始化完成。

> ⚠️ 建项目表单里的两个开关**保持默认勾选**：「**启用数据 API**」和「**自动暴露新表**」。
> 后者界面上写着「我们建议关闭」，但**本仓库的 SQL 脚本没有手写 `GRANT`**，
> 靠它给新表授权 —— 关掉的话应用会报 `permission denied for table records`，
> 而且很难往这上面想。「启用自动 RLS」勾不勾都行（脚本里已经自己开了）。

#### 2. 建表

在 Supabase 项目的 SQL Editor 中执行：

```
supabase/migrations/0001_init.sql
```

脚本会创建 `records` / `applied_mutations` 两张表、四个索引、
`apply_record_mutation` RPC，并开启 RLS：

- 用户只能 `SELECT` / `INSERT` / `UPDATE` 自己的数据（`user_id = auth.uid()`）
- **故意不创建 DELETE 策略** → 物理删除在数据库层面被彻底禁止

> **如果你的库是「大事」之前建的**，再执行一次
> `supabase/migrations/0002_project_type.sql`。
> Postgres 加列不需要重建表（`add column if not exists`），
> 但**必须重定义 `apply_record_mutation`** —— 老版本不知道
> `progress` / `deadline_local_date` 两个字段，会把它们当未知字段丢掉。
> 这个脚本是幂等的，跑第二遍什么都不会发生。

> Supabase 会弹一个「**检测到潜在问题 / 破坏性操作**」的确认框 —— **点「运行查询」**。
> 脚本里有几条 `drop ... if exists`（先删后建，为了让脚本可以重复运行），
> 检测器看到 `drop` 就一律提醒。全新项目里那些对象本来就不存在，
> `if exists` 会直接跳过，**什么都不会删**；脚本也只碰它自己创建的东西，
> 不涉及 Supabase 的系统表。

#### 3. 配好登录跳转地址（⚠️ 漏了就登录不了）

Authentication → **URL Configuration**：

- **Site URL**：应用的完整地址，例如 `https://lhc728.github.io/yike/`
- **Redirect URLs**：把同一个地址加进去

⚠️ **一定要带上子路径**。本站部署在 GitHub Pages 的 `/yike/` 下，
只填 `https://lhc728.github.io` 会让邮件里的链接落到站点根目录、直接 404。

#### 4. 接一个自己的发信邮箱（**必须**）

⚠️ Supabase 自带的邮件服务**不允许编辑模板** —— 页面上会提示
「Set up custom SMTP to edit templates」。而它的默认模板里
**只有一个登录链接、没有验证码**，本应用的登录框却是让人填 6 位数字的。

而且「点邮件里的链接」这条路对**装到主屏的 PWA 也走不通**：
链接会被系统浏览器打开，登录状态记在浏览器里；PWA 是**独立的存储空间**，
那边依然是未登录状态。

所以在 **Authentication → Emails → SMTP Settings** 里接一个自己的 SMTP：

| 字段 | 用 QQ 邮箱 | 用 Resend |
| --- | --- | --- |
| Host | `smtp.qq.com` | `smtp.resend.com` |
| Port | `465` | `465` |
| Username | 你的 QQ 邮箱地址 | `resend` |
| Password | QQ 邮箱的**授权码**（不是登录密码） | Resend 的 API Key |
| Sender email | 你的 QQ 邮箱地址 | `onboarding@resend.dev` |
| Sender name | 一刻 | 一刻 |

> **QQ 邮箱的授权码**：登录 `mail.qq.com` → 设置 → 账户 →
> 开启「IMAP/SMTP 服务」→ 按提示生成一串授权码，拿它当密码。
> 163 邮箱同理（Host 用 `smtp.163.com`）。
>
> 用 Resend 的话注意：`onboarding@resend.dev` **只能发到 Resend 账号自己的邮箱**，
> 自己用是够的。好处是额度从「每小时 2 封」提到「每天 100 封」。

配好 SMTP 后模板就能编辑了，接着做下一步。

#### 5. 让邮件里带上验证码

Authentication → **Emails** → 点 **Magic link or OTP**，把 Body 整个换成：

```html
<h2>登录一刻</h2>
<p>你的验证码是：<strong>{{ .Token }}</strong></p>
<p>也可以直接点链接登录：<a href="{{ .ConfirmationURL }}">打开一刻</a></p>
```

**Confirm signup** 也照样改一遍（新账号第一次登录走的是这个模板）。

#### 6. 配置连接

方式一：构建期环境变量

```bash
cp .env.example .env
# 填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run build
```

方式二：运行期在 APP 内填写

打开右上角「设置 → 云端连接」，后端选 **Supabase**，
粘贴 **Project URL** 与 **API key**（都在 Project Settings → API 里），
保存后页面会自动重载。

> **用哪个 key**：Supabase 正在把 `anon` key 换成新的 `sb_publishable_...`
> 格式（旧的 2026 年底前弃用），两个都能用 ——
> 页面上看到 **Publishable key** 就复制它；看到 legacy 的
> **anon public**（`eyJ` 开头）也可以。
> ⚠️ **绝对不要**复制 **secret key / service_role** —— 它绕过 RLS，
> 拿到就能读改删所有人的数据，只能留在服务端。

#### 7. 登录

重载后会跳到登录页：填邮箱 → 收验证码 → 登录。
从本机模式首次登录时，**本机已有记录会自动归入该账号**，不会丢失。

> **免费项目连续 7 天没有任何数据库活动会被自动暂停**，去 dashboard 点一下
> 「Restore」即可恢复。日常在用不会触发；万一被暂停，**数据也不会丢**。

---

## 测试

```bash
npm run verify         # 类型检查 + Lint + 307 项单元 / 集成测试
npm run test           # 只跑 Vitest
npm run test:e2e       # Playwright：40 项 E2E（桌面 20 + 手机 20）
npm run check:contrast # 配色对比度（WCAG AA，浅色 + 深色）
```

`check:contrast` 从 `src/index.css` 解析**真实令牌**逐对计算对比度，
不另抄一份颜色值 —— 它量的是浏览器实际会用到的颜色。已进 CI 门禁。

> 为什么值得单独有这条：上一版文档里 `idea` 写着 4.6:1，实测只有 **3.11:1**
> （白字压在赭石主按钮上更是只有 3.28:1），两轮改版都没发现 ——
> 十六进制字符串看不出对比度。

E2E 跑的是构建产物，所以要先构建：

```bash
npm run build
npm run test:e2e
```

如果 E2E 在收尾阶段卡住不动（Playwright 自行关闭 preview 服务时可能发生），
先在另一个终端常驻服务，再跑测试 —— 配置里 `reuseExistingServer: true`
会直接复用它，不再需要关闭：

```bash
npm run preview    # 终端 A，保持运行
npm run test:e2e   # 终端 B
```

### Vitest 覆盖（方案 §77）

| 编号 | 场景 |
| --- | --- |
| Test 1 | 离线创建，刷新后仍存在 |
| Test 2 | 离线 Todo 创建 + 完成，刷新后状态正确 |
| Test 3 | 离线补同步，另一台设备能看到 |
| Test 4 | 响应丢失后重试，服务端只发生一次逻辑修改 |
| Test 5 | Realtime：A 创建，B 不刷新自动看到 |
| Test 6 | 漏掉 Realtime，Pull 也能补回来 |
| Test 7 | 同时修改同一字段 → 必须进入冲突 |
| Test 8 | 修改不同字段 → 自动安全合并 |
| Test 9 | 删除防复活 |
| Test 10 | 删除与编辑冲突 |
| Test 11 | 创建时间不可改变 |
| Test 12 | 完成不改变归档日 |
| Test 13 | 编辑后重新打开 |
| Test 14 | 账号隔离 |

多设备通过 `FakeCloudServer`（内存版，行为与 `0001_init.sql` 完全一致）
+ 切换独立 IndexedDB 顺序模拟。

大事（`project`）另有三组用例，钉的是它特有的那几条：
`local.test.ts` 的「只有大事才带进度与截止日 / 越界收敛 / `byDeadlineAsc` 排序」、
`merge.test.ts` 的「两端都改进度 → 冲突且退回 base，**不做取较大值**」、
`time.test.ts` 的「倒计时按日历天算，跨月跨年闰年都对，畸形输入不许产出 NaN 天」。

进展（`log`）同样单独钉了一组：`local.test.ts` 的「离线也能写进展 / 进展不算时间线 /
`parentId` 空白串归一为 null / 非 log 类型带 parentId 被丢弃」、
`merge.test.ts` 的「`parentId` 跟随 base、不进 `MergeField`（不给用户一个无从判断的选项）」、
`workerCore.test.ts` 的「`parent_id` 更新路径改不动 / 非 log 带 parentId 落库为 null」、
`time.test.ts` 的 `formatRelativeStamp`（今天 / 昨天 / 前天 / 更早的月日）。

### 同步后端（Cloudflare）的测试

| 文件 | 测什么 | 数量 |
| --- | --- | --- |
| `workerCore.test.ts` | 鉴权 / 幂等 / 版本冲突 / 创建时间不可变 / 跨账号隔离 / 竞态 / 大事字段 / **进展与 `parent_id` 不可变** | 54 |
| `workerHttp.test.ts` | 401 / 400 / 404 / CORS / 跨域 / **出错绝不返回成功** | 38 |
| `workerSchema.test.ts` | 触发器是否真在拦、两套后端表结构是否逐列一致 | 18 |
| `d1Migration.test.ts` | **0001 → 0002 → 0003 全链迁移**：数据不丢不串、大事的进度不被清零、索引与四个触发器一个不少、红线仍有效、迁移结果 == 全新安装 | 23 |
| `cloudflareAdapter.test.ts` | 字段归一、状态透传、**失败不装成功** | 37 |

**这些测试跑在真实 SQLite 上**（Node 22 内置的 `node:sqlite`，见
`src/test/sqliteD1.ts`），并且会加载 `worker/schema.sql` 的触发器。

这一点是刻意的：产品的四条红线在 Cloudflare 这一侧**全部是 SQL 触发器实现的**。
如果用一个手写的假 D1，那些触发器在测试里根本不会运行 ——
测了半天，恰好把最该守的底线漏掉。用真实 SQLite 还附带一个好处：
SQLite 就是 D1 的引擎，所以 `on conflict do nothing`、`insert ... select ... where exists`、
`raise(abort, ...)` 的行为和线上是同一套语义。

已知差异（如实记录）：本替身是单连接，D1 是多副本的分布式 SQLite，
所以这里测不到「跨副本最终一致」那类问题，只测单次请求内的原子性。

> `node:sqlite` 在 Node 22.13+ 默认可用，更早的版本要加 `--experimental-sqlite`。
> 它是 Node 的**实验性** API，选择它而不是 `better-sqlite3` / `sql.js`，
> 是为了不引入新依赖、也不用编译原生模块。真出问题时表现是明确的报错，
> 不会静默放过 —— 这个取舍是清楚的。

### 主题与配色

| 文件 / 脚本 | 测什么 | 数量 |
| --- | --- | --- |
| `theme.test.ts` | 显式选择优先于系统、脏值/抛错兜底、`setMode` 落 DOM 与存储、**`index.html` 防闪脚本与存储键不许漂移** | 16 |
| `check-contrast.mjs` | 从 `index.css` 解析真实令牌，逐对算 WCAG 对比度（浅色 22 对 + 深色 22 对） | 44 |
| `e2e` 暗色模式 | 切换后刷新仍是深色、**首屏不闪**、跟随系统（系统变了自己跟着变） | 3 × 2 端 |

主题本身只有「加/去一个类」，所以在 jsdom 里断言它等于什么都没验 ——
真正会出问题的是**刷新之后还在不在**、**首帧会不会闪白**、**系统变了跟不跟**，
这三件事只在真浏览器里跨一次真实导航才成立。

---

## 代码审查

本仓库的质量靠**机制**兜住，不靠记性：

| 层级 | 在哪里 | 内容 |
| --- | --- | --- |
| 提交前 | `.githooks/pre-commit` | `npm run verify`（tsc + oxlint + vitest） |
| 提交信息 | `.githooks/commit-msg` | Conventional Commits 格式 |
| CI | `.github/workflows/ci.yml` | 静态门禁 + 对比度 → 单元测试 → 构建 + E2E |
| 发布 | `.github/workflows/deploy-pages.yml` | 等 CI 全绿 → 子路径构建 → 校验产物路径 → 发布 |

当前基线：**tsc 0 错误 / oxlint 0 warning（222 条规则）/ 307 项单测 + 40 项 E2E 全绿**。

- 📋 **[代码审查标准与流程](docs/代码审查标准与流程.md)** —— 优先级判据、
  高风险区清单、三级门禁、测试分层策略、审查清单、例外处理
- 🔍 **[基线审计报告](docs/代码审查-基线审计报告.md)** —— 制定标准前做的实测审计，
  含两个实测出的真实缺陷及其修复过程

---

## 部署与安装

### 为什么必须先部署

「装到手机上」有个硬性前提：**浏览器只允许在 HTTPS 或 localhost 下安装 PWA**。

本机跑 `npm run preview` 是 `http://127.0.0.1:4173`，在你自己电脑上算安全上下文；
但手机连过来是 `http://192.168.x.x:4173` —— **不是安全上下文，装不了**。
所以要先把它放到一个真实网址上。功能上局域网访问是能用的，只是没有「安装」入口。

### 部署到 GitHub Pages

一次性设置：

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**
2. push 到 `main`，等 CI 绿、Deploy 绿

网址：**https://lhc728.github.io/yike/**

之后每次 push 到 `main` 都会自动重新发布，不需要手动操作。

> 部署 workflow（`.github/workflows/deploy-pages.yml`）是**等 CI 全绿之后才触发**的
> （用 `workflow_run` 监听 CI 的完成事件），所以线上永远只会是
> 「类型检查 / Lint / 单测 / 构建 / E2E 全过」的那一个提交。
> 它也会检出那次 CI 跑过的**确切提交**，而不是默认分支的最新提交。

### 荣耀手机上安装

1. 用 **Chrome** 打开 https://lhc728.github.io/yike/
2. 先随便记一条，确认能用
3. 浏览器菜单 → **添加到主屏幕** / **安装应用**
4. 主屏上出现「一刻」图标，点开是全屏窗口，看不出是网页
5. 断网试一下 —— 应该照样能记、能看

**建议用 Chrome 而不是系统自带浏览器。** 荣耀的 MagicOS 基于安卓，
PWA 支持本身没问题，但部分机型的自带浏览器会把「添加到主屏幕」藏在很深的菜单里，
或者在「设置 → 应用 → 特殊访问权限」里做限制。菜单里找不到时：

- 换 Chrome / Edge 再试一次（最有效）
- 或直接当普通网页用 —— 功能完全一样，只是没有独立图标、需要每次打开浏览器

装成 PWA 之后的数据仍然存在手机本机（IndexedDB）。
**如果换浏览器或清了浏览器数据，本机记录会丢** —— 想跨设备/防丢，去
[跨设备同步](#跨设备同步可选) 把同步打开。

### Linux 上使用

浏览器打开同一个网址即可，功能完整。

想让它像桌面软件那样用（独立窗口 + 应用菜单里有图标 + 离线可用）：

- **Chrome / Edge**：地址栏右侧会出现「安装」图标，点它；
  或菜单 → 「安装一刻」/「作为应用安装」
- **Firefox**：Linux 版 Firefox 不支持安装 PWA，只能用标签页

装完之后它就是应用菜单里的一个普通程序，独立窗口、没有地址栏。

在 Linux 上开发也完全可以（CI 就跑在 `ubuntu-latest` 上）：
`nvm use` 会读仓库里的 `.nvmrc` 装好 Node 22，然后照「快速开始」走。

### 怎么确认线上真的能装

`scripts/check-base.mjs` 只保证路径没写错，**不能保证浏览器愿意把它当应用装**。
权威判据是 CDP 的 `Page.getInstallabilityErrors`：

```bash
node scripts/check-installable.mjs https://lhc728.github.io/yike/
```

它会逐项检查：安全上下文 → manifest 可读且字段完整 → 每个图标真的取得到
→ `start_url` / `scope` 与页面在同一路径下 → Service Worker 已激活并接管页面
→ 最后用 CDP 给出权威结论。全部通过才会打印「可以被安装为 PWA」。

### 本地构建子路径的坑（Windows / Git Bash）

GitHub Pages 是子路径（`/yike/`），构建时要传 base：

```bash
VITE_BASE=/yike/ npm run build
```

但在 **Windows 的 Git Bash** 里，这条命令会被 MSYS 改写 ——
`/yike/` 被当成 Unix 路径转成 `C:/Users/.../yike/`，**构建照样成功，产物却全是坏路径**。
本地要这样跑：

```bash
MSYS_NO_PATHCONV=1 VITE_BASE=/yike/ npm run build
MSYS_NO_PATHCONV=1 npm run check:base -- /yike/
```

Linux / macOS / CI 上没有这个问题。
`vite.config.ts` 和 `check-base.mjs` 都会**拦截被改写的值并直接报错**，
不会静默产出坏产物。

### PWA 技术细节

构建产物包含 `manifest.webmanifest`、`sw.js`、图标与离线 app shell。

- Service Worker **只缓存 app shell**（HTML / CSS / JS / 图标），业务数据一律走 IndexedDB
- manifest 的 `start_url` / `scope` / 图标全部用**相对路径**，
  所以根路径与子路径部署都正确（写成 `/` 的话子路径部署会指向域名根）
- 路由用 HashRouter，刷新 / 直接打开链接不会 404
- 图标由 `npm run icons` 生成（纯 Node 手写 PNG 编码，无额外依赖）
- `uuidv4()` 有三级兜底，非安全上下文（局域网 HTTP）下也能生成 ID

---

## V1 边界

不做：标签、文件夹、多级分类、优先级、提醒、闹钟、周期任务、
子任务、看板、甘特图、Markdown、富文本、图片、附件、录音、AI、RAG、
番茄钟、习惯打卡、数据统计、社交、团队协作。

**关于「截止日期」**：待办仍然没有截止日，也不会有 —— 那是任务管理器的路子。
大事有一个 `deadline_local_date`，但它是**纯日期、只用来算倒计时**，
不是排期：没有开始时间、没有时段、没有「今天要做哪几件」的日程表。
它就是「这件事我希望几号之前弄完」，多一个字都不做。

**关于「进展」**：它**不是子任务**，区别是「已经做了」和「还要做」——
子任务是一条待勾选的待办，进展是一句已经发生过的流水账。
所以进展没有勾选框、不参与完成度计算、也不会因为「没写完」而算未完成；
它唯一的贡献就是那句「当时到了多少」的快照。

V1 不做计划时间：`scheduled_at` 留给未来，且绝不会复用 `created_at`。

判断标准：它有没有让「想到 → 写下」更快？它是不是灵感 / 待办 / 时间真正必要的一部分？

---

## 数据安全优先级

```
数据不丢 > 时间正确 > 离线正常 > 同步正确 > 冲突正确 > 基本交互 > UI 美观 > 动画
```

界面可以朴素，但绝不能丢记录、重复创建、静默覆盖、改变创建时间、
让删除记录复活，或让离线时无法写入。

---

## 回退版本

改坏了想退回之前的某个版本，用 `git` 有三种粒度。**先看清楚它们各自动了什么**，
选错会把历史搞乱。

### 已有存档点（tag）

| 标签 | 是什么 |
| --- | --- |
| `v1.0.1-baseline` | 已验证的稳定基线：单测 331 / E2E 47 通过 + 5 跳过 / 对比度 46 对 |
| `v1.0.0-pre-projects` | 「大事」功能开发之前的稳定点 |

随时可以看有哪些：`git tag -l -n1`

### 先做这件事：把当前改动存起来

回退前**务必**先确认工作区是干净的（`git status`，应为空）。
如果有没提交的改动，先 `git add -A && git commit -m "wip: 回退前的存档"` ——
否则回退会把它们**直接抹掉**，且无法找回。

### 方法 A：只把文件换回旧版（**推荐，最安全**）

```bash
git checkout v1.0.1-baseline -- .      # 把工作区文件全部换成该标签的内容
git status                             # 会看到一堆 M（已修改）
```

- ✅ **不动历史**，`git log` 里所有提交都还在，随时能 `git checkout HEAD -- .` 撤回来
- ✅ 改完确认没问题，再 `git commit` 记成一个新提交，并可正常 `push`
- ⚠️ 只影响被该标签**收录过**的文件；之后新增的文件仍留在原地（需要手动删）

撤回来（后悔了）：

```bash
git checkout HEAD -- .                 # 丢弃工作区改动，回到最新提交
```

### 方法 B：整个仓库切到某个版本（看旧版长什么样）

```bash
git checkout v1.0.1-baseline           # 进入「游离 HEAD」状态，只读浏览
```

- 用来**查看**旧版代码很好，但此时**不要直接改代码提交** —— 改动不属于任何分支，容易丢
- 想基于它开新分支再改：`git switch -c 修复分支`
- 看完切回来：`git checkout main`

### 方法 C：撤销最近几次提交（本地历史整体后退）

```bash
# 撤销最近 1 个提交，但保留改动在工作区（可以重新调整后再提交）
git reset --soft HEAD~1

# 撤销最近 1 个提交，并丢弃那次改动（危险，先确认没有价值）
git reset --hard HEAD~1
```

- ⚠️ **如果这些提交已经推到 GitHub**，`reset` 后要 `git push --force-with-lease` 才能同步 ——
  **这是个危险操作**，会改写远程历史。除非明确知道在做什么，否则优先用方法 A。
- ⚠️ 已经推上线的版本，**回退代码不等于回退数据库**。
  数据库迁移（`worker/migrations/`）**只能前进、不能回退** ——
  代码退到旧版后，旧代码可能不认识新表结构。真要连数据一起退，得先
  `wrangler d1 export` 备份、再手动处理，**属于高风险操作，先备份**。

### 关于数据（最重要）

**回退代码永远不会动你的记录。** 记录存在两个地方：
- 手机/电脑浏览器里的 **IndexedDB**（那是浏览器管的，跟 git 完全无关）
- 你自己 **Cloudflare 账号里的 D1 数据库**（不跟着 git 走）

所以哪怕代码退回半年前，**你记下的东西一条都不会少**。
唯一要注意的是上面那条：**代码版本要跟数据库结构对得上**。

---

## 许可证

[MIT](LICENSE) © 2026 LHC728

可以自由使用、修改、分发，包括用于闭源商业产品，只需保留版权声明。
