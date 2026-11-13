# 工作目录

当前项目根目录为 `C:\Users\Administrator\Desktop\AdMob-Batch-Creator-交付`。所有项目命令和后续源码修改均在本目录执行。

- `src/`、`tests/`、`docs/`、`scripts/`、`examples/`、`package.json` 均直接位于根目录；不再使用嵌套的“源码”目录。
- `C:\Users\Administrator\work\admob-batch-creator` 是历史工作副本，不继续编辑，也不自动同步覆盖当前目录。
- 安装脚本保留在 `dist/admob-batch-creator.user.js`，对应校验值见 `dist/SHA256SUMS.txt`。需要发布快照时再运行 `scripts/package.ps1` 生成 ZIP。
- 保留 `结果/` 中全部历史和当前 CSV、`docs/` 中验收证据与测试输出、`tests/` 中回归用例及夹具。
- 需要开发依赖时在根目录运行 `npm.cmd ci`；检查命令为 `npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。纯文件整理无需安装依赖或重跑创建。
- 已完成的广告位及其 ID、提交意图不可视为待创建任务。后续真实创建应以用户的新指令为准。底价已由清单确定，无需单独确认。
- 浏览器控制优先复用现有 Playwright 和原 HubVPS 会话，不操纵鼠标。外部支持目录 `C:\Users\Administrator\work\playwright-mcp-support` 与 `abc-pw.py` 仍在使用，不属于本项目目录清理范围。
- 工作期间按用户要求每三分钟更新根目录 `进度报告.md`。现有隐藏刷新进程读取 `C:\Users\Administrator\work\admob-progress-state.json`；更新该事实来源，避免只改报告后被旧内容覆盖。

当前版本和实测结果见 `HANDOFF-AI-AGENT.md`、`docs/VALIDATION.md`。目录整理前的交付快照和冗余文件备份在 `C:\Users\Administrator\work\admob-workspace-archive-20261113-211044`。
