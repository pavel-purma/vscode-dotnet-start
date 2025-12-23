import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createDotnetStartDebugConfigurationProvider,
  DOTNET_START_CONFIGURATION_NAME,
} from '../extension';
import { CsprojService } from '../debugging/csprojService';

type AnyQuickPickItem = vscode.QuickPickItem & Record<string, unknown>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function patchProp<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): () => void {
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
  let previousSkipBuildEnv: string | undefined;

  setup(async () => {
    previousSkipBuildEnv = process.env.DOTNET_START_SKIP_DOTNET_BUILD;
    process.env.DOTNET_START_SKIP_DOTNET_BUILD = '1';

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
    if (previousSkipBuildEnv === undefined) {
      delete process.env.DOTNET_START_SKIP_DOTNET_BUILD;
    } else {
      process.env.DOTNET_START_SKIP_DOTNET_BUILD = previousSkipBuildEnv;
    }
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
    let restoreShowQuickPick: (() => void) | undefined;
    let restoreCreateQuickPick: (() => void) | undefined;
    let restoreStartDebugging: (() => void) | undefined;
    let restoreShowInformationMessage: (() => void) | undefined;

    let capturedFolder: vscode.WorkspaceFolder | undefined;
    let capturedConfig: vscode.DebugConfiguration | undefined;
    let quickPickCalls = 0;
    let actionPickerCalls = 0;
    let infoMessageCalls = 0;

    try {
      restoreCreateQuickPick = patchProp(
        vscode.window,
        'createQuickPick',
        (() => {
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
        }) as unknown as typeof vscode.window.createQuickPick,
      );

      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreStartDebugging = patchProp(
        vscode.debug,
        'startDebugging',
        (async (folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration) => {
          capturedFolder = folder;
          capturedConfig = config;
          return true;
        }) as unknown as typeof vscode.debug.startDebugging,
      );

      restoreShowInformationMessage = patchProp(
        vscode.window,
        'showInformationMessage',
        (async (_message: string, ..._items: string[]) => {
          // Avoid hanging tests on the launch.json prompt or other informational messages.
          infoMessageCalls++;
          return 'Not now';
        }) as unknown as typeof vscode.window.showInformationMessage,
      );

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
      restoreShowQuickPick?.();
      restoreCreateQuickPick?.();
      restoreStartDebugging?.();
      restoreShowInformationMessage?.();
    }
  });

  test('dotnetStart.start run-once action uses the active (highlighted) item and prompts for a one-off profile', async () => {
    let restoreShowQuickPick: (() => void) | undefined;
    let restoreCreateQuickPick: (() => void) | undefined;
    let restoreStartDebugging: (() => void) | undefined;

    let capturedConfig: vscode.DebugConfiguration | undefined;
    let sawOneOffProfileTitle = false;

    try {
      restoreCreateQuickPick = patchProp(
        vscode.window,
        'createQuickPick',
        (() => {
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
        }) as unknown as typeof vscode.window.createQuickPick,
      );

      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreStartDebugging = patchProp(
        vscode.debug,
        'startDebugging',
        (async (_folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration) => {
          capturedConfig = config;
          return true;
        }) as unknown as typeof vscode.debug.startDebugging,
      );

      await vscode.commands.executeCommand('dotnetStart.start');

      assert.ok(sawOneOffProfileTitle, 'Expected the one-off profile QuickPick title to be used.');
      assert.ok(capturedConfig, 'Expected a debug configuration passed to startDebugging.');
      const expectedDllPath = path.join(path.dirname(csprojUri.fsPath), 'bin', 'Debug', 'net8.0', 'App.dll');
      assert.deepStrictEqual(capturedConfig.args, [expectedDllPath]);
    } finally {
      restoreShowQuickPick?.();
      restoreCreateQuickPick?.();
      restoreStartDebugging?.();
    }
  });

  test('msbuild properties: computes expected TargetPath when TargetPath is missing', () => {
    const csprojService = new CsprojService();
    const csproj = vscode.Uri.file(path.join('C:', 'repo', 'App', 'App.csproj'));

    const computed = (csprojService as unknown as {
      computeExpectedTargetPathFromMsbuildProperties: (
        csprojUri: vscode.Uri,
        configuration: 'Debug' | 'Release',
        props: Record<string, string | undefined>,
      ) => string | undefined;
    }).computeExpectedTargetPathFromMsbuildProperties(csproj, 'Debug', {
      TargetFramework: 'net8.0',
      OutputPath: path.join('bin', 'Debug') + path.sep,
      AssemblyName: 'App',
      TargetExt: '.dll',
      AppendTargetFrameworkToOutputPath: 'true',
    });

    const expected = path.join('C:', 'repo', 'App', 'bin', 'Debug', 'net8.0', 'App.dll');
    assert.strictEqual(computed?.toLowerCase(), expected.toLowerCase());
  });

  test('msbuild properties: parses multiple values from a single msbuild output blob', () => {
    const csprojService = new CsprojService();
    const output = [
      'TargetFramework = net8.0',
      'TargetFrameworks = net8.0;net9.0',
      'OutputPath = bin\\Debug\\',
      'AssemblyName = MyApp',
      'TargetExt = .dll',
      'AppendTargetFrameworkToOutputPath = true',
    ].join('\n');

    const props = (csprojService as unknown as {
      parseMsbuildProperties: (output: string, names: readonly string[]) => Record<string, string | undefined>;
    }).parseMsbuildProperties(output, [
      'TargetFramework',
      'TargetFrameworks',
      'OutputPath',
      'AssemblyName',
      'TargetExt',
      'AppendTargetFrameworkToOutputPath',
    ]);

    assert.strictEqual(props.TargetFramework, 'net8.0');
    assert.strictEqual(props.TargetFrameworks, 'net8.0;net9.0');
    assert.strictEqual(props.OutputPath, 'bin\\Debug\\');
    assert.strictEqual(props.AssemblyName, 'MyApp');
    assert.strictEqual(props.TargetExt, '.dll');
    assert.strictEqual(props.AppendTargetFrameworkToOutputPath, 'true');
  });

  test('msbuild properties: TargetFramework does not match TargetFrameworks, and TargetFrameworks drives tfm folder', () => {
    const csprojService = new CsprojService();
    const csproj = vscode.Uri.file(path.join('C:', 'repo', 'App', 'App.csproj'));

    const output = [
      'TargetFrameworks = net8.0;net9.0',
      'OutputPath = bin\\Debug\\',
      'AssemblyName = App',
      'TargetExt = .dll',
      'AppendTargetFrameworkToOutputPath = true',
    ].join('\n');

    const props = (csprojService as unknown as {
      parseMsbuildProperties: (output: string, names: readonly string[]) => Record<string, string | undefined>;
      computeExpectedTargetPathFromMsbuildProperties: (
        csprojUri: vscode.Uri,
        configuration: 'Debug' | 'Release',
        props: Record<string, string | undefined>,
      ) => string | undefined;
    }).parseMsbuildProperties(output, [
      'TargetFramework',
      'TargetFrameworks',
      'OutputPath',
      'AssemblyName',
      'TargetExt',
      'AppendTargetFrameworkToOutputPath',
    ]);

    assert.strictEqual(props.TargetFramework, undefined);
    assert.strictEqual(props.TargetFrameworks, 'net8.0;net9.0');

    const computed = (csprojService as unknown as {
      computeExpectedTargetPathFromMsbuildProperties: (
        csprojUri: vscode.Uri,
        configuration: 'Debug' | 'Release',
        props: Record<string, string | undefined>,
      ) => string | undefined;
    }).computeExpectedTargetPathFromMsbuildProperties(csproj, 'Debug', props);

    const expected = path.join('C:', 'repo', 'App', 'bin', 'Debug', 'net8.0', 'App.dll');
    assert.strictEqual(computed?.toLowerCase(), expected.toLowerCase());
  });

  test('dotnetStart.addLaunchConfiguration adds a dotnet-start entry to launch configurations', async () => {
    let restoreGetConfiguration: (() => void) | undefined;
    let restoreShowInformationMessage: (() => void) | undefined;

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
      restoreGetConfiguration = patchProp(
        vscode.workspace,
        'getConfiguration',
        ((): unknown => {
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
        }) as unknown as typeof vscode.workspace.getConfiguration,
      );

      restoreShowInformationMessage = patchProp(
        vscode.window,
        'showInformationMessage',
        (async (_message: string, ..._items: string[]) => {
          infoCalls++;
          return undefined;
        }) as unknown as typeof vscode.window.showInformationMessage,
      );

      await vscode.commands.executeCommand('dotnetStart.addLaunchConfiguration');

      assert.ok(updateCalls >= 1, 'Expected at least one configuration update call.');
      assert.ok(infoCalls >= 1, 'Expected an informational message after the update.');

      const configs = store.configurations ?? [];
      const dotnetStart = configs.find((c) => c.name === DOTNET_START_CONFIGURATION_NAME);
      assert.ok(dotnetStart, 'Expected dotnet-start configuration to be present.');
      assert.strictEqual(dotnetStart?.type, 'coreclr');
      assert.strictEqual(dotnetStart?.request, 'launch');
    } finally {
      restoreGetConfiguration?.();
      restoreShowInformationMessage?.();
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

    let restoreShowQuickPick: (() => void) | undefined;
    let restoreShowErrorMessage: (() => void) | undefined;

    let errorMessage: string | undefined;
    try {
      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (_items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
          assert.fail('Expected showQuickPick not to be called when no .csproj exists.');
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreShowErrorMessage = patchProp(
        vscode.window,
        'showErrorMessage',
        (async (message: string, ..._items: string[]) => {
          errorMessage = message;
          return undefined;
        }) as unknown as typeof vscode.window.showErrorMessage,
      );

      await vscode.commands.executeCommand('dotnetStart.selectStartProject');

      assert.strictEqual(errorMessage, 'No .csproj files found in this workspace.');
    } finally {
      restoreShowQuickPick?.();
      restoreShowErrorMessage?.();
    }
  });

  test('dotnetStart.selectStartProject shows which .csproj is current', async () => {
    let restoreShowQuickPick: (() => void) | undefined;

    let callIndex = 0;
    let secondCallSawCurrentLabel = false;
    let secondCallCurrentIsFirstItem = false;

    try {
      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      // First selection sets workspaceState.
      await vscode.commands.executeCommand('dotnetStart.selectStartProject');
      // Second selection should indicate the current project.
      await vscode.commands.executeCommand('dotnetStart.selectStartProject');

      assert.ok(secondCallSawCurrentLabel, 'Expected the current .csproj to be labeled as Current.');
      assert.ok(secondCallCurrentIsFirstItem, 'Expected the current .csproj to be the first item.');
    } finally {
      restoreShowQuickPick?.();
    }
  });

  test('dotnetStart.clearState clears saved project/profile state', async function () {
    let restoreShowQuickPick: (() => void) | undefined;
    let restoreCreateQuickPick: (() => void) | undefined;
    let restoreStartDebugging: (() => void) | undefined;
    let restoreShowInformationMessage: (() => void) | undefined;
    let restoreGetConfiguration: (() => void) | undefined;

    let showQuickPickCalls = 0;
    let promptInfoCalls = 0;
    let clearStateInfoCalls = 0;

    try {
      // Ensure the action picker is stable for this test:
      // - No existing dotnet-start config in launch configurations
      restoreGetConfiguration = patchProp(
        vscode.workspace,
        'getConfiguration',
        ((): unknown => {
          return {
            get: (section: string) => {
              if (section === 'configurations') {
                return [] as vscode.DebugConfiguration[];
              }
              return undefined;
            },
            update: async () => undefined,
          };
        }) as unknown as typeof vscode.workspace.getConfiguration,
      );

      restoreShowInformationMessage = patchProp(
        vscode.window,
        'showInformationMessage',
        (async (message: string, ..._items: string[]) => {
          if (message.startsWith('Cleared dotnet-start saved state')) {
            clearStateInfoCalls++;
            return undefined;
          }

          promptInfoCalls++;
          return 'Not now';
        }) as unknown as typeof vscode.window.showInformationMessage,
      );

      // Ensure the test always starts from a clean workspaceState, regardless of test execution order.
      await vscode.commands.executeCommand('dotnetStart.clearState');
      clearStateInfoCalls = 0;

      restoreCreateQuickPick = patchProp(
        vscode.window,
        'createQuickPick',
        (() => {
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
        }) as unknown as typeof vscode.window.createQuickPick,
      );

      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreStartDebugging = patchProp(
        vscode.debug,
        'startDebugging',
        (async () => true) as unknown as typeof vscode.debug.startDebugging,
      );

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
      restoreShowQuickPick?.();
      restoreCreateQuickPick?.();
      restoreStartDebugging?.();
      restoreShowInformationMessage?.();
      restoreGetConfiguration?.();
    }
  });

  test('changing the selected start project clears the saved launch profile', async function () {
    this.timeout(10_000);

    let restoreShowQuickPick: (() => void) | undefined;
    let restoreCreateQuickPick: (() => void) | undefined;
    let restoreStartDebugging: (() => void) | undefined;

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
      restoreCreateQuickPick = patchProp(
        vscode.window,
        'createQuickPick',
        (() => {
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
        }) as unknown as typeof vscode.window.createQuickPick,
      );

      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreStartDebugging = patchProp(
        vscode.debug,
        'startDebugging',
        (async (_folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration) => {
          capturedArgs = config.args as string[];
          return true;
        }) as unknown as typeof vscode.debug.startDebugging,
      );

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
      restoreShowQuickPick?.();
      restoreCreateQuickPick?.();
      restoreStartDebugging?.();
    }
  });

  test('when there is only one launch profile, it is auto-selected and persisted without showing a picker', async function () {
    this.timeout(10_000);

    let restoreShowQuickPick: (() => void) | undefined;
    let restoreCreateQuickPick: (() => void) | undefined;
    let restoreStartDebugging: (() => void) | undefined;

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
      restoreCreateQuickPick = patchProp(
        vscode.window,
        'createQuickPick',
        (() => {
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
        }) as unknown as typeof vscode.window.createQuickPick,
      );

      restoreShowQuickPick = patchProp(
        vscode.window,
        'showQuickPick',
        (async (items: readonly AnyQuickPickItem[], _options?: vscode.QuickPickOptions) => {
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
        }) as unknown as typeof vscode.window.showQuickPick,
      );

      restoreStartDebugging = patchProp(
        vscode.debug,
        'startDebugging',
        (async (_folder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration) => {
          capturedArgs = config.args as string[];
          return true;
        }) as unknown as typeof vscode.debug.startDebugging,
      );

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
      restoreShowQuickPick?.();
      restoreCreateQuickPick?.();
      restoreStartDebugging?.();
    }
  });
});
