# AGENTS.md

给接手这个项目的 AI 助手看的说明书。

`README.md` 讲的是**这是什么、怎么用**；`docs/` 讲的是**设计与规范**。
这份文件只讲一件事：**哪些地方改了就出事，为什么当初要这么写。**

请先读 `README.md`，再读这份。

---

## 一、先做这几件事（否则你会改坏东西）

```bash
npm install
npm run setup     # 启用提交门禁，跑一次即可
npm run verify    # 类型 + Lint + 单测，这一步必须全绿
```

**基线：`tsc` 0 错误 / `oxlint` 0 warning（222 条规则）/ 单测 331 全过 / E2E 47 通过。**
**新增任何一条 warning 都算回归**，不要靠关规则绕过（见 `docs/代码审查标准与流程.md`）。

E2E 的姿势（Windows 上尤其要注意）：

```bash
npm run build                       # E2E 跑的是 dist/，必须先构建
npm run preview                     # 另开一个终端常驻，不要关
npm run test:e2e                    # 复用上面那个 preview
```

⚠️ **不要把 `build` 和 `test:e2e` 串在同一条命令里** —— Windows 沙箱的删除保护
会按单次调用累计，两个大动作挤在一起会触发 `SAFE_DELETE_BULK_GUARD_ERROR`。

---

## 二、改之前必须知道的 6 条硬约束

这几条都是**改错了不报错、只是静静出事**的类型，踩过坑，都有血债。

### 1. 存储键不许改

这些是**浏览器里的存储标识**，不是显示名。改名会让用户数据「凭空消失」：

| 位置 | 键 | 改了的后果 |
| --- | --- | --- |
| `src/db/db.ts` | `DB_NAME` | 记录全部看不见 |
| `src/cloud/cloudConfig.ts` | `STORAGE_KEY` | 云端配置丢失 |
| `src/cloud/cloudflareSession.ts` | `SESSION_KEY` | 登录会话丢失 |
| `src/cloud/supabaseClient.ts` | `storageKey` | 被踢下线 |
| `worker/schema.sql` + 线上 | 库名 `yike-sync` | 数据对不上 |
| `src/app/themeStore.ts` | `inspiration-todo/theme` | 主题防闪脚本漂移 |

### 2. 整个 APP 只有一种核心数据

`灵感 / 待办 / 大事 / 进展` 全都是 `Record`，只是 `type` 不同。

**`进展（log）` 不是第五个页面**，它挂在某件大事下（`parent_id`），
**永远不出现在首页时间线 / 日历 / 搜索**。

⚠️ **不要给进展新开一张表。** 新表意味着要重抄整套
outbox / 推送 / 拉取 / 三方合并 / 软删 / 撤销 —— 那是 5 个新的丢数据点。
代价只是过滤器要显式排除 `log`（集中在 `src/domain/record.ts` 的
`isOnTimeline` / `matchesQuery`）。

**「整个 APP 只有一种核心数据」比「表结构好看」重要得多。**

### 3. `parentId` 不可变

`parent_id` 一旦写下就不许改，四道防线同时钉着它：

- 数据库触发器 `records_created_fields_immutable`
- worker 的 update 路径**根本不 `SET parent_id`**
- `ConflictService` 里它跟随 base 且**不进 `MergeField`**
- `clampParentId` / `asParentId` **必须把空串归一成 `null`**

⚠️ 最后这条特别阴：空串既 `!== null`、又匹配不到任何大事 id，
界面上的表现是那条记录**凭空消失**。

### 4. 同步禁止「后写覆盖先写」

冲突时**宁可多存一条，也不静默覆盖**。两条具体红线：

- **进度冲突不许做「取较大值」** —— 那会把「本机刚退回 0 重做」直接抹掉。
  语义不明就交给用户裁决（`ConflictDialog`）。
- **写入的原子性靠 `changes()`**，不靠「先查 version 再写」。
  后者在并发时会让后到的写入被记成「已应用」但内容被丢 —— 静默丢数据。
  正解是写入与幂等记录**同在一个 batch** 里，
  幂等记录用 `insert … select … where changes() = 1`。
  ⚠️ 另外：**D1 的 `meta.changes` 对 UPDATE 报 0，不可信。**

### 5. `created_at` 永不改，`server_updated_at` 只用于同步

- `created_at` 是「我什么时候记下它」，改了就是篡改事实。
- 显示用的是 `created_at`，同步用的是 `server_updated_at`，**两者不要混**。
- 时间字段按用途分开：`created_*` / `updated_*` / `completed_*` / `deleted_*`，
  各有各的时区字段，**不要图省事共用一个**。

### 6. 数据库约束才是红线，文档里的约定不是

`worker/schema.sql` 里有 4 个触发器：
`records_no_hard_delete`、`records_created_fields_immutable`、
`records_version_must_increase`、`applied_mutations_no_rewrite`。

⚠️ **改 `schema.sql` 与改 Supabase 迁移同级对待** —— 触发器写错**不报错，只会静静失效**。

