# I004 Goal 执行任务书

更新时间：2026-08-25 18:35（Asia/Shanghai）

## 可直接启动的 Goal

```text
/goal 完成 I004：使 DSH Codex Desktop 的默认构建、核心运行、验证与后续桌面更新不依赖 MichengAI，实现可验证、可回滚的 DSH 运行时升级，并最终把 macOS arm64 的 DMG/ZIP 与 Windows x64 的 NSIS EXE/ZIP 连同 SHA256、文件大小和安装启动冒烟证据交付到本地 release/personal。允许为 Windows 原生构建把必要提交推送到我控制且不属于 MichengAI 的仓库分支、手动触发 GitHub Actions 并下载临时 artifact；执行前必须核对 remote，绝不得向 MichengAI 推送。持续推进直到本任务书的全部完成条件有可复核证据；不要签名、公证、创建或推送标签、创建 GitHub Release、公开发布安装包，也不要删除用户 Profile 数据。任一目标平台没有实际制品或验证失败时不得标记完成。
```

Goal 模式适合有明确终止条件和验证循环的长任务。执行时应以本文为唯一任务清单，按检查点推进并保留简短进度记录；有实际执行内容后再创建 `02-执行记录.md`，不要预建空模板，也不要把本文扩展成无关重构或开放式 backlog。

## 开始前必须读取

1. `docs\00-交接入口\00-阅读导航.md`
2. `docs\00-交接入口\05-技术架构基线.md`
3. `docs\03-技术架构\00-桌面启动器架构基线.md`
4. `docs\01-当前工作\I004-DSH运行时独立更新\00-迭代总览.md`
5. `package.json`
6. `src\bundled-plugins.ts`
7. `scripts\prepare-runtime.ts`
8. `src\extract-runtime.ts`、`src\runtime-prebuilt.ts`、`src\plugin-seed.ts`
9. `src\desktop-host.ts`、`src\dsh-process.ts`、`src\readiness.ts`
10. `src\desktop-bridge-client-source.ts`、`src\dsh-view-preload.cts`
11. `.github\workflows\desktop-package.yml`

开始实现前先运行只读检查，记录工作树已有改动并保留用户修改。不得用 reset、checkout 或覆盖方式清理工作树。

## 目标状态

完成后的系统边界应为：

```text
可选桌面更新配置
  ├─ 未配置 → 不联网、更新入口禁用或说明未配置
  └─ 已配置 → 通过通用 provider 接口检查，不绑定固定 GitHub owner

官方 DSH 候选包或随包运行时
  → 安装到版本化 staging
  → 校验包身份、版本、依赖族、入口和归档完整性
  → 用隔离 Profile 启动并完成 HTTP 健康检查
  → 原子切换 current，旧 current 记为 last-known-good
  → 首次真实启动失败时自动回滚

用户 ~/.dsh Profile
  → 始终保留
  → 不默认补种 @michengai/*
  → 已存在的第三方插件不主动删除或覆盖

个人交付目录 release/personal
  ├─ macos-arm64 → DMG + ZIP + 原生安装/启动证据
  ├─ windows-x64 → NSIS EXE + ZIP + 原生安装/启动/卸载证据
  └─ ARTIFACTS.md → 版本、commit、runner、大小、SHA256 和验证结果
```

## 范围和非目标

### 必须完成

- 默认 `core-only` 构建、启动和验证链路。
- 更新源去 `MichengAI` 硬编码并缺省关闭。
- DSH 版本单一事实源。
- 版本化运行时、候选验证、原子切换、最后可用版本回滚。
- 对 DSH 官方契约和桌面兼容层的行为测试。
- core-only、存量 Profile 和失败升级回归测试。
- 可供当前用户自行安装的 macOS arm64 与 Windows x64 未签名制品。
- 四个制品的原生平台安装/启动验收、SHA256 和本地交付清单。
- 文档与实际代码对齐。

### 明确不做

- Windows/macOS 代码签名和 macOS 公证。
- GitHub Release、正式下载页、正式更新服务器或灰度发布系统。
- 创建或推送标签、公开发布安装包、把临时 artifact 转为正式或长期公开下载。
- macOS x64、Linux 安装包以及自动更新 feed；它们可以保持可构建，但不是本 Goal 的制品停止条件。
- 为六个原 `@michengai/*` 功能插件重新开发替代产品。
- 删除 LICENSE 或历史 Changelog 中依法需要保留的归属信息。
- 改写 DeepSeek Harness 上游仓库。
- 无关 UI 重做、业务功能扩张或全仓库格式化。

