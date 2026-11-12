# 安装 AdMob Batch Creator

交付脚本为 `dist/admob-batch-creator.user.js`。日常使用只需要浏览器、Tampermonkey 和当前已登录的 AdMob 会话，不需要 Node.js、Python、本地服务、OAuth、API Key 或 Cookie 文件。

当前交付尚未经过真实 AdMob 中文后台和真实 Tampermonkey 安装验收。页面适配采用严格的中文语义定位；页面结构与当前识别范围不一致时会阻止预检或提交。请同时阅读 [页面适配与真实验收状态](adapter-limitations.md)，不要把自动化模拟测试当作线上创建流程已通过。

## Windows Chrome

1. 在平时登录目标 AdMob 的 Chrome 用户配置中，打开 [Tampermonkey 官方 Chrome 下载页](https://www.tampermonkey.net/index.php?browser=chrome)，从其官方商店入口安装稳定版扩展。官方链接指向 [Chrome Web Store 的 Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)。
2. 打开 `chrome://extensions`，确认 Tampermonkey 已启用。按实际版本授予执行用户脚本的权限：Chrome 138 及以上的扩展详情若有“允许用户脚本”开关，开启该项；其他适用版本按官方说明启用开发者模式。Tampermonkey 5.3 及以上需要上述用户脚本执行条件之一，具体界面以当前版本为准。[官方执行权限说明](https://www.tampermonkey.net/faq.php?q=Q209)
3. 确认扩展对 `https://apps.admob.com/` 有网站访问权限。
4. 使用下文“导入交付脚本”安装文件，然后刷新中文 AdMob 目标应用页面。

## Microsoft Edge

1. 在平时登录目标 AdMob 的 Edge 用户配置中，从 [Tampermonkey 官方 Edge 下载页](https://www.tampermonkey.net/index.php?browser=edge)进入 [Microsoft Edge Add-ons 的 Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)，安装稳定版扩展。
2. 打开 `edge://extensions`，确认扩展已启用。按当前 Edge 和 Tampermonkey 显示的要求，开启适用的用户脚本执行权限或开发者模式；官方 FAQ 同时给出 Chrome 与 Edge 的说明。[官方执行权限说明](https://www.tampermonkey.net/faq.php?q=Q209)
3. 确认扩展可以访问 `https://apps.admob.com/`。
4. 安装脚本并刷新中文 AdMob 目标应用页面。

本项目没有接管浏览器设置，也不会自动开启扩展权限；这些步骤由用户在自己的浏览器中完成。

## 导入交付脚本

可先打开交付的 `.user.js` 文件。如果 Tampermonkey 显示脚本安装页，核对名称为“AdMob Batch Creator”、匹配范围为 `https://apps.admob.com/*` 后安装。如果浏览器只显示代码，使用下列管理面板方法：

1. 从 Tampermonkey 扩展菜单进入管理面板，选择“添加新脚本”或对应的新增脚本入口。
2. 在文本编辑器中打开 `dist/admob-batch-creator.user.js`，将文件全部内容导入新脚本编辑器，替换默认模板。必须保留顶部 `// ==UserScript==` 至 `// ==/UserScript==` 的脚本头。
3. 保存并启用脚本，回到已经登录的 AdMob 页面刷新。
4. 确认页面右侧出现中文面板。没有面板时，先检查扩展启用、脚本启用、执行用户脚本权限和网站访问权限。

Tampermonkey 官方支持通过管理面板新建脚本、粘贴完整代码后保存。不同版本对本地 `.user.js` 文件直接打开的处理可能不同；上述管理面板方式不需要为脚本开放本地文件访问权限。[官方脚本安装说明](https://www.tampermonkey.net/faq.php?q=Q102)

脚本不从远程 CDN 加载运行时代码，不请求 Cookie、密码或 Google 登录序号。脚本只匹配 AdMob 后台，不会在 Google 登录页运行。会话过期时请在原浏览器自行恢复登录，再回到原发布商和原应用重新识别。

## 首次检查

1. 打开目标应用的“广告单元”页面，保持简体中文。
2. 点击“重新识别”，检查面板中的 `pub-…` 发布商 ID、应用名称及带 `~` 的 App ID。若缺少明确的页面证据，面板会显示原因，不会用历史缓存补全。
3. 多标签页模式先点击“检测跨页能力”。此操作会使用 `GM_openInTab` 打开插件执行页，不提交广告位；只有实际同会话身份、跨页通知与锁作用域检查通过才能继续多页模式。
4. 检测失败时保留错误信息并导出脱敏诊断。若当前环境仍支持可靠主控互斥，可以在未开始批次时选择“单页模式”；单页也没有 Web Locks 时会禁用创建。
5. 将两列真实清单解析到面板，运行“预检（不提交）”。这一步读取已有广告位，不点击创建。

真实底价字段的 USD 证据会在填表和提交前核验。面板中的请求币种固定为 USD，并不能代替真实字段币种证据；尚未进入底价字段时显示“尚未在真实底价字段确认”属于未完成检查。

## HubVPS：待实机验证

这里的 HubVPS 指酷鸟云 Windows 服务器内置的防关联浏览器。截至当前交付没有获得 HubVPS 实机验收结果，不提供未经观察的菜单、扩展商店或安装流程，也没有使用 HubStudio 团队扩展或账号分配方案。

应在目标 HubVPS 内部，通过它实际支持的扩展管理方式确认能安装并启用 Tampermonkey，再导入同一个 `.user.js`。执行页必须在该 HubVPS 会话内打开。如果实际环境无法运行 Tampermonkey，应记录版本和具体阻塞点，不应转到系统默认浏览器冒充同会话兼容。

实机验收需逐项记录：

1. Tampermonkey 能安装、启用并在中文 AdMob 执行脚本。
2. 面板显示，发布商与目标应用识别正确。
3. GM 存储能写入、回读并在刷新后恢复。
4. 跨标签页通知实际到达。
5. `GM_openInTab` 在当前 HubVPS 环境内打开执行页。
6. 新标签页保留登录，并识别相同发布商与应用。
7. 主控互斥与重复消息防护可靠。
8. 后台执行页的填表、提交和保存后核验正常。
9. 暂停、停止、刷新恢复与不确定结果核验正常。
10. CSV 导出与复制名称、广告位 ID 可用。

多页检查失败但单页前提具备时使用单页模式。测试范围只涉及扩展和脚本能力，不调整代理、指纹、UA、IP、时区或登录数据。真实创建验收只能使用用户确认的清单，并由用户在面板点击“开始创建”。
