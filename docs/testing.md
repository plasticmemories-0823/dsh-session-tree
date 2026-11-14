# Windows 桌面 Host 回归测试

准备已安装的 DSH `0.2.2-rc.3`、Chrome 和 Node.js 24+。脚本会启动和重启桌面 Host，并创建和回收测试会话。先为 `DSH_HOME` 准备一份隔离的 `desktop` 配置。在测试配置中使用默认的 `deepseek-official` 提供方和 `workspace-write` 权限。测试脚本启动 Host 时会把模型请求转发到本地模拟服务。

```powershell
$env:DSH_HOME = 'C:\test\dsh-home'
$env:SESSION_TREE_TEST_HOME = $env:DSH_HOME
$env:SESSION_TREE_TEST_DESKTOP = '1'
$env:SESSION_TREE_DSH_EXE = 'C:\path\to\DeepSeek Harness\DeepSeek Harness.exe'
$env:SESSION_TREE_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

$dsh = Join-Path (Split-Path $env:SESSION_TREE_DSH_EXE) 'resources\runtime\cli\bin\dsh.cmd'
$tgz = (Resolve-Path '.\dsh-session-tree-0.8.1.tgz').Path.Replace('\', '/')
& $dsh plugin --profile desktop add "file:$tgz"
node tests/browser.mjs
```

发布验收也应使用解压后的 `DSH Session Tree Manager.exe`。在隔离配置中检查安装、卸载、重新安装，以及 DSH 运行时的操作提示。管理器可接收 DSH 可执行文件路径作为第一个参数，供自定义安装目录或测试使用。
