# Windows 桌面 Host 回归测试

准备已安装的 DSH `0.2.2-rc.3`、Chrome 和 Node.js 24+。脚本会启动和重启桌面 Host，并创建和回收测试会话。先为 `DSH_HOME` 准备一份隔离的 `desktop` 配置。在测试配置中使用默认的 `deepseek-official` 提供方和 `workspace-write` 权限。测试脚本启动 Host 时会把模型请求转发到本地模拟服务。

```powershell
$env:DSH_HOME = 'C:\test\dsh-home'
$env:SESSION_TREE_TEST_HOME = $env:DSH_HOME
$env:SESSION_TREE_TEST_DESKTOP = '1'
$env:SESSION_TREE_DSH_EXE = 'C:\path\to\DeepSeek Harness\DeepSeek Harness.exe'
$env:SESSION_TREE_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

$dsh = Join-Path (Split-Path $env:SESSION_TREE_DSH_EXE) 'resources\runtime\cli\bin\dsh.cmd'
$tgz = (Resolve-Path '.\dsh-session-tree-0.7.0.tgz').Path.Replace('\', '/')
& $dsh plugin --profile desktop add "file:$tgz"
node tests/browser.mjs
```

公开发布前也用解压后的 `Install.cmd` 安装到隔离的桌面配置并运行同一套回归。测试 `Install.ps1` 时可通过 `-DshExe` 指定应用，通过 `-NoLaunch` 跳过安装后打开应用的步骤。
