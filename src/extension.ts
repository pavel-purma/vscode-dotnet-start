import * as path from 'path';
import * as vscode from 'vscode';

const STATE_KEY_CSPROJ = 'dotnet-start.selected-csproj-uri';
const STATE_KEY_LAUNCH_PROFILE = 'dotnet-start.selected-launch-profile';
export const DOTNET_START_CONFIGURATION_NAME = 'dotnet-start';

type F5ActionId = 'dotnet-start' | 'dotnet-start.run-once-profile';
type F5PickItem = vscode.QuickPickItem & { action: F5ActionId };

type CsprojPickItem = vscode.QuickPickItem & { uri: vscode.Uri };
type ProfilePickItem = vscode.QuickPickItem & { profileName: string };

async function showPreselectedQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  activeItem: T,
  options: { title: string; placeHolder?: string },
): Promise<T | undefined> {
  const quickPick = vscode.window.createQuickPick<T>();
  quickPick.items = items;
  quickPick.title = options.title;
  quickPick.placeholder = options.placeHolder;
  quickPick.activeItems = [activeItem];

  return await new Promise<T | undefined>((resolve) => {
    let settled = false;
    let acceptDisposable: vscode.Disposable | undefined;
    let hideDisposable: vscode.Disposable | undefined;
    const finish = (value: T | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      acceptDisposable?.dispose();
      hideDisposable?.dispose();
      resolve(value);
      quickPick.dispose();
    };

    acceptDisposable = quickPick.onDidAccept(() => {
      finish(quickPick.selectedItems[0]);
    });
    hideDisposable = quickPick.onDidHide(() => {
      finish(undefined);
    });

    quickPick.show();
  });
}

function toWorkspaceRelativeDetail(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
}

function normalizeFsPath(p: string): string {
  // Windows paths are case-insensitive; normalize for stable comparisons.
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri);
}

function getAnyWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function findCsprojFiles(): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles(
    '**/*.csproj',
    '**/{bin,obj,node_modules,.git,.vs}/**',
  );
}