## 不依赖 MichengAI 的判定边界

### 活动依赖必须清零

以下位置不得再以 `MichengAI` 作为默认运行或更新依赖：

- `package.json` 的默认 publish、repository、author/maintainer 运行配置。
- `src/main.ts` 中“更新说明”和“反馈”动作的固定 URL。
- `electron-updater` 的默认 GitHub feed。
- `README.md`、`README.zh-CN.md` 中面向当前使用者的默认下载、Issue、CI badge 地址。
- `src/bundled-plugins.ts` 的默认补种目录。
- `prepare-runtime` 的默认网络下载集合。
- CI 的标签 Release 发布任务。

不得把这些值简单替换成另一个未知 owner。需要仓库身份的字段应改为可选产品配置；未配置时功能安全降级。

### 允许保留

- LICENSE 中的既有版权声明。
- Changelog 和历史迭代记录中的旧链接或事实描述。
- 用户 Profile 已安装的 `@michengai/*` 包。
- 显式传入的 legacy/第三方插件目录，但它不能参与默认 core-only 验收。

## 需求与验收映射

| 编号 | 要求 | 主要涉及位置 | 必须提供的证据 |
|---|---|---|---|
| R1 | 建立中性、可选的产品与更新配置 | `package.json`、新增配置模块、`src/main.ts`、`src/desktop-updater.ts` | 未配置时不联网；活动代码无旧 Release/Issue 硬编码 |
| R2 | 默认 core-only，不下载或补种 `@michengai/*` | `src/bundled-plugins.ts`、`scripts/prepare-runtime.ts`、`src/plugin-seed.ts` | 空白 Profile 启动；依赖扫描和装配测试通过 |
| R3 | 保留已有第三方 Profile 数据 | `src/plugin-seed.ts`、`src/profile-repair.ts` | fixture 中已有第三方包与 bundle 不被删除、降级或覆盖 |
| R4 | DSH 版本单一事实源 | `package.json` 或新增运行时 manifest、测试和关于页 | 版本只需改一处；实际安装版本可读取 |
| R5 | 候选运行时事务化更新和回滚 | `src/extract-runtime.ts`、`src/runtime-prebuilt.ts`、新增运行时状态模块 | 成功切换、安装失败、健康失败、首次启动失败四类测试 |
| R6 | 消除 rc.2 补丁硬阻塞 | `patches/`、`scripts/prepare-runtime.ts` | 新版本不因固定版本判断无条件失败；本地化不静默丢失 |
| R7 | 收敛 DSH 契约适配层 | `src/dsh-process.ts`、桥接与 preload | CLI/Profile/Bridge 契约测试；不支持能力明确禁用 |
| R8 | 运行时装配可复现 | `scripts/prepare-runtime.ts`、lockfile/完整性清单 | 相同输入得到固定依赖图；所有官方 DSH 家族版本一致 |
| R9 | 升级与 core-only 回归验证 | `test/`、smoke 脚本、CI | 单测、升级 fixture、打包冒烟和 CI 静态检查通过 |
| R10 | 文档与代码一致 | README、架构基线、交接入口、本迭代记录 | 版本、默认插件、更新策略和非发行边界无冲突 |
| R11 | 交付个人可安装制品 | `package.json`、安装器脚本、CI、`release/personal/` | 同一 Git commit 生成的 macOS arm64 DMG/ZIP 与 Windows x64 NSIS EXE/ZIP 实际存在，原生验收通过且 SHA256 可复核 |

## 实施检查点

Goal 执行者可以调整文件拆分，但不得跳过检查点的结果和验证。

### 检查点 A：冻结现状和独立配置边界

1. 记录当前测试数、运行时版本、默认插件目录、更新 feed 和相关硬编码。
2. 建立单一产品配置入口；不要引入新的固定 owner。
3. 未配置更新源时，隐藏或禁用检查、下载、安装、更新说明和反馈动作，并给出明确本地提示。
4. CI 保留测试、打包、冒烟和临时 Actions artifact；删除或禁用 Release 发布路径。

