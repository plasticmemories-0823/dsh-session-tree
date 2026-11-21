# Linux 安装教程

[下载 Linux 安装包](https://github.com/plasticmemories-0823/dsh-session-tree/releases/download/v0.10.1/dsh-session-tree-0.10.1-linux.tar.gz) · [返回项目首页](../README.md)

Linux 版使用 DSH Web。安装管理器会检查 DSH 版本。

## 安装

1. 安装 **Node.js 24.9 或更高版本**。在终端安装 DSH CLI 和 pnpm。`dsh --version` 应显示 `0.2.2-rc.5`。

   ```sh
   npm install --global pnpm@11.28.5 @deepseek-ai/dsh@0.2.2-rc.5
   dsh --version
   ```

2. 如果 `dsh web` 已在运行，先在它的终端按 `Ctrl+C` 停止。从下载目录解压安装包并启动管理器。

   ```sh
   tar -xzf dsh-session-tree-0.10.1-linux.tar.gz
   cd dsh-session-tree-0.10.1-linux
   sh ./manage.sh
   ```

3. 在管理器中点「安装插件」。如果浏览器没有自动打开，访问终端打印的地址。首次安装可能需要下载依赖。
4. 安装完成后，运行 `dsh web`，从 DSH 左侧会话栏使用会话树。

自定义 DSH 路径可用 `sh ./manage.sh --dsh /path/to/dsh` 指定。操作失败时可查看管理器中的「操作日志」。

## 卸载

停止 `dsh web`，重新运行 `sh ./manage.sh`，在管理器中点「卸载插件」并确认。卸载会保留原有会话和会话树数据。