async function pickCsproj(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const currentlySelected = await getSelectedCsproj(context);
  const csprojUris = await findCsprojFiles();
  if (csprojUris.length === 0) {
    void vscode.window.showErrorMessage('No .csproj files found in this workspace.');
    return undefined;
  }

  const selectedKey = currentlySelected ? normalizeFsPath(currentlySelected.fsPath) : undefined;

  const items: CsprojPickItem[] = csprojUris
    .sort((a, b) => {
      const aIsSelected = selectedKey ? normalizeFsPath(a.fsPath) === selectedKey : false;
      const bIsSelected = selectedKey ? normalizeFsPath(b.fsPath) === selectedKey : false;
      if (aIsSelected !== bIsSelected) {
        return aIsSelected ? -1 : 1;
      }
      return a.fsPath.localeCompare(b.fsPath);
    })
    .map((uri) => {
      const isSelected = selectedKey ? normalizeFsPath(uri.fsPath) === selectedKey : false;
      return {
        label: path.parse(uri.fsPath).name,
        description: isSelected ? 'Current' : undefined,
        detail: toWorkspaceRelativeDetail(uri),
        uri,
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select start project (.csproj)',
    placeHolder: 'Choose a .csproj to use as the start project',
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }

  await context.workspaceState.update(STATE_KEY_CSPROJ, picked.uri.toString());
  return picked.uri;
}

async function getSelectedCsproj(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const stored = context.workspaceState.get<string>(STATE_KEY_CSPROJ);
  if (!stored) {
    return undefined;
  }
  try {
    return vscode.Uri.parse(stored);
  } catch {
    return undefined;
  }
}

async function getLaunchSettingsUriForProject(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const projectDir = path.dirname(csprojUri.fsPath);
  const candidates = [
    vscode.Uri.file(path.join(projectDir, 'Properties', 'launchSettings.json')),
    vscode.Uri.file(path.join(projectDir, 'launchSettings.json')),
  ];

  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  return undefined;
}

async function readLaunchProfileNames(launchSettingsUri: vscode.Uri): Promise<string[]> {
  const bytes = await vscode.workspace.fs.readFile(launchSettingsUri);
  const text = Buffer.from(bytes).toString('utf8');
  const json = JSON.parse(text) as unknown;

  if (!json || typeof json !== 'object') {
    return [];
  }

  const profiles = (json as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object') {
    return [];
  }

  return Object.keys(profiles as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
}

async function pickLaunchProfile(context: vscode.ExtensionContext, csprojUri: vscode.Uri): Promise<string | undefined> {
  const launchSettingsUri = await getLaunchSettingsUriForProject(csprojUri);
  if (!launchSettingsUri) {
    void vscode.window.showErrorMessage(
      `No launchSettings.json found for ${path.basename(csprojUri.fsPath)} (expected Properties/launchSettings.json).`,
    );
    return undefined;
  }

  let profileNames: string[];
  try {
    profileNames = await readLaunchProfileNames(launchSettingsUri);
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to read launch profiles: ${String(e)}`);
    return undefined;
  }

  if (profileNames.length === 0) {
    void vscode.window.showErrorMessage('No launch profiles found in launchSettings.json.');
    return undefined;
  }

  const items: ProfilePickItem[] = profileNames.map((profileName) => ({
    label: profileName,
    profileName,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select launch profile (launchSettings.json)',
    placeHolder: 'Choose a Visual Studio launch profile',
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }

  await context.workspaceState.update(STATE_KEY_LAUNCH_PROFILE, picked.profileName);
  return picked.profileName;
}

async function getSelectedLaunchProfile(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.workspaceState.get<string>(STATE_KEY_LAUNCH_PROFILE);
}

function buildCoreclrDotnetRunConfiguration(csprojUri: vscode.Uri, profile: string): vscode.DebugConfiguration {
  const projectDir = path.dirname(csprojUri.fsPath);
  return {
    type: 'coreclr',
    request: 'launch',
    name: DOTNET_START_CONFIGURATION_NAME,
    program: 'dotnet',
    args: ['run', '--project', csprojUri.fsPath, '--launch-profile', profile],
    cwd: projectDir,
    console: 'integratedTerminal',
    internalConsoleOptions: 'neverOpen',
  };
}

function getWsFolderForProject(csprojUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return getWorkspaceFolderForUri(csprojUri) ?? getAnyWorkspaceFolder();
}

async function pickLaunchProfileOnce(csprojUri: vscode.Uri): Promise<string | undefined> {
  const launchSettingsUri = await getLaunchSettingsUriForProject(csprojUri);
  if (!launchSettingsUri) {
    void vscode.window.showErrorMessage(
      `No launchSettings.json found for ${path.basename(csprojUri.fsPath)} (expected Properties/launchSettings.json).`,
    );
    return undefined;
  }

  let profileNames: string[];
  try {
    profileNames = await readLaunchProfileNames(launchSettingsUri);
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to read launch profiles: ${String(e)}`);
    return undefined;
  }

  if (profileNames.length === 0) {
    void vscode.window.showErrorMessage('No launch profiles found in launchSettings.json.');
    return undefined;
  }

  const items: ProfilePickItem[] = profileNames.map((profileName) => ({
    label: profileName,
    profileName,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select launch profile (once)',
    placeHolder: 'Choose a Visual Studio launch profile (will not be saved)',
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }

  return picked.profileName;
}

async function buildDotnetStartDebugConfiguration(
  context: vscode.ExtensionContext,
): Promise<{ wsFolder: vscode.WorkspaceFolder; debugConfig: vscode.DebugConfiguration } | undefined> {
  let csprojUri = await getSelectedCsproj(context);
  if (!csprojUri) {
    csprojUri = await pickCsproj(context);
    if (!csprojUri) {
      return undefined;
    }
  }

  let profile = await getSelectedLaunchProfile(context);
  if (!profile) {
    profile = await pickLaunchProfile(context, csprojUri);
    if (!profile) {
      return undefined;
    }
  }

  const wsFolder = getWsFolderForProject(csprojUri);
  if (!wsFolder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return undefined;
  }

  return { wsFolder, debugConfig: buildCoreclrDotnetRunConfiguration(csprojUri, profile) };
}

async function startDotnetDebugging(context: vscode.ExtensionContext): Promise<void> {
  const built = await buildDotnetStartDebugConfiguration(context);
  if (!built) {
    return;
  }

  const ok = await vscode.debug.startDebugging(built.wsFolder, built.debugConfig);
  if (!ok) {
    void vscode.window.showErrorMessage(
      'Failed to start debugging. Ensure the C#/.NET debugger is installed and that "dotnet" is on PATH.',
    );
  }
}

async function startDotnetDebuggingWithOneOffProfile(context: vscode.ExtensionContext): Promise<void> {
  let csprojUri = await getSelectedCsproj(context);
  if (!csprojUri) {
    csprojUri = await pickCsproj(context);
    if (!csprojUri) {
      return;
    }
  }

  const profile = await pickLaunchProfileOnce(csprojUri);
  if (!profile) {
    return;
  }

  const wsFolder = getWsFolderForProject(csprojUri);
  if (!wsFolder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return;
  }

  const ok = await vscode.debug.startDebugging(wsFolder, buildCoreclrDotnetRunConfiguration(csprojUri, profile));
  if (!ok) {
    void vscode.window.showErrorMessage(
      'Failed to start debugging. Ensure the C#/.NET debugger is installed and that "dotnet" is on PATH.',
    );
  }
}

async function runF5Picker(context: vscode.ExtensionContext): Promise<void> {
  const selectedCsproj = await getSelectedCsproj(context);
  const selectedProfile = await getSelectedLaunchProfile(context);

  const currentProjectName = selectedCsproj ? path.parse(selectedCsproj.fsPath).name : undefined;

  const runSelectedItem: F5PickItem = {
    label: DOTNET_START_CONFIGURATION_NAME,
    description:
      currentProjectName && selectedProfile ? `${currentProjectName} / ${selectedProfile}` : undefined,
    detail:
      selectedCsproj && selectedProfile
        ? toWorkspaceRelativeDetail(selectedCsproj)
        : 'Runs the selected start project and launch profile',
    action: DOTNET_START_CONFIGURATION_NAME,
  };

  const runOnceItem: F5PickItem = {
    label: 'Run another profile (once)',
    detail: 'Starts debugging with a one-off launch profile (does not change the saved selection)',
    action: 'dotnet-start.run-once-profile',
  };

  const items: F5PickItem[] = [runSelectedItem, runOnceItem];

  const picked = await showPreselectedQuickPick(items, runSelectedItem, {
    title: 'Start debugging',
    placeHolder: 'Choose a debug action',
  });

  if (!picked) {
    return;
  }

  if (picked.action === DOTNET_START_CONFIGURATION_NAME) {
    await startDotnetDebugging(context);
    return;
  }

  if (picked.action === 'dotnet-start.run-once-profile') {
    await startDotnetDebuggingWithOneOffProfile(context);
  }
}

export function createDotnetStartDebugConfigurationProvider(
  context: vscode.ExtensionContext,
): vscode.DebugConfigurationProvider {
  return {
    provideDebugConfigurations: async () => {
      // Name must match the UX requirement: show "dotnet-start" in the native picker.
      return [
        {
          type: 'coreclr',
          request: 'launch',
          name: DOTNET_START_CONFIGURATION_NAME,
        },
      ];
    },
    resolveDebugConfiguration: async (folder, debugConfiguration) => {
      if (debugConfiguration?.name !== DOTNET_START_CONFIGURATION_NAME) {
        return debugConfiguration;
      }

      const built = await buildDotnetStartDebugConfiguration(context);
      if (!built) {
        return undefined;
      }

      void folder;
      return built.debugConfig;
    },
  };
}

export function activate(context: vscode.ExtensionContext) {
  const provider = createDotnetStartDebugConfigurationProvider(context);

  // Provide a dynamic configuration so it shows up in the native F5 picker.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'coreclr',
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.selectStartProject', async () => {
      await pickCsproj(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.selectLaunchProfile', async () => {
      const csprojUri = (await getSelectedCsproj(context)) ?? (await pickCsproj(context));
      if (!csprojUri) {
        return;
      }
      await pickLaunchProfile(context, csprojUri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.start', async () => {
      await runF5Picker(context);
    }),
  );
}

export function deactivate() { }
