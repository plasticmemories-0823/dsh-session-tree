# macOS 安装教程

[下载 macOS 安装包](https://github.com/plasticmemories-0823/dsh-session-tree/releases/download/v0.10.1/dsh-session-tree-0.10.1-macos.tar.gz) · [返回项目首页](../README.md)

macOS 版适用于 Apple Silicon 上的 DSH 桌面版。v0.10.1 的安装器尚未在 Mac 真机上验证。

## 安装

1. 安装 **Node.js 24.9 或更高版本**。将 DeepSeek Harness 桌面版 **`0.2.2-rc.5`** 放到「应用程序」，打开一次以初始化配置，再用 `⌘Q` 退出。[DeepSeek Harness 官方安装包（Apple Silicon）](https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.2-rc.5-mac-arm64.dmg)
2. 解压本页提供的插件安装包，双击 `Manage.command`。也可以在终端进入下载目录，再运行以下命令。如果已用 Finder 解压，直接进入解压目录运行最后一条命令。

   ```sh
   tar -xzf dsh-session-tree-0.10.1-macos.tar.gz
   cd dsh-session-tree-0.10.1-macos
   sh ./Manage.command
   ```

3. 在管理器中点「安装插件」。如果浏览器没有自动打开，访问终端打印的地址。
4. 安装完成后重新打开 DSH。使用 `⌘` 在侧栏多选会话或按住 `⌘` 拖动进行挂载。

如果 DSH 安装在自定义目录，在解压目录运行下面的命令，并替换为实际路径。操作失败时可查看管理器中的「操作日志」。

```sh
sh ./Manage.command --dsh '/path/to/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
```

## 卸载

用 `⌘Q` 退出 DSH，重新打开 `Manage.command`，在管理器中点「卸载插件」并确认。卸载会保留原有会话和会话树数据。
