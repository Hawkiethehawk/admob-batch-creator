# AdMob Batch Creator

面向中文 AdMob 后台的 Tampermonkey 用户脚本。构建产物是一个 `.user.js`；日常使用无需 Node.js、Python、服务端、OAuth 或 API Key。

**当前交付状态：已实现并构建的首版，真实 AdMob 页面尚未校准和验收。** 页面适配采用严格的语义候选；当前页面无法提供账号、应用、完整查重或保存配置证据时，会阻止创建。请勿把模拟测试通过理解为生产后台已经可用。首次真实使用应先完成下列文档中的只读检查，再使用用户确认的清单。开发过程中没有创建任何真实广告单元。

## 安装与使用

- 在线安装：[AdMob Batch Creator 用户脚本](https://raw.githubusercontent.com/Hawkiethehawk/admob-batch-creator/main/dist/admob-batch-creator.user.js)
- [下载完整交付包](https://github.com/Hawkiethehawk/admob-batch-creator/raw/refs/heads/main/dist/admob-batch-creator.zip)（源码、示例、说明与测试记录）
- 安装文件：[`dist/admob-batch-creator.user.js`](dist/admob-batch-creator.user.js)
- [Chrome、Edge 安装和 HubVPS 待验证说明](docs/INSTALL.md)
- [清单、创建、并发、暂停恢复和导出](docs/USAGE.md)
- [真实页面适配限制](docs/adapter-limitations.md)
- [验证记录与剩余验收](docs/VALIDATION.md)
- [两列插页式示例](examples/interstitial.csv)、[两列开屏示例](examples/app-open.csv)

本次构建通过类型检查、61 项逻辑/DOM/恢复测试；Chrome `157.0.8103.39`、Edge `156.0.4314.58` 的本机模拟流程结果见验证记录。真实扩展安装、后台页面和 HubVPS 仍待验收。

脚本只匹配 `https://apps.admob.com/*`。复用脚本所在浏览器配置的现有登录；不会读取 Cookie、调用私有接口、修改付款币种或跨浏览器打开执行页。只支持广告单元全局手动 USD 底价。插页式与开屏分批选择，各行保留自己的价格。

## 已实现的执行边界

1. 以显式发布商 ID 和 AdMob App ID 固定批次；每次领取、关键步骤及提交前再次核对。页面不明确时停止。
2. 预检与逐条执行前都完整检查已有广告单元。分页、筛选或配置无法确认时，标记待核验；同名不自动改名或覆盖。
3. 首条真实创建并核验通过后，固定执行页池才扩到指定并发 1～3。主控独占账号锁，每个执行页另有锁，GM 存储不充当原子锁。多页模式先用当前用户脚本环境进行跨页锁冲突、通知与身份握手。
4. 主控是唯一派发者。独立执行页信箱、稳定任务/分配标识、持久化 journal 和 ACK 防止重复消息变成重复提交。账号级提交许可至少间隔 2.5 秒，许可 10 秒过期。
5. 点击创建前，主控先回读持久化提交意图，执行页再写本地 journal。存在提交意图后，不会自动回到待执行；超时 120 秒暂停派发并保留原归属。
6. 真正成功需要广告单元 `/` ID、应用、名称、格式、手动模式、金额和 USD 的保存后证据。仅拿到 ID 时保留 ID 并标为配置待核验。`~` App ID 不会当作广告位 ID。
7. 暂停和停止均保留提交后观察；降级单页保留旧执行页。停止意图在刷新后仍生效；未确认开始的草稿不能通过“继续”绕过整批确认。仅预检不完整且从未提交的记录不会使取消草稿永久卡住。
8. CSV 包含中文 BOM、原行、账号/应用、请求/实际配置、ID、状态、原因和时间，并防止 Excel 公式注入。脱敏诊断仅导出允许的控件标签/属性和能力统计，不导出任意正文、HTML、输入值或凭证。

## 本地构建

开发环境实测 Node.js 24.17.0、npm 12.2.0。使用仓库内锁文件：

```text
npm ci
npm run typecheck
npm test
npm run build
npm run test:browser
```

`npm run build` 使用 esbuild 将 TypeScript 打包成单一脚本，不包含远程 `@require`。浏览器测试使用隔离、无头的新配置和本机模拟站点；不会读取用户现有浏览器登录。测试机需安装 Chrome / Edge，默认路径见 `tests/browser.mjs`；测试结束关闭测试 context 和本机服务。

Windows 测试会从当前用户及系统标准安装目录查找浏览器。也可用 `ADMOB_CHROME_PATH`、`ADMOB_EDGE_PATH` 环境变量指定可执行文件，不需要修改测试源码。

可用 `node scripts/verify.mjs` 一次执行类型、逻辑测试、构建和语法检查并写入验证记录。打包使用 `scripts/package.ps1`，将源码、文档、示例及安装文件保存到 `dist/admob-batch-creator.zip`；脚本同时生成 SHA-256 清单，并核对 ZIP 内的安装文件哈希。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `src/core.ts` | CSV/TSV、十进制金额、查重分类、状态机、导出 |
| `src/panel.ts` | 中文 Shadow DOM 面板、两列编辑、操作门槛 |
| `src/adapter.ts` | 显式身份、语义 DOM、表单及保存后核验、诊断 |
| `src/gm.ts`、`src/protocol.ts` | GM 存储、真实锁、信箱协议、归属判断 |
| `src/controller.ts` | 唯一派发、首条验证、池、节流、暂停与恢复 |
| `src/worker.ts` | 一次一条执行、提交意图、持久化 journal、结果回报 |
| `src/main.ts` | 角色恢复、避免 iframe 和重复面板注入 |

## 核验依据

官方中文流程确认插页式与开屏都有手动底价及可选国家底价，本项目只处理全局底价；这些资料不能证明当前后台 DOM 已适配。[插页式说明](https://support.google.com/admob/answer/7311435?hl=zh-Hans)、[开屏说明](https://support.google.com/admob/answer/9620632?hl=zh-Hans)。

名称默认上限 80 字符参考官方 `displayName` 定义，提交前仍读取真实表单限制；仅参考其字段定义，没有调用 AdMob API。[广告单元字段定义](https://developers.google.com/admob/api/reference/rest/v1/accounts.adUnits/list#AdUnit)。GM 权限与标签页能力依据 [Tampermonkey 官方文档](https://www.tampermonkey.net/documentation.php?locale=en)，安装执行许可依据 [官方 Q209](https://www.tampermonkey.net/faq.php?locale=en&q=Q209)。
