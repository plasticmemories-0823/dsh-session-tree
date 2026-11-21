using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Win32;
using System.Collections.Generic;

internal sealed class Manager
{
    private const string Plugin = "dsh-session-tree";
    private const string AppName = "DeepSeek Harness.exe";
    private const string SupportedVersion = "0.2.2-rc.5";
    private const string Cli = @"resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js";
    private static readonly Assembly Bundle = typeof(Manager).Assembly;
    private readonly Window window;
    private readonly string release;
    private readonly string profile;
    private readonly string managerDirectory;
    private string executable;
    private string checkedExecutable;
    private DateTime checkedArchiveTime;
    private string checkedVersion;
    private bool busy;

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            new Application().Run(new Manager(args.FirstOrDefault()).window);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "DSH 会话树 · 插件管理器", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private Manager(string preferredPath)
    {
        using (var layout = Bundle.GetManifestResourceStream("Manager.xaml"))
            window = (Window)XamlReader.Load(layout);
        using (var version = new StreamReader(Bundle.GetManifestResourceStream("version.txt")))
            release = version.ReadToEnd().Trim();
        var home = Environment.GetEnvironmentVariable("DSH_HOME");
        if (String.IsNullOrWhiteSpace(home))
            home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        profile = Path.Combine(home, "profiles", "desktop");
        managerDirectory = Path.Combine(home, "session-tree", "manager");
        executable = LocateHarness(preferredPath);

        Element<TextBlock>("BundleVersion").Text = "安装包 v" + release;
        Element<Button>("Browse").Click += delegate { Browse(); };
        Element<Button>("Install").Click += async delegate { await ChangePlugin(true); };
        Element<Button>("Uninstall").Click += async delegate { await ChangePlugin(false); };
        Element<Button>("OpenDsh").Click += delegate { OpenHarness(); };
        window.Closing += delegate(object sender, System.ComponentModel.CancelEventArgs eventArgs) { eventArgs.Cancel = busy; };
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        timer.Tick += delegate { if (!busy) Refresh(false); };
        window.Closed += delegate { timer.Stop(); };
        Refresh(true);
        timer.Start();
    }

    private T Element<T>(string name) where T : FrameworkElement
    {
        return (T)window.FindName(name);
    }