通过条件：静态扫描中，活动代码和默认产品配置不再指向 `MichengAI`；无更新源时不会调用 `autoUpdater.checkForUpdates()`。

### 检查点 B：core-only 与第三方目录解耦

1. 默认闭包只装配官方 DSH 和启动必需依赖。
2. 把第三方插件目录改为显式可选输入；没有输入时不得下载任何 `@michengai/*`。
3. 首次启动不得再默认补种原套件。
4. 已有 Profile 的第三方依赖和 bundle 保持原样；只有确认磁盘包缺失的损坏登记才能沿用现有自修复规则。
5. 官方 DSH UI 不支持的桌面壳动作通过能力状态禁用，不能假装执行成功。

通过条件：断网或屏蔽 `MichengAI` 资源时，core-only 运行时仍可装配并启动；旧 Profile fixture 内容保持不变。

### 检查点 C：版本事实源和可复现装配

1. 用一个 manifest 统一 DSH、Node、pnpm 和必要 peer 版本；现有 `bundledDshVersion` 与 `OFFICIAL_DSH_VERSION` 不得继续各自维护。
2. 增加版本升级辅助命令，至少完成 manifest 更新、补丁适用性检查和相关测试更新。
3. 给官方运行时使用冻结依赖图或等价机制；不能只固定顶层 npm 版本而允许传递依赖漂移。
4. 装配后遍历并验证所有 `@deepseek-ai/dsh*` 包的版本策略、入口和包身份。
5. 关于页读取实际 current 运行时 manifest。

通过条件：人为改变单一 DSH 版本后，测试能准确指出所有不兼容点；成功装配时不存在半新半旧的 DSH 家族。

### 检查点 D：事务化升级和回滚

1. 采用版本化目录或等价的不可变候选结构，禁止直接在 current 目录中执行破坏性在线安装。
2. 状态至少表达 `staging`、`current`、`last-known-good` 和失败原因。
3. 候选切换前执行包完整性、实际版本、入口、Profile 合成和隔离 HTTP 健康检查。
4. 切换必须原子化；Windows 无法原子替换目录时使用小型 current manifest/指针，不以覆盖复制模拟事务。
5. 候选首次真实启动失败时自动切回 last-known-good，并写入不含凭据和会话内容的诊断日志。
6. 安装包携带的新 DSH 若高于 current，应显示“有随包运行时可用”，由用户明确触发；仍不得启动即静默升级。

通过条件：测试覆盖成功、安装失败、校验失败、健康失败、切换中断和首次启动失败；每种失败都能继续启动旧运行时。

### 检查点 E：上游契约兼容层

1. 启动参数显式指定 `--host 127.0.0.1 --port 0 --no-open`。
2. 把 CLI 入口、就绪输出、Profile/Bundle manifest、Cordis patch、桌面 host service 和客户端桥接分别建模为契约。
3. 官方公开契约可作为主路径；`window.__ModuleLoader__`、`.dcu-wb-session`、按钮文字和内部 service shape 只能进入隔离 adapter 或降级路径。
4. 能力探测失败时禁用对应菜单，并保持聊天主界面可用。
5. 替换 rc.2 构建产物补丁：优先采用上游已有本地化；否则使用不绑定具体构建文件行号的桌面扩展。无法做到时保留明确的版本补丁映射，但不得让未知新版本静默套用旧补丁。

通过条件：契约 fixture 变化会产生针对性失败；DOM 结构变化不会阻止 DSH 核心界面启动。

### 检查点 F：完整验证和文档收口