⚠️⚠️ **给老库加列/改约束必须走 `worker/migrations/`**：
`schema.sql` 是 `create table if not exists`，**表已存在就整段跳过**，
改它对线上老库**完全无效** —— 看着像改好了，其实毫无变化。这是本项目最阴的一处。

⚠️ **迁移里「搬数据」绝不能照抄上一份**。线上已有的真实数据必须逐列原样搬，
只有真正的新列才补 `null`。曾经差点照着上一份写 `select null`，
那会把用户攒的进度**全部清零，且一句报错都没有**。

---

## 三、界面上的红线

### 四个一级入口，顺序固定

首页 / 灵感 / 待办 / 日历。**不增第五个。**

- **「大事」不是页面**，是首页输入框与时间线之间的一个模块。
- **「进展」不是页面**，只在**大事详情面板**里写。
- 首页 = 时间线（「我什么时候记下了什么」），**不是待办列表**。
  待办页才回答「还没做什么」，底部有常驻折叠的「已完成」区。

### 断点：CSS 与 JS 必须同值

- CSS：`src/index.css` 的 `@theme` 里 `--breakpoint-md: 1120px`（**写 px，不写 rem**）
- JS：`src/hooks/useMediaQuery.ts` 的 `DESKTOP_QUERY = '(min-width: 1120px)'`

CSS 管 `md:`（弹层限宽 / 遮罩居中 / Toast 位置 / 底部导航隐藏），
JS 管**侧栏 200px 与详情面板 320px 渲不渲染**。
漂移了就会出现「底部导航还在、内容却被它挡住」，且不报错。
`src/test/theme.test.ts` 把两个值钉在一起。

### 字号与层级只有这几档

字号阶梯**只有** 11 / 12 / 13 / 15 / 17 / 20 / 28。
抬升层级**只有** `@utility card-raised`。

### 「显示」与「能点」是两回事

- **撤销不能只有几秒**：打勾/删除必须有**常驻**的撤销路径，Toast 只是快车道。
- 触摸目标 ≥ 44px，交互元素加 `tap tap-active`。
- ⚠️ **`ink-faint` 只有 3.1:1 对比度，只能用于纯装饰图标**。
  时间戳 / 日期 / 空态文案一律用 `ink-soft`。
- 新增颜色令牌要同步进 `scripts/check-contrast.mjs` 的 `TEXT_PAIRS`，
  否则以后改了没人拦。（当前 46 对，已进 CI）

---

## 四、⚠️ 三条「本地测不出来」的坑（花了很多时间才搞明白）

这几条都是**在开发环境里怎么试都复现不了、只能在真机上出现**的。
如果你看到真机上不对，先怀疑这几类，别在本地反复试。

### 1. 手机文字膨胀会让「单指滑不动」

`-webkit-text-size-adjust` 管的是手机的文字膨胀。
**安卓浏览器默认开着膨胀，而开启膨胀会干扰单指手势识别** ——
表现是「单指完全划不动，要先两根手指缩放一下才能滑」。

正解在 `src/index.css` 开头：设成 `none`，并用 `!important` 压住 Tailwind preflight
的 `100%`（**这是本项目唯一一处 important，特意为之，别往别处加**）。

⚠️ **本地永远测不出来**：Chromium 不实现这个属性，连 inline 写进去都读不回。
是**安卓真机专属**的 bug。别再试图为它写 E2E，`theme.test.ts` 里有静态断言。

### 2. 触摸设备的 `overscroll-behavior` 可能掐掉整页滚动

曾经为了「防下拉刷新」，在 `@media (pointer: coarse) { body { … } }` 里
设了 `overscroll-behavior-y: none`，结果**整个页面完全划不动**。

教训：**整页级别（html / body / #root）不要写 `overscroll-behavior` /
`touch-action: none` / `pointer-events: none`** —— 代价太大。
要加只许加在**具体的滚动容器**上（`Modal.tsx` 里那句 `overscroll-contain` 是正确示范）。
`theme.test.ts` 里有 3 条测试守着这条红线。

### 3. 视频/音频的缩放与手势只有真机准

涉及 `visualViewport`、捏合缩放、软键盘顶起布局的行为，
Playwright 模拟出来的结果**可能与真机相反** —— 曾经用它做过一次对照实验，
结论是反的。**这类问题请直接问用户在真机上的表现，不要在本地反复试。**

---

## 五、代码约定

- **注释与文案用中文，标识符用英文。**
- 注释写**为什么**，不写**做了什么** —— 做了什么看代码就知道。
  踩过的坑要写清楚「踩过什么、为什么会踩」。
