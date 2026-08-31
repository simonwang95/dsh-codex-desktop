# DSH Codex Desktop

基于官方 DeepSeek Harness（DSH）Web 运行时的跨平台 Electron 桌面壳。

[English](README.md) · [更新日志](CHANGELOG.zh-CN.md)

## 当前发行边界

默认构建是 **core-only**：只携带官方 `@deepseek-ai/dsh` 运行时和启动所需的 Node/pnpm 工具链，不下载或补种第三方插件目录。用户 DSH Profile 中已经存在的第三方包会被保留，并继续由用户自行管理。

桌面更新缺省关闭，不绑定固定 GitHub owner 或 Release 地址。只有显式配置独立 generic feed 后才启用：

```text
DSH_DESKTOP_UPDATE_URL=https://updates.example.test/desktop/
DSH_DESKTOP_RELEASE_NOTES_URL=https://example.test/changes
DSH_DESKTOP_FEEDBACK_URL=https://example.test/feedback
```

除本机 loopback 测试可用 HTTP 外，其余 URL 必须使用 HTTPS。应用启动时不会自动检查桌面更新。

## 运行时升级

DSH、Node 与 pnpm 版本统一声明在 `package.json#config.runtimeManifest`；官方 DSH 完整依赖图冻结在 `runtime-lock/package-lock.json`，默认装配使用 `npm ci`。

候选运行时安装到版本化目录，并检查包身份、入口、`@deepseek-ai/dsh*` 版本族一致性、归档完整性，以及隔离 Profile 下的 loopback HTTP 健康状态。小型原子状态文件选择 `current` 并记录 `last-known-good`。候选失败不会替换 current；切换后首次真实启动失败会自动回滚。安装包携带的新运行时高于已有版本时，必须由用户确认后才启用。

用户会话、凭据和插件继续位于 `~/.dsh`；运行时切换不会删除 Profile。

## 浏览器自动化（macOS / Windows）

浏览器自动化默认关闭。安装 Google Chrome 后，可从“帮助”→“浏览器自动化…”显式启用并重载 DSH。安装包固定携带 Playwright MCP 运行时，但不捆绑浏览器；自动化始终启动系统 Chrome。

Windows 版支持 x64 系统安装的 Chrome Stable，不需要 macOS TCC 自动化授权。企业 Chrome 策略或非标准便携版 Chrome 可能阻止 Playwright 启动；未签名安装包仍可能触发 SmartScreen。

每个 DSH 会话使用独立且可持久化的 Chrome Profile 和输出目录，不读取日常 Chrome Profile，也不会与其他会话共享登录态。`workspace-write` 权限下允许页面读取、截图和会话目录写入；点击、输入、下载等可能改变状态的操作仍需审批，文件上传只允许来自当前工作区的真实文件路径。关闭功能会终止相关浏览器进程，但保留各会话 Profile，供下次启用后继续使用。

## 构建与验证

固定工具链：

- Node `24.19.0`
- pnpm `11.22.0`

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run check:independence
pnpm test
pnpm run prepare-runtime
pnpm run pack
```

Apple Silicon macOS 原生执行 `pnpm run dist -- --mac --arm64`；Windows x64 原生执行 `pnpm run dist -- --win --x64`。仓库工作流仅支持手动触发和临时 Windows artifact，不创建标签或 GitHub Release。

## 个人未签名安装包

本地非正式制品存放在被 Git 忽略的 `release/personal/`。未签名 macOS 应用可能被 Gatekeeper 拦截：在 Finder 中按住 Control 点按本应用，选择“打开”，并只确认这个应用。Windows SmartScreen 可能提示未知发布者：核对文件和哈希后选择“更多信息”→“仍要运行”。不要全局关闭 Gatekeeper 或 SmartScreen。

## 安全基线

- DSH 显式绑定 `127.0.0.1` 随机端口，HTTP 健康通过后才加载。
- Electron 保持 `nodeIntegration: false`、`contextIsolation: true`、renderer sandbox、受限导航与最小 IPC。
- 退出只回收本应用创建的进程树。
- 升级日志只记录阶段、版本、路径类别和脱敏错误，不记录凭据或会话正文。

项目采用 Apache-2.0 许可证；历史归属保留在 `LICENSE` 与 Changelog 中。
