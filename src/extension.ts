import * as path from 'path';
import * as vscode from 'vscode';

const STATE_KEY_CSPROJ = 'dotnetStart.selectedCsprojUri';
const STATE_KEY_LAUNCH_PROFILE = 'dotnetStart.selectedLaunchProfile';

type CsprojPickItem = vscode.QuickPickItem & { uri: vscode.Uri };
type ProfilePickItem = vscode.QuickPickItem & { profileName: string };

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

function toWorkspaceRelativeLabel(uri: vscode.Uri): string {
  const wsFolder = getWorkspaceFolderForUri(uri);
  if (!wsFolder) {
    return uri.fsPath;
  }
  return path.relative(wsFolder.uri.fsPath, uri.fsPath).replaceAll('\\', '/');
}

async function pickCsproj(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const csprojUris = await findCsprojFiles();
  if (csprojUris.length === 0) {
    void vscode.window.showErrorMessage('No .csproj files found in this workspace.');
    return undefined;
  }

  const items: CsprojPickItem[] = csprojUris
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
    .map((uri) => {
      const rel = toWorkspaceRelativeLabel(uri);
      return {
        label: path.basename(uri.fsPath),
        description: rel,
        uri,
      };
    });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select start project (.csproj)',
    placeHolder: 'Choose a .csproj to use as the start project',
    matchOnDescription: true,
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
    description: toWorkspaceRelativeLabel(launchSettingsUri),
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

async function startDotnetDebugging(context: vscode.ExtensionContext): Promise<void> {
  let csprojUri = await getSelectedCsproj(context);
  if (!csprojUri) {
    csprojUri = await pickCsproj(context);
    if (!csprojUri) {
      return;
    }
  }

  let profile = await getSelectedLaunchProfile(context);
  if (!profile) {
    profile = await pickLaunchProfile(context, csprojUri);
    if (!profile) {
      return;
    }
  }

  const projectDir = path.dirname(csprojUri.fsPath);
  const wsFolder = getWorkspaceFolderForUri(csprojUri) ?? getAnyWorkspaceFolder();
  if (!wsFolder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return;
  }

  const debugConfig: vscode.DebugConfiguration = {
    type: 'coreclr',
    request: 'launch',
    name: `dotnet-start: ${path.basename(csprojUri.fsPath)} (${profile})`,
    program: 'dotnet',
    args: ['run', '--project', csprojUri.fsPath, '--launch-profile', profile],
    cwd: projectDir,
    console: 'integratedTerminal',
    internalConsoleOptions: 'neverOpen',
  };

  const ok = await vscode.debug.startDebugging(wsFolder, debugConfig);
  if (!ok) {
    void vscode.window.showErrorMessage(
      'Failed to start debugging. Ensure the C#/.NET debugger is installed and that "dotnet" is on PATH.',
    );
  }
}

async function showF5Picker(context: vscode.ExtensionContext): Promise<void> {
  const csprojUri = await getSelectedCsproj(context);
  const csprojLabel = csprojUri ? toWorkspaceRelativeLabel(csprojUri) : '(start project not selected)';
  const profile = (await getSelectedLaunchProfile(context)) ?? '(launch profile not selected)';

  const items: Array<vscode.QuickPickItem & { action: 'start' }> = [
    {
      label: 'dotnet-start',
      description: csprojLabel,
      detail: `Launch profile: ${profile}`,
      action: 'start',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select and Start Debugging',
    placeHolder: 'Choose a configuration',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }

  if (picked.action === 'start') {
    await startDotnetDebugging(context);
  }
}

export function activate(context: vscode.ExtensionContext) {
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
      await startDotnetDebugging(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.f5', async () => {
      await showF5Picker(context);
    }),
  );
}

export function deactivate() { }
