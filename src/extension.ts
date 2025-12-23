import * as vscode from 'vscode';
import { CsprojService } from './services/csprojService';
import { DotnetStartManager } from './services/dotnetStartManager';
import { OutputChannelService } from './services/outputChannelService';
import * as constants from './shared/constants';
import {
  hasDotnetStartLaunchConfiguration,
  safeJsonStringify,
} from './shared/utils';

const csprojService = new CsprojService();

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

function markDotnetStartResolved<T extends vscode.DebugConfiguration>(config: T): T {
  // VS Code will re-invoke resolveDebugConfiguration even for configurations passed to startDebugging.
  // Mark generated configs so our resolver can avoid re-building and causing duplicate dotnet builds.
  return { ...config, [constants.DOTNET_START_RESOLVED_FLAG]: true };
}

async function buildDotnetStartDebugConfiguration(
  manager: DotnetStartManager,
): Promise<{ wsFolder: vscode.WorkspaceFolder; debugConfig: vscode.DebugConfiguration } | undefined> {
  const output = OutputChannelService.channel;
  const csprojUri = await manager.ensureSelectedProject();
  if (!csprojUri) {
    return undefined;
  }

  const profile = await manager.ensureSelectedProfile(csprojUri);
  if (!profile) {
    return undefined;
  }

  const wsFolder = manager.getWorkspaceFolderForProject(csprojUri);
  if (!wsFolder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return undefined;
  }

  const buildOk = await csprojService.runDotnetBuildAndPipeOutput(csprojUri);
  if (!buildOk) {
    output.appendLine('');
    output.appendLine('Build status: FAILED');
    void vscode.window.showErrorMessage(
      'dotnet build failed. See Output → dotnet-start for details.',
    );
    return undefined;
  }

  output.appendLine('');
  output.appendLine('Build status: SUCCEEDED');

  const debugConfig = await csprojService.buildCoreclrDotnetStartConfiguration({
    csprojUri,
    profileName: profile,
    configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
  });
  if (!debugConfig) {
    return undefined;
  }

  const resolvedDebugConfig = markDotnetStartResolved(debugConfig);

  output.appendLine('');
  output.appendLine('Resolved debug configuration:');
  output.appendLine(safeJsonStringify(resolvedDebugConfig));

  return { wsFolder, debugConfig: resolvedDebugConfig };
}

async function startDotnetDebugging(
  manager: DotnetStartManager,
): Promise<void> {
  const built = await buildDotnetStartDebugConfiguration(manager);
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

async function startDotnetDebuggingWithOneOffProfile(
  manager: DotnetStartManager,
): Promise<void> {
  const csprojUri = await manager.ensureSelectedProject();
  if (!csprojUri) {
    return;
  }

  const profile = await manager.selectLaunchProfileOnce(csprojUri);
  if (!profile) {
    return;
  }

  const wsFolder = manager.getWorkspaceFolderForProject(csprojUri);
  if (!wsFolder) {
    void vscode.window.showErrorMessage('No workspace folder is open.');
    return;
  }

  const buildOk = await csprojService.runDotnetBuildAndPipeOutput(csprojUri);
  if (!buildOk) {
    void vscode.window.showErrorMessage(
      'dotnet build failed. See Output → dotnet-start for details.',
    );
    return;
  }

  const debugConfig = await csprojService.buildCoreclrDotnetStartConfiguration({
    csprojUri,
    profileName: profile,
    configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
  });
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
  const manager = new DotnetStartManager(context.workspaceState, csprojService);
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

export function createDotnetStartDebugConfigurationProvider(
  context: vscode.ExtensionContext,
): vscode.DebugConfigurationProvider {
  const manager = new DotnetStartManager(context.workspaceState, csprojService);
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

      const built = await buildDotnetStartDebugConfiguration(manager);
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
        getDotnetStartConfiguration(),
      ];
    },
  };
}

export function activate(context: vscode.ExtensionContext) {
  OutputChannelService.initialize(context);

  const manager = new DotnetStartManager(context.workspaceState, csprojService);

  const provider = createDotnetStartDebugConfigurationProvider(context);
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
      await runF5Picker(context);
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
