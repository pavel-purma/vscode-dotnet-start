# Opens the VS Code instance used by `vscode-test --label resharper`, with its own user-data and
# extensions directories, so one-time ReSharper prompts (licence, usage statistics) can be
# accepted once and then persist for automated runs.
$root = Split-Path -Parent $PSScriptRoot
$code = Get-ChildItem (Join-Path $root '.vscode-test') -Directory -Filter 'vscode-win32-x64-archive-*' |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $code) { throw 'Run the resharper tests once first so VS Code is downloaded.' }

& (Join-Path $code.FullName 'Code.exe') `
  --user-data-dir (Join-Path $root '.vscode-test\user-data') `
  --extensions-dir (Join-Path $root '.vscode-test\extensions') `
  (Join-Path $root 'test-fixtures\resharper-app')