    private string LocateHarness(string preferredPath)
    {
        if (IsHarness(preferredPath)) return preferredPath;
        foreach (var process in Process.GetProcessesByName("DeepSeek Harness"))
        {
            using (process)
            {
                try
                {
                    var path = process.MainModule.FileName;
                    if (IsHarness(path)) return path;
                }
                catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        var pathFile = Path.Combine(managerDirectory, "harness-path.txt");
        if (File.Exists(pathFile))
        {
            var remembered = File.ReadAllText(pathFile).Trim();
            if (IsHarness(remembered)) return remembered;
        }
        foreach (var directory in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';'))
        {
            var cli = Path.Combine(directory.Trim('"'), "dsh.cmd");
            if (!File.Exists(cli)) continue;
            var candidate = Path.GetFullPath(Path.Combine(directory.Trim('"'), @"..\..\..\..", AppName));
            if (IsHarness(candidate)) return candidate;
        }
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            foreach (var branch in new[] { @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" })
            {
                using (var entries = root.OpenSubKey(branch))
                {
                    if (entries == null) continue;
                    foreach (var key in entries.GetSubKeyNames())
                    {
                        using (var entry = entries.OpenSubKey(key))
                        {
                            if (entry == null) continue;
                            var name = entry.GetValue("DisplayName") as string;
                            if (name == null || name.IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            var directory = entry.GetValue("InstallLocation") as string;
                            if (String.IsNullOrWhiteSpace(directory)) continue;
                            var path = Path.Combine(directory.Trim('"'), AppName);
                            if (IsHarness(path)) return path;
                        }
                    }
                }
            }
        }
        foreach (var root in new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            foreach (var subdirectory in new[] { "DeepSeek Harness", "dsh-desktop", @"@deepseek-ai\dsh-desktop" })
            {
                var candidate = Path.Combine(root, subdirectory, AppName);
                if (IsHarness(candidate)) return candidate;
            }
        }
        return null;
    }

    private static bool IsHarness(string path)
    {
        return !String.IsNullOrWhiteSpace(path) && File.Exists(path)
            && String.Equals(Path.GetFileName(path), AppName, StringComparison.OrdinalIgnoreCase)
            && File.Exists(Path.Combine(Path.GetDirectoryName(path), "resources", "app.asar"));
    }

    private string ReadVersion()
    {
        var manifest = Path.Combine(profile, "node_modules", Plugin, "package.json");
        if (!File.Exists(manifest)) return null;
        var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
        return json["version"] as string;
    }

    private bool IsRegistered()
    {
        var manifest = Path.Combine(profile, "package.json");
        if (!File.Exists(manifest)) return false;
        var json = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
        object dependencies;
        return json.TryGetValue("dependencies", out dependencies) && dependencies is Dictionary<string, object>
            && ((Dictionary<string, object>)dependencies).ContainsKey(Plugin);
    }

    private static bool HarnessRunning()
    {
        var processes = Process.GetProcessesByName("DeepSeek Harness");
        foreach (var process in processes) process.Dispose();
        return processes.Length > 0;
    }

    private void Browse()
    {
        var picker = new OpenFileDialog {
            Title = "选择 DeepSeek Harness",
            Filter = "DeepSeek Harness (DeepSeek Harness.exe)|DeepSeek Harness.exe"
        };
        if (picker.ShowDialog(window) != true) return;
        executable = picker.FileName;
        Refresh(true);
    }

    private string RuntimeVersion()
    {
        var directory = Path.GetDirectoryName(executable);
        var archiveTime = File.GetLastWriteTimeUtc(Path.Combine(directory, @"resources\app.asar"));
        if (checkedExecutable == executable && checkedArchiveTime == archiveTime) return checkedVersion;
        string version = null;
        var start = new ProcessStartInfo(executable, "--expose-internals \"" + Path.Combine(directory, Cli) + "\" --version") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true
        };
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        try
        {
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                if (process.WaitForExit(5000) && process.ExitCode == 0) version = stdout.Result.Trim();
                else if (!process.HasExited) process.Kill();
            }
        }
        catch (System.ComponentModel.Win32Exception) { }
        checkedExecutable = executable;
        checkedArchiveTime = archiveTime;
        checkedVersion = String.IsNullOrWhiteSpace(version) ? "版本无法识别" : version;
        return checkedVersion;
    }

    private void Refresh(bool resetMessage)
    {
        var valid = IsHarness(executable);
        var version = valid ? RuntimeVersion() : "";
        var compatible = valid && version == SupportedVersion;
        var initialized = File.Exists(Path.Combine(profile, "package.json"));
        string current = null;
        bool registered = false;
        bool readable = true;
        try
        {
            current = ReadVersion();
            registered = IsRegistered();
        }
        catch (Exception error)
        {
            readable = false;
            if (resetMessage) ShowLog(error.Message);
        }
        var running = HarnessRunning();
        var installed = registered || current != null;
        Element<TextBox>("DshPath").Text = executable ?? "";
        Element<TextBlock>("DshStatus").Text = valid ? "检测到 DSH " + version : "请选择 DeepSeek Harness.exe";
        Element<TextBlock>("PluginStatus").Text = !readable ? "无法读取插件状态" : !initialized ? "尚未初始化"
            : current != null ? "已安装 v" + current : registered ? "已注册，插件文件缺失" : "未安装";
        Element<Button>("Install").Content = current == release ? "重新安装" : installed ? "安装此版本" : "安装插件";
        Element<Button>("Browse").IsEnabled = !busy;
        Element<Button>("Install").IsEnabled = !busy && compatible && initialized && readable && !running;
        Element<Button>("Uninstall").IsEnabled = !busy && valid && initialized && readable && installed && !running;
        Element<Button>("OpenDsh").IsEnabled = !busy && valid && !running;
        if (running && !busy)
            SetStatus("请先从系统托盘退出 DeepSeek Harness，退出后可继续安装或卸载。", false);
        else if (resetMessage || Element<TextBlock>("Status").Text.StartsWith("请先从系统托盘退出"))
            SetStatus(!readable ? "无法读取桌面配置，请查看操作日志。"
                : !valid ? "选择 DSH 安装程序所在目录中的可执行文件。"
                : !initialized ? "请先打开 DSH 一次以初始化桌面配置，然后退出。"
                : !compatible ? "此安装包适用于 DSH " + SupportedVersion + "。"
                : "安装和卸载仅作用于插件。原有会话和会话树数据会保留。", !readable);
    }

    private void SetStatus(string text, bool error)
    {
        Element<TextBlock>("Status").Text = text;
        Element<Border>("Notice").Background = (Brush)new BrushConverter().ConvertFromString(error ? "#F7E2E0" : "#E4EEEA");
    }

    private void ShowLog(string text)
    {
        Element<Expander>("Details").Visibility = Visibility.Visible;
        Element<Expander>("Details").IsExpanded = true;
        Element<TextBox>("Log").Text = text;
    }

    private void OpenHarness()
    {
        try
        {
            var start = new ProcessStartInfo(executable) { UseShellExecute = false };
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using (Process.Start(start)) { }
        }
        catch (Exception error)
        {
            ShowLog(error.Message);
            SetStatus("无法打开 DeepSeek Harness。", true);
        }
    }

    private async Task ChangePlugin(bool install)
    {
        Refresh(false);
        if (!Element<Button>(install ? "Install" : "Uninstall").IsEnabled) return;
        if (!install && MessageBox.Show(window, "确定卸载 DSH 会话树插件吗？原有会话和会话树数据会保留。",
              "确认卸载", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) != MessageBoxResult.Yes) return;
        if (HarnessRunning())
        {
            Refresh(false);
            return;
        }
        busy = true;
        Refresh(false);
        Element<ProgressBar>("Progress").Visibility = Visibility.Visible;
        Element<Expander>("Details").Visibility = Visibility.Collapsed;
        SetStatus(install ? "正在安装插件…" : "正在卸载插件…", false);
        try
        {
            var output = await Task.Run(() => ApplyChange(install));
            Element<TextBox>("Log").Text = output;
            Element<Expander>("Details").Visibility = Visibility.Visible;
            Element<Expander>("Details").IsExpanded = false;
            SetStatus(install ? "安装完成。现在可以打开 DSH。" : "卸载完成。会话及会话树数据已保留。", false);
        }
        catch (Exception error)
        {
            ShowLog(error.Message);
            SetStatus(install ? "安装失败，请查看操作日志。" : "卸载失败，请查看操作日志。", true);
        }
        finally
        {
            busy = false;
            Element<ProgressBar>("Progress").Visibility = Visibility.Collapsed;
            Refresh(false);
        }
    }

    private string ApplyChange(bool install)
    {
        if (HarnessRunning()) throw new InvalidOperationException("DeepSeek Harness 仍在运行，请退出后重试。");
        var argument = install ? PreparePackage() : Plugin;
        var cli = Path.Combine(Path.GetDirectoryName(executable), Cli);
        var arguments = "--expose-internals \"" + cli + "\" plugin --profile desktop "
            + (install ? "add" : "remove") + " \"" + argument + "\"";
        var start = new ProcessStartInfo(executable, arguments) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        using (var process = Process.Start(start))
        {
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            var log = (output.Result + Environment.NewLine + error.Result).Trim();
            if (process.ExitCode != 0) throw new InvalidOperationException("DSH 命令退出码 " + process.ExitCode + "\n" + log);
            if (install ? !IsRegistered() || ReadVersion() != release : IsRegistered() || ReadVersion() != null)
                throw new InvalidOperationException("DSH 返回成功，但桌面配置与预期不一致。\n" + log);
            return log;
        }
    }

    private string PreparePackage()
    {
        byte[] archive;
        using (var source = Bundle.GetManifestResourceStream("plugin.tgz"))
        using (var memory = new MemoryStream())
        {
            source.CopyTo(memory);
            archive = memory.ToArray();
        }
        string hash;
        using (var algorithm = SHA256.Create())
            hash = BitConverter.ToString(algorithm.ComputeHash(archive)).Replace("-", "");
        var cache = Path.Combine(profile, "session-tree-packages", hash.Substring(0, 16));
        Directory.CreateDirectory(cache);
        var target = Path.Combine(cache, Plugin + "-" + release + ".tgz");
        File.WriteAllBytes(target, archive);
        Directory.CreateDirectory(managerDirectory);
        File.WriteAllText(Path.Combine(managerDirectory, "harness-path.txt"), executable, Encoding.UTF8);
        return "file:" + target.Replace('\\', '/');
    }
}
