import * as vscode from 'vscode';
import { CsprojInstance } from './services/csprojInstance';
import { DotnetStartManager } from './services/dotnetStartManager';
import { OutputChannelService } from './services/outputChannelService';
import * as constants from './shared/constants';
import { hasDotnetStartLaunchConfiguration, safeJsonStringify } from './shared/utils';

function getDotnetStartConfiguration(): vscode.DebugConfiguration {
  return {
    type: 'coreclr',
    request: 'launch',
    name: constants.DOTNET_START_CONFIGURATION_NAME,
    program: 'dotnet',
  };
}

async function addDotnetStartLaunchConfigurationToLaunchJson(
  wsFolder: vscode.WorkspaceFolder
) {
  try {
    const launchConfig = vscode.workspace.getConfiguration('launch', wsFolder.uri);
    const existingConfigurations = launchConfig.get<vscode.DebugConfiguration[]>('configurations') ?? [];

    if (
      hasDotnetStartLaunchConfiguration(
        existingConfigurations,
        constants.DOTNET_START_CONFIGURATION_NAME,
      )
    ) {
      void vscode.window.showInformationMessage('dotnet-start is already present in .vscode/launch.json.');
      return;
    }

    const updatedConfigurations: vscode.DebugConfiguration[] = [
      ...existingConfigurations,
      getDotnetStartConfiguration(),
    ];

    // This creates/updates .vscode/launch.json.
    await launchConfig.update('version', '0.2.0', vscode.ConfigurationTarget.WorkspaceFolder);
    await launchConfig.update('configurations', updatedConfigurations, vscode.ConfigurationTarget.WorkspaceFolder);
    void vscode.window.showInformationMessage('Added dotnet-start to .vscode/launch.json.');
  } catch {
    void vscode.window.showErrorMessage('Failed to update .vscode/launch.json.');
  }
}

async function buildDotnetProject(csproj: CsprojInstance) {
  const output = OutputChannelService.channel;

  const buildOk = await csproj.runDotnetBuildAndPipeOutput();
  if (!buildOk) {
    output.appendLine('');
    output.appendLine('Build status: FAILED');
    output.appendLine('');
    void vscode.window.showErrorMessage(
      'dotnet build failed. See Output → dotnet-start for details.',
    );
    return undefined;
  }

  output.appendLine('');
  output.appendLine('Build status: SUCCEEDED');
  output.appendLine('');
}

async function initiateVscodeDebugger(csprojUri: vscode.Uri, profileName: string) {
  const output = OutputChannelService.channel;

  const csproj = new CsprojInstance(csprojUri);

  await buildDotnetProject(csproj);

  const debugConfig = await csproj.createVscodeDebugConfiguration({
    profileName: profileName,
    configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
  });
  if (!debugConfig) {
    return undefined;
  }

  output.appendLine('');
  output.appendLine('Resolved debug configuration:');
  output.appendLine(safeJsonStringify(debugConfig));

  const wsFolder = csproj.getWorkspaceFolder();
  const ok = await vscode.debug.startDebugging(wsFolder, debugConfig);
  if (!ok) {
    void vscode.window.showErrorMessage(
      'Failed to start debugging. Ensure the C#/.NET debugger is installed and that "dotnet" is on PATH.',
    );
  }
}

async function startDotnetDebugging(
  manager: DotnetStartManager,
): Promise<void> {
  const { csprojUri, profileName } = await manager.ensureSelectedProjectAndProfile() ?? {};
  if (!csprojUri || !profileName) {
    return undefined;
  }

  await initiateVscodeDebugger(csprojUri, profileName);
}

async function startDotnetDebuggingWithOneOffProfile(
  manager: DotnetStartManager
): Promise<void> {
  const csprojUri = await manager.ensureSelectedProject();
  if (!csprojUri) {
    return;
  }

  const profileName = await manager.selectLaunchProfileOnce(csprojUri);
  if (!profileName) {
    return;
  }

  await initiateVscodeDebugger(csprojUri, profileName);
}

async function runAltF5Picker(manager: DotnetStartManager): Promise<void> {
  const action = await manager.pickStartAction({
    configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
  });
  if (!action) {
    return;
  }

  if (action === 'run-selected') {
    await startDotnetDebugging(manager);
    return;
  }

  if (action === 'run-once-profile') {
    await startDotnetDebuggingWithOneOffProfile(manager);
  }
}

async function resolveVscodeDebugConfiguration(
  manager: DotnetStartManager,
): Promise<vscode.DebugConfiguration | undefined> {
  const { csprojUri, profileName } = await manager.ensureSelectedProjectAndProfile() ?? {};
  if (!csprojUri || !profileName) {
    return undefined;
  }
  const csproj = new CsprojInstance(csprojUri);

  await buildDotnetProject(csproj);

  return csproj.createVscodeDebugConfiguration({
    profileName: profileName,
    configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
  });
}

export function createDotnetStartDebugConfigurationProvider(
  manager: DotnetStartManager,
): vscode.DebugConfigurationProvider {
  return {
    provideDebugConfigurations: async () => {
      // Name must match the UX requirement: show "dotnet-start" in the native picker.
      return [getDotnetStartConfiguration()];
    },
    resolveDebugConfiguration: async (folder, debugConfiguration) => {
      if (debugConfiguration?.name !== constants.DOTNET_START_CONFIGURATION_NAME) {
        return debugConfiguration;
      }

      const alreadyResolved =
        Boolean(debugConfiguration && typeof debugConfiguration === 'object') &&
        Boolean(
          (debugConfiguration as Record<string, unknown>)[
          constants.DOTNET_START_RESOLVED_FLAG
          ],
        );
      if (alreadyResolved) {
        return debugConfiguration;
      }

      const debugConfig = await resolveVscodeDebugConfiguration(manager);
      if (!debugConfig) {
        return undefined;
      }
      return debugConfig;
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
        getDotnetStartConfiguration(),
      ];
    },
  };
}

export function activate(context: vscode.ExtensionContext) {
  OutputChannelService.initialize(context);

  const manager = new DotnetStartManager(context.workspaceState);

  const provider = createDotnetStartDebugConfigurationProvider(manager);
  const initialProvider = createDotnetStartInitialDebugConfigurationProvider();

  // Provide a dynamic configuration so it shows up in the native F5 picker.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'coreclr',
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    ),
  );

  // Provide an initial configuration so VS Code can offer dotnet-start when creating
  // .vscode/launch.json for the first time.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'coreclr',
      initialProvider,
      vscode.DebugConfigurationProviderTriggerKind.Initial
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.selectStartProject', async () => {
      await manager.selectStartProject();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.selectLaunchProfile', async () => {
      const csprojUri = await manager.ensureSelectedProject();
      if (!csprojUri) {
        return;
      }
      await manager.selectLaunchProfile(csprojUri);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.start', async () => {
      await runAltF5Picker(manager);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.addLaunchConfiguration', async () => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        void vscode.window.showErrorMessage('No workspace folder is open.');
        return;
      }

      await addDotnetStartLaunchConfigurationToLaunchJson(wsFolder);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dotnetStart.clearState', async () => {
      await manager.clearState();
      void vscode.window.showInformationMessage('Cleared dotnet-start saved state for this workspace.');
    })
  );
}

export function deactivate() {
  // No-op
}
