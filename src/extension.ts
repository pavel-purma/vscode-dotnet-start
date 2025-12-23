import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const STATE_KEY_CSPROJ = 'dotnet-start.selected-csproj-uri';
const STATE_KEY_LAUNCH_PROFILE = 'dotnet-start.selected-launch-profile';
export const DOTNET_START_CONFIGURATION_NAME = 'dotnet-start';

const execFileAsync = promisify(execFile);

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
      finish(quickPick.selectedItems[0] ?? quickPick.activeItems[0]);
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

function hasDotnetStartLaunchConfiguration(configurations: readonly vscode.DebugConfiguration[]): boolean {
  return configurations.some(
    (c) =>
      c &&
      typeof c === 'object' &&
      c.name === DOTNET_START_CONFIGURATION_NAME &&
      c.type === 'coreclr' &&
      c.request === 'launch',
  );
}

async function addDotnetStartLaunchConfigurationToLaunchJson(
  wsFolder: vscode.WorkspaceFolder,
): Promise<'added' | 'already-present' | 'failed'> {
  try {
    const launchConfig = vscode.workspace.getConfiguration('launch', wsFolder.uri);
    const existing = launchConfig.get<vscode.DebugConfiguration[]>('configurations') ?? [];

    if (hasDotnetStartLaunchConfiguration(existing)) {
      return 'already-present';
    }

    const updated: vscode.DebugConfiguration[] = [
      ...existing,
      buildCoreclrDotnetStartStubConfiguration(),
    ];

    // This creates/updates .vscode/launch.json.
    await launchConfig.update('version', '0.2.0', vscode.ConfigurationTarget.WorkspaceFolder);
    await launchConfig.update('configurations', updated, vscode.ConfigurationTarget.WorkspaceFolder);
    return 'added';
  } catch {
    return 'failed';
  }
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

  if (currentlySelected) {
    const previousKey = normalizeFsPath(currentlySelected.fsPath);
    const nextKey = normalizeFsPath(picked.uri.fsPath);
    if (previousKey !== nextKey) {
      // The saved launch profile is project-specific. Clear it when the start project changes.
      await context.workspaceState.update(STATE_KEY_LAUNCH_PROFILE, undefined);
    }
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

type LaunchProfileDetails = {
  commandName?: string;
  commandLineArgs?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
};

function coerceStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      result[key] = v;
    }
  }
  return result;
}

async function readLaunchProfileDetails(
  launchSettingsUri: vscode.Uri,
  profileName: string,
): Promise<LaunchProfileDetails | undefined> {
  const bytes = await vscode.workspace.fs.readFile(launchSettingsUri);
  const text = Buffer.from(bytes).toString('utf8');
  const json = JSON.parse(text) as unknown;

  if (!json || typeof json !== 'object') {
    return undefined;
  }

  const profiles = (json as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object') {
    return undefined;
  }

  const profile = (profiles as Record<string, unknown>)[profileName];
  if (!profile || typeof profile !== 'object') {
    return undefined;
  }

  const record = profile as Record<string, unknown>;
  return {
    commandName: typeof record.commandName === 'string' ? record.commandName : undefined,
    commandLineArgs: typeof record.commandLineArgs === 'string' ? record.commandLineArgs : undefined,
    applicationUrl: typeof record.applicationUrl === 'string' ? record.applicationUrl : undefined,
    environmentVariables: coerceStringRecord(record.environmentVariables),
  };
}

function parseCommandLineArgs(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar: '"' | "'" | undefined;

  const flush = () => {
    if (current.length > 0) {
      args.push(current);
      current = '';
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
      inQuotes = !inQuotes;
      quoteChar = inQuotes ? (ch as '"' | "'") : undefined;
      continue;
    }

    if (!inQuotes && /\s/.test(ch)) {
      flush();
      continue;
    }

    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '"' || next === "'" || next === '\\') {
        current += next;
        i++;
        continue;
      }
    }

    current += ch;
  }

  flush();
  return args;
}

async function fileExists(fileUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(fileUri);
    return true;
  } catch {
    return false;
  }
}

function splitSemicolonList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseMsbuildGetPropertyOutput(propertyName: string, output: string): string | undefined {
  const text = output.replaceAll('\r\n', '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const propertyLower = propertyName.toLowerCase();

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.startsWith(propertyLower)) {
      continue;
    }

    const idx = line.indexOf('=');
    if (idx >= 0) {
      const value = line.slice(idx + 1).trim();
      if (value.length > 0) {
        return value;
      }
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx >= 0) {
      const value = line.slice(colonIdx + 1).trim();
      if (value.length > 0) {
        return value;
      }
    }
  }

  if (lines.length === 1) {
    return lines[0];
  }

  return undefined;
}

