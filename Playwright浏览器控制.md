# Playwright 浏览器控制

2026-11-13：已安装 Playwright MCP，并通过扩展连接原 HubVPS Chromium 126 的 AdMob 标签。原登录会话保留；后续批次执行已使用 Playwright 控制。扩展加载、连接选择及 Tampermonkey 官方安装页面通过 Windows IAccessible 与定向 PostMessage 操作，全程无鼠标、无 `tscon`。

## 版本与位置

- MCP：`@playwright/mcp@0.0.85`，固定版本已写入 `C:\Users\Administrator\.codex\config.toml` 的 `playwright` 配置。
- 扩展：Playwright Extension `0.5.0`，ID `mmlmfjhmonkocbjadbfplnigmagldckm`。
- 已加载扩展目录：`C:\Users\Administrator\work\playwright-mcp-support\extension`。请保留该目录。
- 详细维护说明：`C:\Users\Administrator\work\playwright-mcp-support\README.md`。

## 当前会话的调用入口

本轮 Codex 会话通过本机持久 JSON-RPC 桥调用 MCP。桥仅监听本机回环地址，依赖本轮后台进程；系统重启或进程退出后，需重新启动并在扩展页面连接原 AdMob 标签。`health` 只检查服务存活，标签连接应通过实际浏览器工具确认。

```powershell
$bridge='C:\Users\Administrator\work\playwright-mcp-support\mcp-bridge.py'
python $bridge health
python $bridge call browser_snapshot --arguments-file '<参数JSON文件>'
python $bridge result '<返回的任务ID>' --output '<结果JSON文件>'
```

本轮便捷入口：

```powershell
python 'C:\Users\Administrator\work\abc-pw.py' browser_evaluate '<参数JSON文件>' --output '<结果JSON文件>'
```

便捷入口短暂等待结果；若返回任务 ID，再用 `result` 读取。工具参数见本机 `playwright-mcp-support\tools.json`。

未来 Codex 会话加载现有全局 MCP 配置后，可直接使用该会话提供的浏览器工具。配置中的 `connect-request.exe` 仅将连接请求保存到本机文件，随后在原 HubVPS 内打开扩展连接页、选择 AdMob 标签；不会另启标准 Chrome。

## 维护

需要重启桥时，先确认现有桥已经退出，再按详细 README 启动和连接。完成控制后可执行 `python $bridge shutdown` 停止桥；扩展和 Codex MCP 配置保留。

所选 AdMob 标签的 DevTools 应关闭，避免与扩展调试会话冲突。`chrome-extension://` 页面受到扩展过滤，Tampermonkey 管理和安装页面继续使用 Windows 原生可访问性操作。广告位创建数量和核验结果以交付 CSV、验收说明及进度报告为准。
