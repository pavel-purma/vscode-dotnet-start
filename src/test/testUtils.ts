import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function patchProp<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): () => void {
  const mutable = target as unknown as Mutable<T>;
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
  const hadOwnDescriptor = Boolean(originalDescriptor);
  const originalValue = mutable[key];

  try {
    mutable[key] = value;
  } catch {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? true,
      writable: true,
      value,
    });
  }

  return () => {
    if (hadOwnDescriptor && originalDescriptor) {
      Object.defineProperty(target, key, originalDescriptor);
      return;
    }

    try {
      delete (target as Record<string, unknown>)[key as unknown as string];
    } catch {
      // ignore
    }

    try {
      (mutable as Record<string, unknown>)[key as unknown as string] = originalValue as unknown;
    } catch {
      // ignore
    }
  };
}

export async function ensureEmptyDir(dirUri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: false });
  } catch {
    // ignore
  }
  await vscode.workspace.fs.createDirectory(dirUri);
}

export async function writeTextFile(fileUri: vscode.Uri, contents: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fileUri.fsPath)));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(contents, 'utf8'));
}

export function getWorkspaceRoot(): vscode.WorkspaceFolder {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(wsFolder, 'Expected a workspace folder to be open during extension tests.');
  return wsFolder;
}