1. 执行全部单元测试、升级回归和独立性闸门；在打包前冻结一个可追踪的构建 commit，两平台必须使用同一 commit、lockfile 与运行时 manifest，不得分别从不同工作树打包。
2. 在当前 Apple Silicon Mac 原生执行 macOS arm64 打包，实际取得 DMG 与 ZIP；分别验证 DMG 可挂载并把 `.app` 复制到临时应用目录后启动，以及 ZIP 可解压后启动。两条路径都必须完成 DSH loopback HTTP 健康检查和受控退出。
3. 在原生 Windows x64 主机或用户控制的非 `MichengAI` GitHub Actions runner 执行 Windows x64 打包，实际取得 NSIS EXE 与 ZIP；验证未安装目录启动、NSIS 安装后启动、受控退出、卸载，以及卸载后预置的 `~/.dsh` 哨兵数据仍存在。
4. 把两平台的四个最终文件复制或下载到 `release/personal/macos-arm64/` 与 `release/personal/windows-x64/`。不得把 unpacked 目录、`.yml`、`.blockmap` 或日志冒充交付制品。
5. 为四个文件计算 SHA256 和字节大小，在 `release/personal/ARTIFACTS.md` 记录应用/DSH/Node/pnpm 版本、两平台共同的 Git commit、构建前工作树状态、原生 runner OS/架构、制品名称、大小、哈希、实际命令和验收结果。
6. 增加简短的个人安装说明，说明未签名包可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示，只提供针对本应用的允许步骤，不得建议全局关闭系统安全机制。
7. 更新 README、架构基线、当前状态、路线图和本迭代总览；记录实际测试数、跳过项、失败与修复，不写空模板。
8. 检查 `release/personal/` 仍处于 Git 忽略范围，工作树未暂存运行时归档、安装包、日志、凭据或用户数据。

通过条件：本文“完成条件”全部有对应测试或检查结果，且四个交付文件已落到本地 `release/personal/`。Windows 任务仍在排队、临时 artifact 尚未下载或只有构建日志时均不通过。

## 必须新增的行为测试

- 无桌面更新配置时不发起网络更新检查。
- 任意配置 URL 不会回退到旧 `MichengAI` feed。
- core-only 目录不包含 `@michengai/*`。
- 已安装第三方插件的 Profile 启动后 manifest 与版本保持不变。
- 新安装使用随包 DSH；旧安装不会仅因桌面重启而静默切换。
- 用户确认升级后，候选通过验证才切换。
- 候选安装失败时 current 不变。
- 候选 HTTP 健康检查失败时 current 不变。
- 切换后首次真实启动失败时回滚 last-known-good。
- 关于页显示实际磁盘版本。
- DSH 官方依赖族版本不一致时拒绝候选。
- 非 loopback 就绪 URL 继续被拒绝。
- 不支持的桌面 UI 动作显示禁用状态，不执行 DOM 猜测。
- macOS DMG 可挂载、应用可复制到新的目录并通过启动健康检查；ZIP 解压路径得到同样结果。
- Windows NSIS 可完成安装、启动、退出和卸载；Windows ZIP 解压路径可启动；卸载不得删除 `~/.dsh` 哨兵数据。

现有以源码正则为主的测试可以保留必要的安全闸门，但新增验收必须优先验证行为和状态转换。

## 验证命令

Goal 执行者先确认 Node `24.19.0` 和 pnpm `11.22.0`。项目依赖齐全后至少执行：

```text
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run prepare-runtime
pnpm run pack
git diff --check
git status --short
```

macOS arm64 至少执行：

```text
pnpm run dist -- --mac --arm64
pnpm run smoke:mac -- --application-path <release 中的 arm64 .app>
<新增或等价脚本> 验证 DMG 挂载、临时复制、启动、健康检查和退出
<新增或等价脚本> 验证 ZIP 解压、启动、健康检查和退出
```

Windows x64 必须在原生 Windows 环境至少执行：

```text
pnpm run dist -- --win --x64
.\scripts\smoke-package.ps1 -ApplicationPath 'release\win-unpacked\DSH Codex Desktop.exe'
<新增或等价 PowerShell 脚本> 验证 NSIS 安装、启动、健康检查、退出、卸载和 Profile 哨兵保留
<新增或等价 PowerShell 脚本> 验证 ZIP 解压启动
```

跨平台打包不得复用错误架构的随包 Node 或 DSH 运行时；Windows 制品必须由 Windows x64 runner 生成。若使用 GitHub Actions，必须核对仓库不属于 `MichengAI`，只保留手动构建与临时 artifact 路径，禁止触发标签 Release；运行成功后必须把 Windows EXE/ZIP 下载到本地 `release/personal/windows-x64/` 并复核哈希。把对应项写成“等待 CI”不能满足本 Goal。

