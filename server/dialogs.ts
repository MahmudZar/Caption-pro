/**
 * Native Windows file dialogs through PowerShell (WinForms). The browser can't learn a file's
 * real path, but a local app wants to read the original video in place (no copy) and write the
 * export next to it. On other systems these return null and the UI falls back to typed paths.
 */
import { spawn } from "node:child_process";

function powershell(script: string): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
      resolve(line ? line : null);
    });
    child.stdin.end(script);
  });
}

/** Single-quoted PowerShell string. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// A hidden top-most form as the owner keeps the dialog in front of the browser window.
const OWNER = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Show()
$owner.Hide()
`;

export function openFileDialog(options: { title: string; filter: string; initialDir?: string }): Promise<string | null> {
  return powershell(`${OWNER}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = ${ps(options.title)}
$d.Filter = ${ps(options.filter)}
${options.initialDir ? `$d.InitialDirectory = ${ps(options.initialDir)}` : ""}
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
$owner.Dispose()
`);
}

export function saveFileDialog(options: { title: string; filter: string; fileName: string; initialDir?: string; defaultExt: string }): Promise<string | null> {
  return powershell(`${OWNER}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.Title = ${ps(options.title)}
$d.Filter = ${ps(options.filter)}
$d.FileName = ${ps(options.fileName)}
$d.DefaultExt = ${ps(options.defaultExt)}
$d.AddExtension = $true
$d.OverwritePrompt = $true
${options.initialDir ? `$d.InitialDirectory = ${ps(options.initialDir)}` : ""}
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
$owner.Dispose()
`);
}

/** Opens Explorer with the file selected. */
export function revealInExplorer(filePath: string): void {
  if (process.platform !== "win32") return;
  spawn("explorer.exe", [`/select,${filePath}`], { windowsHide: false, detached: true }).unref();
}