- TypeScript 开了 `strict` + `verbatimModuleSyntax` + `erasableSyntaxOnly` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride`。
  ⚠️ **可选 callback 必须写 `onBack?: (() => void) | undefined`**，
  否则调用方传 `undefined` 会报错。
- ⚠️ **`npx tsc --noEmit` 不检查测试文件**（tsconfig 项目引用不同）。
  测试里的类型错误只有 `npm run build`（`tsc -b`）或 `npm run verify` 才暴露。
- 依赖方向严格单向：`UI → Repository/Domain → IndexedDB → SyncEngine → CloudAdapter → 后端`。
  `src/cloud/cloudProvider.ts` 是**唯一选路点**。
- **优先级**：数据不丢 > 时间正确 > 离线正常 > 同步正确 > 冲突正确 >
  基本交互 > UI 美观 > 动画。

### 测试分层（不设覆盖率，按风险来）

| 层 | 工具 | 范围 |
| --- | --- | --- |
| 领域逻辑 | Vitest | 时间/日期、合并、schema |
| 界面行为 | Playwright | 端到端走真界面 |
| 组件单测 | **默认不写** | 唯一例外是 `ErrorBoundary` |

**规则：高风险目录（`utils` / `domain` / `sync` / `db` / `worker`）改了必须补测试。**

时间/日期函数有一条铁律：**任意输入都不许抛异常、不许返回 NaN、不许给出假日期**。
纯日期用 `parseLocalDate()`，时刻用 `toDate()`（失败返回 `null`）。
⚠️ **兜底不许依赖 `Intl`。**

---

## 六、提交与部署

提交走 Conventional Commits（`fix:` / `feat:` / `docs:` …），
`pre-commit` 钩子会跑 `npm run verify`，不过不让提交。

**推送后要确认三件事**（不要只看「推上去了」就完）：

1. CI 绿了没：`curl --noproxy '*' https://api.github.com/repos/LHC728/yike/actions/runs?per_page=3`
2. 部署成功没：同上，看 `Deploy to GitHub Pages`
3. 线上真能打开没：`curl --noproxy '*' -o /dev/null -w '%{http_code}' https://lhc728.github.io/yike/`

⚠️ **`git push` 在国内网络下可能推不上去**（`github.com:443` 直连超时、
沙箱代理回 502）。可以借用本机代理软件的端口，例如：

```bash
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push
```

⚠️ 用 `curl` 访问云端要加 `--noproxy '*'` 直连，否则会走沙箱代理、
可能得到与真实网络不一致的结论。

⚠️ **Windows / Git Bash 下 `/yike/` 会被改写成 `C:/Users/.../yike/`**。
凡是带路径参数的调用统一加 `MSYS_NO_PATHCONV=1`（`VITE_BASE`、`curl`、`wrangler` 都中招，
会**静默产出坏包**）。

⚠️ `npx wrangler@4` 在本机是坏的（`d1 export`/`execute`/`deploy` 一律炸 esbuild），
请用 `npm install --ignore-scripts --prefix <临时目录> wrangler@4` 再跑它的
`bin/wrangler.js`。

### 改坏了怎么退回去

存档点（tag）：`v1.0.1-baseline`（单测 331 的稳定基线）、`v1.0.0-pre-projects`。

**首选方法 A**（只换文件、不动历史）：
`git checkout v1.0.1-baseline -- .` → 确认 → 重新提交。后悔了用 `git checkout HEAD -- .` 撤回。

⚠️ **改代码前先确认工作区干净**，否则回退会无声抹掉未提交的改动。
⚠️ **代码能退，数据库迁移不能退**（`worker/migrations/` 只能前进）。
退代码前先确认旧代码认不认识当前表结构。
详细说明见 `README.md` 的「回退版本」一节。

---

## 七、云端后端现状

- **线上在跑的是 Cloudflare**：`https://yike-sync.hl3742198.workers.dev`
  · D1 库名 `yike-sync` · 迁移已到 **0004**（log + parent_id + NULL 安全不可变约束，2026-10-06 已备份并验收）
- **Supabase 是闲置备选**，两套后端语义等价，`CloudAdapter` 是唯一边界
- ⚠️ **两套后端的行为必须保持一致**。`src/test/fakeCloudServer.ts`（假云服务）
  必须与 `supabase/migrations/0001_init.sql` 行为一致；
  `workerSchema.test.ts` 会逐列比对 D1 与 Supabase
- 上线数据库迁移**三步缺一不可**：`d1 export` 备份 → `d1 execute --file` → `wrangler deploy`。
  **漏第三步，老 Worker 会把新字段当没看见 —— 不报错但不同步。**

---

## 八、V1 边界（不要「顺手补上」）

- 不做计划时间
- **待办永远不做截止日**（截止日只属于大事）
- 大事的截止日只用来算倒计时，**不是排期**
- 删除是软删，V1 不做垃圾回收
- **不提供撤销窗口只给几秒的设计**（撤销必须常驻）

---

## 九、可以直接看的文档

| 文件 | 内容 |
| --- | --- |
| `README.md` | 项目介绍、技术栈、部署与安装、云端配置（很详细） |
| `docs/UI-设计规范-V2.md` | 设计令牌、配色、字号、层级 |
| `docs/代码审查标准与流程.md` | 门禁设计、lint 策略、测试分层 |
| `docs/代码审查-基线审计报告.md` | 当初审计出的真实缺陷与修复记录 |

---

## 十、最后一句

这个项目的最高优先级是**「数据不丢」**。

任何一个改动，如果它让「用户的数据可能悄悄少一条」的风险上升，
哪怕界面更好看、代码更整洁，**都不值得**。
拿不准的时候，选更保守的那个方案。
