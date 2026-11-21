import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { translator } from './i18n.ts'

const run = promisify(execFile)

export async function sessionTrashPath(log: string, t = translator()): Promise<string> {
  const root = resolve(dshHomePath('sessions'))
  const path = resolve(log)
  const parts = relative(root, path).split(sep)
  if (parts.length !== 3 || parts[0] === '..' || isAbsolute(relative(root, path))
    || !/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(parts[2])) {
    throw new Error(t('The session is outside the local DSH log directory.', '此会话不在 DSH 的本地日志目录中'))
  }
  const folder = dirname(path)
  for (const candidate of [root, dirname(folder), folder, path]) {
    const resolved = await realpath(candidate)
    if (resolved.toLowerCase() !== candidate.toLowerCase()
      || (await lstat(candidate)).isSymbolicLink()) throw new Error(t('The session log path resolves to a different location.', '会话存储路径指向了其他位置'))
  }
  return folder
}

export async function recycleSessionDirectory(folder: string): Promise<void> {
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshRecycle {
  [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOperation {
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage(IntPtr message);
    void SetProgressDialog(IntPtr dialog);
    void SetProperties(IntPtr properties);
    void SetOwnerWindow(IntPtr window);
    void ApplyPropertiesToItem(IntPtr item);
    void ApplyPropertiesToItems(IntPtr items);
    void RenameItem(IntPtr item, IntPtr name, IntPtr sink);
    void RenameItems(IntPtr items, IntPtr name);
    void MoveItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
    void MoveItems(IntPtr items, IntPtr destination);
    void CopyItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
    void CopyItems(IntPtr items, IntPtr destination);
    void DeleteItem(IntPtr item, IntPtr sink);
    void DeleteItems(IntPtr items);
    void NewItem(IntPtr destination, uint attributes, IntPtr name, IntPtr template, IntPtr sink);
    void PerformOperations();
    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, out IntPtr item);

  public static void MoveToRecycleBin(string path) {
    var shellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
    IntPtr item;
    Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item));
    try {
      var clsid = new Guid("3AD05575-8857-4850-9277-11B85BDB8E09");
      var operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
      try {
        const uint recycle = 0x00080000, earlyFailure = 0x00100000, noErrorUi = 0x0400, silent = 0x0004;
        operation.SetOperationFlags(recycle | earlyFailure | noErrorUi | silent);
        operation.DeleteItem(item, IntPtr.Zero);
        operation.PerformOperations();
        bool aborted;
        operation.GetAnyOperationsAborted(out aborted);
        if (aborted || System.IO.Directory.Exists(path)) throw new InvalidOperationException("Windows did not move the session to the Recycle Bin.");
      } finally {
        Marshal.ReleaseComObject(operation);
      }
    } finally {
      Marshal.Release(item);
    }
  }
}
'@
    [DshRecycle]::MoveToRecycleBin($env:DSH_SESSION_TREE_RECYCLE_PATH)
  `
  const executable = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', script],
    { env: { ...process.env, DSH_SESSION_TREE_RECYCLE_PATH: folder }, windowsHide: true, timeout: 30000 })
}