建议新增一个仓库脚本作为独立性闸门，例如 `pnpm run check:independence`，其职责是扫描活动代码、默认配置、打包资源和依赖目录；历史 Changelog、LICENSE、历史迭代文档和显式 legacy fixture 使用 allowlist，而不是全局忽略。

## 失败与恢复规则

- 任何运行时更新失败都必须保持 current 可启动；不得先删 current 再下载。
- 不得通过删除 `~/.dsh`、Profile、lockfile 或用户插件来让测试通过。
- 网络不可用时可以使用已校验缓存和 fixture 验证状态机，但不得降低完整性或版本检查。
- 上游 DSH 新版本不兼容时，保留当前稳定版本，记录具体失败契约，再适配；不得强制发布半可用运行时。
- 原生 Windows runner、非 `MichengAI` 授权仓库或 artifact 下载确实不可用时，不得伪造制品或使用 macOS 交叉构建冒充；记录已尝试证据并把 Goal 保持为未完成/阻塞。
- 工作树已有用户修改时绕开或最小合并，不能重置。
- 遇到与目标无关的问题，只记录到本迭代待处理，不扩大 Goal。

## 安全与隐私约束

- DSH 始终显式绑定 `127.0.0.1`，并继续校验随机端口就绪 URL。
- 不降低 `nodeIntegration: false`、`contextIsolation: true`、sandbox、导航和 IPC 权限边界。
- 升级日志只记录版本、路径类别、阶段和脱敏错误；不得记录凭据、请求头、会话正文或模型输出。
- 归档和候选目录继续做 SHA256、路径穿越和包身份检查。
- 进程回收只作用于本桌面端创建的进程树。

## 默认答案与可延后问题

- 仓库最终 owner 未确定：默认不配置，不因此阻塞。
- 正式更新服务器未确定：默认更新功能关闭，只保留 provider 接口。
- 六个第三方功能产品无替代实现：默认不补种，保留用户已装版本，不因此阻塞核心完成。
- 签名、公证和正式 Release：全部延后，不进入验收。
- macOS 目标架构：当前主机为 Apple Silicon，最低只要求 arm64；Intel x64 可延后。
- Windows 构建：使用原生 Windows x64 环境；优先使用用户有权限的非 `MichengAI` GitHub Actions 临时 artifact，不能使用错误架构交叉构建替代。
- 未签名安装提示：作为个人自用限制记录并提供单应用级允许方式，不因此阻塞；不得全局关闭 Gatekeeper 或 SmartScreen。
- 历史归属是否改名：保留历史与 LICENSE，活动产品文案改为中性，不做法律归属判断。

只有会改变上述既定边界的问题才需要请求用户决定；普通文件拆分、测试结构和状态机实现由 Goal 执行者自行选择。

## 完成条件

只有同时满足以下条件，才能将 Goal 标记完成：

1. R1–R11 全部实现并有测试或检查证据。
2. 默认构建、core-only 装配、启动和桌面更新检查没有 `MichengAI` 运行依赖。
3. 已有第三方 Profile 数据在升级回归中保持不变。
4. DSH 升级具备候选验证、原子切换和 last-known-good 回滚。
5. 实际运行时版本可追踪，版本事实源只有一个。
6. 全量测试、macOS arm64 原生安装冒烟和 Windows x64 原生安装冒烟全部通过。
7. 本地 `release/personal/macos-arm64/` 实际包含 DMG 与 ZIP，`release/personal/windows-x64/` 实际包含 NSIS EXE 与 ZIP；四个文件均非空、可读取且与记录的 SHA256 相符。
8. 四个制品来自同一 Git commit；`release/personal/ARTIFACTS.md` 完整记录版本、commit/工作树状态、runner、大小、哈希、命令和两平台验收结果；README、架构和交接文档与实现一致。
9. 没有执行签名、公证、创建或推送标签、GitHub Release 或公开发布。为 Windows 构建使用经核对的非 `MichengAI` 临时分支和 Actions artifact 是允许的，不视为正式发行。
10. 除被 Git 忽略的 `release/personal/` 预期制品外，工作树中没有意外运行时归档、安装包、日志、凭据或用户数据。

完成报告必须给出：实现摘要、关键设计、验证命令与结果、四个制品的绝对路径/文件名/字节大小/SHA256、两平台安装与启动验收结果、未签名安装注意事项、剩余非目标事项和主要文件链接。
