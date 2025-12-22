import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createDotnetStartDebugConfigurationProvider,
  DOTNET_START_CONFIGURATION_NAME,
} from '../extension';

type AnyQuickPickItem = vscode.QuickPickItem & Record<string, unknown>;

async function ensureEmptyDir(dirUri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(dirUri, { recursive: true, useTrash: false });
  } catch {
    // ignore
  }
  await vscode.workspace.fs.createDirectory(dirUri);
}

async function writeTextFile(fileUri: vscode.Uri, contents: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fileUri.fsPath)));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(contents, 'utf8'));
}

function getWorkspaceRoot(): vscode.WorkspaceFolder {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(wsFolder, 'Expected a workspace folder to be open during extension tests.');
  return wsFolder;
}

suite('dotnet-start extension', () => {
  let fixtureRoot: vscode.Uri;
  let csprojUri: vscode.Uri;
  let launchSettingsUri: vscode.Uri;

  setup(async () => {
    const wsFolder = getWorkspaceRoot();
    fixtureRoot = vscode.Uri.joinPath(wsFolder.uri, 'out', 'test-fixtures', 'dotnet-start');
    await ensureEmptyDir(fixtureRoot);

    csprojUri = vscode.Uri.joinPath(fixtureRoot, 'App', 'App.csproj');
    launchSettingsUri = vscode.Uri.joinPath(fixtureRoot, 'App', 'Properties', 'launchSettings.json');

    await writeTextFile(
      csprojUri,
      [...
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <OutputType>Exe</OutputType>',
        '    <TargetFramework>net8.0</TargetFramework>',
        '  </PropertyGroup>',
        '</Project>',
      ].join('\n'),
    );

    await writeTextFile(
      launchSettingsUri,
      JSON.stringify(
        {
          profiles: {
            Dev: {
              commandName: 'Project',
            },
            Prod: {
              commandName: 'Project',
            },
          },
        },
        null,
        2,
      ),
    );
  });

  teardown(async () => {
    if (fixtureRoot) {
      try {
        await vscode.workspace.fs.delete(fixtureRoot, { recursive: true, useTrash: false });
      } catch {
        // ignore
      }
    }
  });

  test('dotnetStart.start starts coreclr debugging with dotnet run args', async () => {
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;

    let capturedFolder: vscode.WorkspaceFolder | undefined;
    let capturedConfig: vscode.DebugConfiguration | undefined;
    let quickPickCalls = 0;
    let actionPickerCalls = 0;

    try {
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = (() => {
        actionPickerCalls++;

        let onDidAcceptHandler: (() => void) | undefined;
        let onDidHideHandler: (() => void) | undefined;

        const quickPick = {
          items: [] as AnyQuickPickItem[],
          activeItems: [] as AnyQuickPickItem[],
          selectedItems: [] as AnyQuickPickItem[],
          title: undefined as unknown,
          placeholder: undefined as unknown,
          onDidAccept: (cb: () => void) => {
            onDidAcceptHandler = cb;
            return { dispose: () => undefined };
          },
          onDidHide: (cb: () => void) => {
            onDidHideHandler = cb;
            return { dispose: () => undefined };
          },
          onDidDispose: (_cb: () => void) => {
            return { dispose: () => undefined };
          },
          show: () => {
            quickPick.selectedItems = [quickPick.activeItems[0] ?? quickPick.items[0]].filter(Boolean) as AnyQuickPickItem[];
            onDidAcceptHandler?.();
            onDidHideHandler?.();
          },
          dispose: () => undefined,
        };

        return quickPick as unknown;
      }) as unknown;

      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (async (
        items: readonly AnyQuickPickItem[],
      ) => {
        quickPickCalls++;
        assert.ok(items.length > 0, 'Expected QuickPick items.');

        const first = items[0];
        if (typeof first === 'object' && first && 'uri' in first) {
          const match = items.find((i) =>
            typeof i === 'object' &&
            i &&
            'uri' in i &&
            (i as unknown as { uri: vscode.Uri }).uri.fsPath === csprojUri.fsPath,
          );
          return (match ?? first) as unknown;
        }

        if (typeof first === 'object' && first && 'profileName' in first) {
          const match = items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Dev');
          return (match ?? first) as unknown;
        }

        return first as unknown;
      }) as unknown;

      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async (
        folder: vscode.WorkspaceFolder,
        config: vscode.DebugConfiguration,
      ) => {
        capturedFolder = folder;
        capturedConfig = config;
        return true;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.start');

      assert.strictEqual(actionPickerCalls, 1, 'Expected one action picker.');
      assert.ok(quickPickCalls >= 2, 'Expected csproj + profile QuickPick prompts.');
      assert.ok(capturedFolder, 'Expected a workspace folder passed to startDebugging.');
      assert.ok(capturedConfig, 'Expected a debug configuration passed to startDebugging.');

      assert.strictEqual(capturedConfig.type, 'coreclr');
      assert.strictEqual(capturedConfig.request, 'launch');
      assert.strictEqual(capturedConfig.program, 'dotnet');
      assert.strictEqual(capturedConfig.console, 'integratedTerminal');
      assert.strictEqual(capturedConfig.cwd, path.dirname(csprojUri.fsPath));

      assert.deepStrictEqual(capturedConfig.args, ['run', '--project', csprojUri.fsPath, '--launch-profile', 'Dev']);
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
    }
  });

  test('dotnetStart.start run-once action uses the active (highlighted) item and prompts for a one-off profile', async () => {
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;

    let capturedConfig: vscode.DebugConfiguration | undefined;
    let sawOneOffProfileTitle = false;

    try {
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = (() => {
        let onDidAcceptHandler: (() => void) | undefined;
        let onDidHideHandler: (() => void) | undefined;

        const quickPick = {
          items: [] as AnyQuickPickItem[],
          activeItems: [] as AnyQuickPickItem[],
          selectedItems: [] as AnyQuickPickItem[],
          title: undefined as unknown,
          placeholder: undefined as unknown,
          onDidAccept: (cb: () => void) => {
            onDidAcceptHandler = cb;
            return { dispose: () => undefined };
          },
          onDidHide: (cb: () => void) => {
            onDidHideHandler = cb;
            return { dispose: () => undefined };
          },
          onDidDispose: (_cb: () => void) => {
            return { dispose: () => undefined };
          },
          show: () => {
            // Simulate the user moving the highlight to the second action,
            // but with selectedItems remaining empty (real VS Code can behave this way).
            quickPick.activeItems = [quickPick.items[1] ?? quickPick.items[0]].filter(Boolean) as AnyQuickPickItem[];
            onDidAcceptHandler?.();
            onDidHideHandler?.();
          },
          dispose: () => undefined,
        };

        return quickPick as unknown;
      }) as unknown;

      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (async (
        items: readonly AnyQuickPickItem[],
        options?: vscode.QuickPickOptions,
      ) => {
        assert.ok(items.length > 0, 'Expected QuickPick items.');

        const first = items[0];
        if (typeof first === 'object' && first && 'uri' in first) {
          const match = items.find((i) =>
            typeof i === 'object' &&
            i &&
            'uri' in i &&
            (i as unknown as { uri: vscode.Uri }).uri.fsPath === csprojUri.fsPath,
          );
          return (match ?? first) as unknown;
        }

        if (typeof first === 'object' && first && 'profileName' in first) {
          if (options?.title?.includes('(once)')) {
            sawOneOffProfileTitle = true;
          }
          const match = items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Dev');
          return (match ?? first) as unknown;
        }

        return first as unknown;
      }) as unknown;

      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async (
        _folder: vscode.WorkspaceFolder,
        config: vscode.DebugConfiguration,
      ) => {
        capturedConfig = config;
        return true;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.start');

      assert.ok(sawOneOffProfileTitle, 'Expected the one-off profile QuickPick title to be used.');
      assert.ok(capturedConfig, 'Expected a debug configuration passed to startDebugging.');
      assert.deepStrictEqual(capturedConfig.args, ['run', '--project', csprojUri.fsPath, '--launch-profile', 'Dev']);
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
    }
  });

  test('dotnetStart.addLaunchConfiguration adds a dotnet-start entry to launch configurations', async () => {
    const originalGetConfiguration = vscode.workspace.getConfiguration;
    const originalShowInformationMessage = vscode.window.showInformationMessage;

    type LaunchConfigStore = {
      version?: unknown;
      configurations?: vscode.DebugConfiguration[];
    };

    const store: LaunchConfigStore = {
      version: '0.2.0',
      configurations: [],
    };

    let updateCalls = 0;
    let infoCalls = 0;

    try {
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = ((): unknown => {
        return {
          get: (section: string) => {
            if (section === 'configurations') {
              return store.configurations;
            }
            if (section === 'version') {
              return store.version;
            }
            return undefined;
          },
          update: async (section: string, value: unknown) => {
            updateCalls++;
            if (section === 'configurations') {
              store.configurations = value as vscode.DebugConfiguration[];
            }
            if (section === 'version') {
              store.version = value;
            }
            return undefined;
          },
        };
      }) as unknown;

      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (async () => {
        infoCalls++;
        return undefined;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.addLaunchConfiguration');

      assert.ok(updateCalls >= 1, 'Expected at least one configuration update call.');
      assert.ok(infoCalls >= 1, 'Expected an informational message after the update.');

      const configs = store.configurations ?? [];
      const dotnetStart = configs.find((c) => c.name === DOTNET_START_CONFIGURATION_NAME);
      assert.ok(dotnetStart, 'Expected dotnet-start configuration to be present.');
      assert.strictEqual(dotnetStart?.type, 'coreclr');
      assert.strictEqual(dotnetStart?.request, 'launch');
    } finally {
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = originalGetConfiguration as unknown;
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        originalShowInformationMessage as unknown;
    }
  });

  test('provides a dotnet-start debug configuration option', async () => {
    const fakeContext = {
      workspaceState: {
        get: () => undefined,
        update: async () => undefined,
      },
    } as unknown as vscode.ExtensionContext;

    const provider = createDotnetStartDebugConfigurationProvider(fakeContext);
    assert.ok(provider.provideDebugConfigurations, 'Expected provider.provideDebugConfigurations to be defined.');

    const configs = await provider.provideDebugConfigurations(undefined);
    assert.ok(Array.isArray(configs), 'Expected an array of debug configurations.');

    const dotnetStart = configs.find((c) => c?.name === DOTNET_START_CONFIGURATION_NAME);
    assert.ok(dotnetStart, 'Expected a debug configuration named dotnet-start.');
    assert.strictEqual(dotnetStart.type, 'coreclr');
    assert.strictEqual(dotnetStart.request, 'launch');
  });

  test('dotnetStart.selectStartProject shows error when no .csproj exists', async () => {
    await ensureEmptyDir(fixtureRoot);
    const csprojs = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules,.git,.vs}/**');
    assert.strictEqual(csprojs.length, 0, 'Expected the workspace to contain no .csproj files for this test.');

    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalShowErrorMessage = vscode.window.showErrorMessage;

    let errorMessage: string | undefined;
    try {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (async () => {
        assert.fail('Expected showQuickPick not to be called when no .csproj exists.');
      }) as unknown;

      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (async (message: string) => {
        errorMessage = message;
        return undefined;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.selectStartProject');

      assert.strictEqual(errorMessage, 'No .csproj files found in this workspace.');
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = originalShowErrorMessage as unknown;
    }
  });

  test('dotnetStart.selectStartProject shows which .csproj is current', async () => {
    const originalShowQuickPick = vscode.window.showQuickPick;

    let callIndex = 0;
    let secondCallSawCurrentLabel = false;
    let secondCallCurrentIsFirstItem = false;

    try {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (async (
        items: readonly AnyQuickPickItem[],
        _options?: vscode.QuickPickOptions,
      ) => {
        callIndex++;

        const csprojItems = items.filter((i) => typeof i === 'object' && i && 'uri' in i) as Array<
          AnyQuickPickItem & { uri: vscode.Uri; description?: string }
        >;
        assert.ok(csprojItems.length > 0, 'Expected .csproj QuickPick items.');

        const target = csprojItems.find((i) => i.uri.fsPath === csprojUri.fsPath);
        assert.ok(target, 'Expected the fixture csproj to appear in QuickPick items.');

        if (callIndex === 2) {
          secondCallSawCurrentLabel = target.description === 'Current';
          secondCallCurrentIsFirstItem = csprojItems[0]?.uri.fsPath === csprojUri.fsPath;
        }

        // Always pick the fixture csproj.
        return target as unknown;
      }) as unknown;

      // First selection sets workspaceState.
      await vscode.commands.executeCommand('dotnetStart.selectStartProject');
      // Second selection should indicate the current project.
      await vscode.commands.executeCommand('dotnetStart.selectStartProject');

      assert.ok(secondCallSawCurrentLabel, 'Expected the current .csproj to be labeled as Current.');
      assert.ok(secondCallCurrentIsFirstItem, 'Expected the current .csproj to be the first item.');
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
    }
  });
});
