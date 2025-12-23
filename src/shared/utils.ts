import path from 'path';
import * as vscode from 'vscode';
import * as constants from './constants';

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, v: unknown) => {
        if (v instanceof vscode.Uri) {
          return v.toString();
        }
        return v;
      },
      2,
    );
  } catch (e) {
    return `<<failed to serialize debug configuration: ${String(e)}>>`;
  }
}

export function toWorkspaceRelativeDetail(uri: vscode.Uri): string {
  try {
    return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
  } catch {
    return uri.fsPath;
  }
}

export function hasDotnetStartLaunchConfiguration(
  configurations: readonly vscode.DebugConfiguration[],
  configurationName: string,
): boolean {
  return configurations.some(
    (c) =>
      c &&
      typeof c === 'object' &&
      c.name === configurationName &&
      c.type === 'coreclr' &&
      c.request === 'launch',
  );
}

export function normalizeFsPath(p: string): string {
  // Windows paths are case-insensitive; normalize for stable comparisons.
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function markDotnetStartResolved<T extends vscode.DebugConfiguration>(config: T): T {
  // VS Code will re-invoke resolveDebugConfiguration even for configurations passed to startDebugging.
  // Mark generated configs so our resolver can avoid re-building and causing duplicate dotnet builds.
  return { ...config, [constants.DOTNET_START_RESOLVED_FLAG]: true };
}