async function tryGetMsbuildTargetPath(
  csprojUri: vscode.Uri,
  options: { configuration: 'Debug' | 'Release'; targetFramework?: string },
): Promise<string | undefined> {
  const projectDir = path.dirname(csprojUri.fsPath);

  const args = [
    'msbuild',
    csprojUri.fsPath,
    '-nologo',
    '-getProperty:TargetPath',
    `-property:Configuration=${options.configuration}`,
  ];
  if (options.targetFramework) {
    args.push(`-property:TargetFramework=${options.targetFramework}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync('dotnet', args, {
      cwd: projectDir,
      windowsHide: true,
      timeout: 15_000,
    });
    const combined = `${stdout}\n${stderr}`;
    const value = parseMsbuildGetPropertyOutput('TargetPath', combined);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function tryGetMsbuildTargetFramework(csprojUri: vscode.Uri): Promise<string | undefined> {
  const projectDir = path.dirname(csprojUri.fsPath);
  try {
    const { stdout, stderr } = await execFileAsync(
      'dotnet',
      [
        'msbuild',
        csprojUri.fsPath,
        '-nologo',
        '-getProperty:TargetFramework',
        '-getProperty:TargetFrameworks',
      ],
      { cwd: projectDir, windowsHide: true, timeout: 15_000 },
    );
    const combined = `${stdout}\n${stderr}`;
    const single = parseMsbuildGetPropertyOutput('TargetFramework', combined);
    if (single) {
      return single;
    }
    const multi = parseMsbuildGetPropertyOutput('TargetFrameworks', combined);
    return splitSemicolonList(multi)[0];
  } catch {
    return undefined;
  }
}

async function findFallbackOutputDll(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const projectDir = path.dirname(csprojUri.fsPath);
  const projectName = path.parse(csprojUri.fsPath).name;
  const base = vscode.Uri.file(projectDir);

  const preferredPattern = new vscode.RelativePattern(base, `bin/Debug/**/${projectName}.dll`);
  const preferred = await vscode.workspace.findFiles(preferredPattern, '**/{obj,node_modules,.git,.vs}/**', 2);
  if (preferred.length > 0) {
    return preferred[0];
  }

  const anyDebugDllPattern = new vscode.RelativePattern(base, 'bin/Debug/**/*.dll');
  const anyDebug = await vscode.workspace.findFiles(anyDebugDllPattern, '**/{obj,node_modules,.git,.vs}/**', 20);
  if (anyDebug.length > 0) {
    const exact = anyDebug.find((u) => path.basename(u.fsPath).toLowerCase() === `${projectName.toLowerCase()}.dll`);
    return exact ?? anyDebug[0];
  }

  const anyDllPattern = new vscode.RelativePattern(base, '**/*.dll');
  const anyDll = await vscode.workspace.findFiles(anyDllPattern, '**/{obj,node_modules,.git,.vs}/**', 50);
  if (anyDll.length > 0) {
    const exact = anyDll.find((u) => path.basename(u.fsPath).toLowerCase() === `${projectName.toLowerCase()}.dll`);
    return exact ?? anyDll[0];
  }

  return undefined;
}

async function resolveTargetBinaryPath(
  csprojUri: vscode.Uri,
): Promise<{ binaryUri: vscode.Uri; source: 'msbuild' | 'fallback-search' }> {
  const fallback = await findFallbackOutputDll(csprojUri);
  if (fallback) {
    return { binaryUri: fallback, source: 'fallback-search' };
  }

  const directTargetPath = await tryGetMsbuildTargetPath(csprojUri, { configuration: 'Debug' });
  if (directTargetPath) {
    return { binaryUri: vscode.Uri.file(directTargetPath), source: 'msbuild' };
  }

  const tfm = await tryGetMsbuildTargetFramework(csprojUri);
  if (tfm) {
    const tfmTargetPath = await tryGetMsbuildTargetPath(csprojUri, { configuration: 'Debug', targetFramework: tfm });
    if (tfmTargetPath) {
      return { binaryUri: vscode.Uri.file(tfmTargetPath), source: 'msbuild' };
    }
  }

  return { binaryUri: vscode.Uri.file(csprojUri.fsPath), source: 'fallback-search' };
}

async function tryDotnetBuild(csprojUri: vscode.Uri): Promise<{ ok: true } | { ok: false; message: string }> {
  const projectDir = path.dirname(csprojUri.fsPath);
  try {
    await execFileAsync('dotnet', ['build', csprojUri.fsPath, '-c', 'Debug', '-v', 'minimal'], {
      cwd: projectDir,
      windowsHide: true,
      timeout: 120_000,
    });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message };
  }
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

  if (profileNames.length === 1) {
    const onlyProfile = profileNames[0];
    await context.workspaceState.update(STATE_KEY_LAUNCH_PROFILE, onlyProfile);
    return onlyProfile;
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

async function clearSavedState(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(STATE_KEY_CSPROJ, undefined);
  await context.workspaceState.update(STATE_KEY_LAUNCH_PROFILE, undefined);
}

async function buildCoreclrDotnetStartConfiguration(
  csprojUri: vscode.Uri,
  profileName: string,
): Promise<vscode.DebugConfiguration | undefined> {
  const projectDir = path.dirname(csprojUri.fsPath);

  const launchSettingsUri = await getLaunchSettingsUriForProject(csprojUri);
  if (!launchSettingsUri) {
    void vscode.window.showErrorMessage(
      `No launchSettings.json found for ${path.basename(csprojUri.fsPath)} (expected Properties/launchSettings.json).`,
    );
    return undefined;
  }

  let details: LaunchProfileDetails | undefined;
  try {
    details = await readLaunchProfileDetails(launchSettingsUri, profileName);
  } catch (e) {
    void vscode.window.showErrorMessage(`Failed to read launch profile "${profileName}": ${String(e)}`);
    return undefined;
  }

  if (!details) {
    void vscode.window.showErrorMessage(`Launch profile "${profileName}" was not found in launchSettings.json.`);
    return undefined;
  }

  if (details.commandName && details.commandName !== 'Project') {
    void vscode.window.showErrorMessage(
      `Launch profile "${profileName}" uses commandName="${details.commandName}". Only "Project" is supported.`,
    );
    return undefined;
  }

  let resolved = await resolveTargetBinaryPath(csprojUri);
  if (!(await fileExists(resolved.binaryUri))) {
    const buildResult = await tryDotnetBuild(csprojUri);
    if (!buildResult.ok) {
      void vscode.window.showErrorMessage(
        `dotnet build failed. Ensure .NET SDK is installed and "dotnet" is on PATH. ${buildResult.message}`,
      );
      return undefined;
    }

    resolved = await resolveTargetBinaryPath(csprojUri);
    if (!(await fileExists(resolved.binaryUri))) {
      void vscode.window.showErrorMessage(
        `Build succeeded but output was not found at ${resolved.binaryUri.fsPath}. (resolved via ${resolved.source})`,
      );
      return undefined;
    }
  }

  const env = { ...(details.environmentVariables ?? {}) };
  if (details.applicationUrl && !env.ASPNETCORE_URLS) {
    env.ASPNETCORE_URLS = details.applicationUrl;
  }

  const runtimeArgs = parseCommandLineArgs(details.commandLineArgs);

  return {
    type: 'coreclr',
    request: 'launch',
    name: DOTNET_START_CONFIGURATION_NAME,
    program: 'dotnet',
    args: [resolved.binaryUri.fsPath, ...runtimeArgs],
    cwd: projectDir,
    console: 'integratedTerminal',
    internalConsoleOptions: 'neverOpen',
    env,
  };
}

function buildCoreclrDotnetStartStubConfiguration(): vscode.DebugConfiguration {
  return {
    type: 'coreclr',
    request: 'launch',
    name: DOTNET_START_CONFIGURATION_NAME,
    program: 'dotnet',
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

  if (profileNames.length === 1) {
    return profileNames[0];
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

  const debugConfig = await buildCoreclrDotnetStartConfiguration(csprojUri, profile);
  if (!debugConfig) {
    return undefined;
  }

  return { wsFolder, debugConfig };
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

  const debugConfig = await buildCoreclrDotnetStartConfiguration(csprojUri, profile);
  if (!debugConfig) {
    return;
  }

  const ok = await vscode.debug.startDebugging(wsFolder, debugConfig);
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
      return [buildCoreclrDotnetStartStubConfiguration()];
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

function createDotnetStartInitialDebugConfigurationProvider(): vscode.DebugConfigurationProvider {
  // Important: the Initial provider must not resolve to a fully expanded config.
  // VS Code uses Initial providers to populate a new launch.json; we only want to offer
  // the same stub configuration that dotnetStart.addLaunchConfiguration writes.
  return {
    provideDebugConfigurations: async () => {
      return [
        // Keep this minimal but schema-valid so launch.json has no validation errors.
        buildCoreclrDotnetStartStubConfiguration(),
      ];
    },
  };
}

export function activate(context: vscode.ExtensionContext) {
  const provider = createDotnetStartDebugConfigurationProvider(context);
  const initialProvider = createDotnetStartInitialDebugConfigurationProvider();

  // Provide a dynamic configuration so it shows up in the native F5 picker.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'coreclr',
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
  );

  // Provide an initial configuration so VS Code can offer dotnet-start when creating
  // .vscode/launch.json for the first time.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'coreclr',
      initialProvider,
      vscode.DebugConfigurationProviderTriggerKind.Initial,
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

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.addLaunchConfiguration', async () => {
      const wsFolder = getAnyWorkspaceFolder();
      if (!wsFolder) {
        void vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }

      const result = await addDotnetStartLaunchConfigurationToLaunchJson(wsFolder);
      if (result === 'added') {
        void vscode.window.showInformationMessage('Added dotnet-start to .vscode/launch.json.');
        return;
      }
      if (result === 'already-present') {
        void vscode.window.showInformationMessage('dotnet-start is already present in .vscode/launch.json.');
        return;
      }

      void vscode.window.showErrorMessage('Failed to update .vscode/launch.json.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.clearState', async () => {
      await clearSavedState(context);
      void vscode.window.showInformationMessage('Cleared dotnet-start saved state for this workspace.');
    }),
  );
}

export function deactivate() { }
