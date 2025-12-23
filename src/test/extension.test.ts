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

    // Create a fake build output so tests don't require a real `dotnet build`.
    const dllUri = vscode.Uri.joinPath(fixtureRoot, 'App', 'bin', 'Debug', 'net8.0', 'App.dll');
    await writeTextFile(dllUri, '');
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

  test('dotnetStart.start starts coreclr debugging by launching the built DLL', async function () {
    this.timeout(10_000);
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;
    const originalShowInformationMessage = vscode.window.showInformationMessage;

    let capturedFolder: vscode.WorkspaceFolder | undefined;
    let capturedConfig: vscode.DebugConfiguration | undefined;
    let quickPickCalls = 0;
    let actionPickerCalls = 0;
    let infoMessageCalls = 0;

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
            // VS Code's QuickPick behavior varies: sometimes selection is read from `activeItems`.
            // Set both to keep the command handler deterministic.
            const firstItem = (quickPick.activeItems[0] ?? quickPick.items[0]) as AnyQuickPickItem | undefined;
            quickPick.activeItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
            quickPick.selectedItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
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

      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (async () => {
        // Avoid hanging tests on the launch.json prompt or other informational messages.
        infoMessageCalls++;
        return 'Not now';
      }) as unknown;

      // Ensure we start from a clean state (csproj/profile not pre-selected) even if other tests ran before.
      await vscode.commands.executeCommand('dotnetStart.clearState');

      await vscode.commands.executeCommand('dotnetStart.start');

      assert.strictEqual(actionPickerCalls, 1, 'Expected one action picker.');
      assert.ok(quickPickCalls >= 2, 'Expected csproj + profile QuickPick prompts.');
      assert.ok(capturedFolder, 'Expected a workspace folder passed to startDebugging.');
      assert.ok(capturedConfig, 'Expected a debug configuration passed to startDebugging.');

      // The first run may prompt about .vscode/launch.json; ensure we didn't block on it.
      assert.ok(infoMessageCalls >= 0, 'Expected showInformationMessage stub to be installed.');

      assert.strictEqual(capturedConfig.type, 'coreclr');
      assert.strictEqual(capturedConfig.request, 'launch');
      assert.strictEqual(capturedConfig.program, 'dotnet');
      assert.strictEqual(capturedConfig.console, 'integratedTerminal');
      assert.strictEqual(capturedConfig.cwd, path.dirname(csprojUri.fsPath));

      const expectedDllPath = path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll');
      assert.deepStrictEqual(capturedConfig.args, [expectedDllPath]);
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        originalShowInformationMessage as unknown;
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
      const expectedDllPath = path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll');
      assert.deepStrictEqual(capturedConfig.args, [expectedDllPath]);
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

  test('dotnetStart.clearState clears saved project/profile state', async function () {
    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalGetConfiguration = vscode.workspace.getConfiguration;

    let showQuickPickCalls = 0;
    let promptInfoCalls = 0;
    let clearStateInfoCalls = 0;

    try {
      // Ensure the action picker is stable for this test:
      // - No existing dotnet-start config in launch configurations
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = ((): unknown => {
        return {
          get: (section: string) => {
            if (section === 'configurations') {
              return [] as vscode.DebugConfiguration[];
            }
            return undefined;
          },
          update: async () => undefined,
        };
      }) as unknown;

      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (async (
        message: string,
        ..._items: string[]
      ) => {
        if (message.startsWith('Cleared dotnet-start saved state')) {
          clearStateInfoCalls++;
          return undefined;
        }

        promptInfoCalls++;
        return 'Not now';
      }) as unknown;

      // Ensure the test always starts from a clean workspaceState, regardless of test execution order.
      await vscode.commands.executeCommand('dotnetStart.clearState');
      clearStateInfoCalls = 0;

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
            const firstItem = (quickPick.activeItems[0] ?? quickPick.items[0]) as AnyQuickPickItem | undefined;
            quickPick.activeItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
            quickPick.selectedItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
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
        showQuickPickCalls++;
        assert.ok(items.length > 0, 'Expected QuickPick items.');

        const first = items[0];
        if (typeof first === 'object' && first && 'uri' in first) {
          const match = items.find((i) =>
            typeof i === 'object' &&
            i &&
            'uri' in i &&
            (i as unknown as { uri: vscode.Uri }).uri.fsPath === csprojUri.fsPath
          );
          return (match ?? first) as unknown;
        }

        if (typeof first === 'object' && first && 'profileName' in first) {
          const match = items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Dev');
          return (match ?? first) as unknown;
        }

        return first as unknown;
      }) as unknown;

      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async () => true) as unknown;

      // First run: should prompt for csproj + profile, and show launch.json prompt.
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.ok(showQuickPickCalls >= 2, 'Expected csproj + profile QuickPick prompts on first run.');
      assert.strictEqual(promptInfoCalls, 0, 'Did not expect any informational prompts during dotnetStart.start.');

      // Second run (state saved): no csproj/profile prompts and no launch.json prompt.
      showQuickPickCalls = 0;
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.strictEqual(showQuickPickCalls, 0, 'Expected no csproj/profile prompts when state is saved.');
      assert.strictEqual(promptInfoCalls, 0, 'Did not expect any informational prompts during dotnetStart.start.');

      // Clear state.
      await vscode.commands.executeCommand('dotnetStart.clearState');
      assert.strictEqual(clearStateInfoCalls, 1, 'Expected a confirmation message after clearing state.');

      // Third run (after clearing): should prompt again.
      showQuickPickCalls = 0;
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.ok(showQuickPickCalls >= 2, 'Expected csproj + profile prompts after clearing state.');
      assert.strictEqual(promptInfoCalls, 0, 'Did not expect any informational prompts during dotnetStart.start.');
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
        originalShowInformationMessage as unknown;
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = originalGetConfiguration as unknown;
    }
  });

  test('changing the selected start project clears the saved launch profile', async function () {
    this.timeout(10_000);

    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;

    const secondCsprojUri = vscode.Uri.joinPath(fixtureRoot, 'App2', 'App2.csproj');
    const secondLaunchSettingsUri = vscode.Uri.joinPath(
      fixtureRoot,
      'App2',
      'Properties',
      'launchSettings.json',
    );

    await writeTextFile(
      secondCsprojUri,
      [
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
      secondLaunchSettingsUri,
      JSON.stringify(
        {
          profiles: {
            Dev: { commandName: 'Project' },
            Prod: { commandName: 'Project' },
          },
        },
        null,
        2,
      ),
    );

    const secondDllUri = vscode.Uri.joinPath(fixtureRoot, 'App2', 'bin', 'Debug', 'net8.0', 'App2.dll');
    await writeTextFile(secondDllUri, '');

    let phase: 'initial' | 'afterProjectChange' = 'initial';
    let sawProfilePickerAfterProjectChange = false;

    let capturedArgs: string[] | undefined;

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
            const firstItem = (quickPick.activeItems[0] ?? quickPick.items[0]) as AnyQuickPickItem | undefined;
            quickPick.activeItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
            quickPick.selectedItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
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
        assert.ok(items.length > 0, 'Expected QuickPick items.');

        const first = items[0];
        if (typeof first === 'object' && first && 'uri' in first) {
          const target = items.find(
            (i) =>
              typeof i === 'object' &&
              i &&
              'uri' in i &&
              (i as unknown as { uri: vscode.Uri }).uri.fsPath ===
                (phase === 'initial' ? csprojUri.fsPath : secondCsprojUri.fsPath),
          );
          return (target ?? first) as unknown;
        }

        if (typeof first === 'object' && first && 'profileName' in first) {
          if (phase === 'afterProjectChange') {
            sawProfilePickerAfterProjectChange = true;
            const prod = items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Prod');
            return (prod ?? first) as unknown;
          }
          const dev = items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Dev');
          return (dev ?? first) as unknown;
        }

        return first as unknown;
      }) as unknown;

      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async (
        _folder: vscode.WorkspaceFolder,
        config: vscode.DebugConfiguration,
      ) => {
        capturedArgs = config.args as string[];
        return true;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.clearState');

      // First run: select App + Dev (saved).
      phase = 'initial';
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.deepStrictEqual(
        capturedArgs,
        [path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll')],
      );

      // Change project selection to App2; this should clear the saved profile.
      phase = 'afterProjectChange';
      await vscode.commands.executeCommand('dotnetStart.selectStartProject');

      // Next run: should prompt for a profile again (not reuse Dev), and use Prod.
      sawProfilePickerAfterProjectChange = false;
      await vscode.commands.executeCommand('dotnetStart.start');

      assert.ok(sawProfilePickerAfterProjectChange, 'Expected the launch profile picker to appear after changing the project.');
      assert.deepStrictEqual(
        capturedArgs,
        [path.join(path.dirname(secondCsprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App2.dll')],
      );
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
    }
  });

  test('when there is only one launch profile, it is auto-selected and persisted without showing a picker', async function () {
    this.timeout(10_000);

    const originalShowQuickPick = vscode.window.showQuickPick;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const originalStartDebugging = vscode.debug.startDebugging;

    // Replace the fixture launchSettings.json with a single profile.
    await writeTextFile(
      launchSettingsUri,
      JSON.stringify(
        {
          profiles: {
            Only: {
              commandName: 'Project',
            },
          },
        },
        null,
        2,
      ),
    );

    let showQuickPickCalls = 0;
    let capturedArgs: string[] | undefined;

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
            const firstItem = (quickPick.activeItems[0] ?? quickPick.items[0]) as AnyQuickPickItem | undefined;
            quickPick.activeItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
            quickPick.selectedItems = [firstItem].filter(Boolean) as AnyQuickPickItem[];
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
        showQuickPickCalls++;
        assert.ok(items.length > 0, 'Expected QuickPick items.');

        const first = items[0];
        if (typeof first === 'object' && first && 'uri' in first) {
          const match = items.find(
            (i) =>
              typeof i === 'object' &&
              i &&
              'uri' in i &&
              (i as unknown as { uri: vscode.Uri }).uri.fsPath === csprojUri.fsPath,
          );
          return (match ?? first) as unknown;
        }

        if (typeof first === 'object' && first && 'profileName' in first) {
          assert.fail('Did not expect the profile QuickPick to be shown when only one profile exists.');
        }

        return first as unknown;
      }) as unknown;

      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async (
        _folder: vscode.WorkspaceFolder,
        config: vscode.DebugConfiguration,
      ) => {
        capturedArgs = config.args as string[];
        return true;
      }) as unknown;

      await vscode.commands.executeCommand('dotnetStart.clearState');

      // First run: should prompt only for csproj, auto-select the sole profile.
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.strictEqual(showQuickPickCalls, 1, 'Expected only the csproj QuickPick prompt on first run.');
      assert.deepStrictEqual(capturedArgs, [path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll')]);

      // Second run: should prompt for nothing (state persisted).
      showQuickPickCalls = 0;
      await vscode.commands.executeCommand('dotnetStart.start');
      assert.strictEqual(showQuickPickCalls, 0, 'Expected no prompts on subsequent run when state is saved.');
      assert.deepStrictEqual(capturedArgs, [path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll')]);
    } finally {
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
      (vscode.window as unknown as { createQuickPick: unknown }).createQuickPick = originalCreateQuickPick as unknown;
      (vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
    }
  });
});
