import * as path from 'path';
import * as vscode from 'vscode';
import { CsprojService } from './csprojService';
import { normalizeFsPath, toWorkspaceRelativeDetail } from '../shared/utils';
import * as constants from '../shared/constants';

/**
 * Owns persistence of the selected start project (.csproj) and launch profile.
 *
 * This class intentionally handles only workspace state (no UI), so `extension.ts`
 * can focus on UX and wiring commands/providers.
 */
export class DotnetStartManager {

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly csprojService: CsprojService,
  ) { }

  public async selectStartProject(): Promise<vscode.Uri | undefined> {
    const currentlySelected = await this.getSelectedProject();
    const csprojUris = await this.findCsprojFiles();
    if (csprojUris.length === 0) {
      void vscode.window.showErrorMessage('No .csproj files found in this workspace.');
      return undefined;
    }

    const selectedKey = currentlySelected ? normalizeFsPath(currentlySelected.fsPath) : undefined;

    const items: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = csprojUris
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
          uri
        };
      });

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select start project (.csproj)',
      placeHolder: 'Choose a .csproj to use as the start project',
      matchOnDetail: true
    });
    if (!picked) {
      return undefined;
    }

    await this.setSelectedProject(picked.uri);
    return picked.uri;
  }

  public async ensureSelectedProject(): Promise<vscode.Uri | undefined> {
    return (await this.getSelectedProject()) ?? (await this.selectStartProject());
  }

  public async selectLaunchProfile(csprojUri: vscode.Uri): Promise<string | undefined> {
    const picked = await this.pickLaunchProfileInternal(csprojUri, {
      title: 'Select launch profile (launchSettings.json)',
      placeHolder: 'Choose a Visual Studio launch profile'
    });
    if (!picked) {
      return undefined;
    }
    await this.setSelectedProfile(picked);
    return picked;
  }

  public async ensureSelectedProfile(csprojUri: vscode.Uri): Promise<string | undefined> {
    return (await this.getSelectedProfile()) ?? (await this.selectLaunchProfile(csprojUri));
  }

  public async selectLaunchProfileOnce(csprojUri: vscode.Uri): Promise<string | undefined> {
    return await this.pickLaunchProfileInternal(csprojUri, {
      title: 'Select launch profile (once)',
      placeHolder: 'Choose a Visual Studio launch profile (will not be persisted)'
    });
  }

  public async pickStartAction(options: {
    configurationName: string;
  }): Promise<'run-selected' | 'run-once-profile' | undefined> {
    const selectedCsproj = await this.getSelectedProject();
    const selectedProfile = await this.getSelectedProfile();

    const currentProjectName = selectedCsproj ? path.parse(selectedCsproj.fsPath).name : undefined;

    type ActionPickItem = vscode.QuickPickItem & {
      action: 'run-selected' | 'run-once-profile';
    };

    const runSelectedItem: ActionPickItem = {
      label: options.configurationName,
      description:
        currentProjectName && selectedProfile ? `${currentProjectName} / ${selectedProfile}` : undefined,
      detail:
        selectedCsproj && selectedProfile
          ? toWorkspaceRelativeDetail(selectedCsproj)
          : 'Runs the selected start project and launch profile',
      action: 'run-selected',
    };

    const runOnceItem: ActionPickItem = {
      label: 'Run another profile (once)',
      detail: 'Starts debugging with a one-off launch profile (does not change the saved selection)',
      action: 'run-once-profile'
    };

    const picked = await this.showPreselectedQuickPick<ActionPickItem>(
      [runSelectedItem, runOnceItem],
      runSelectedItem,
      {
        title: 'Start debugging',
        placeHolder: 'Choose a debug action'
      },
    );
    return picked?.action;
  }

  public getWorkspaceFolderForProject(csprojUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return this.getWorkspaceFolderForUri(csprojUri) ?? this.getAnyWorkspaceFolder();
  }

  public async getSelectedProject(): Promise<vscode.Uri | undefined> {
    const stored = this.workspaceState.get<string>(constants.STATE_KEY_CSPROJ);
    if (!stored) {
      return undefined;
    }

    try {
      return vscode.Uri.parse(stored);
    } catch {
      return undefined;
    }
  }

  public async setSelectedProject(projectUri: vscode.Uri): Promise<void> {
    const previous = await this.getSelectedProject();
    if (previous) {
      const prevKey = normalizeFsPath(previous.fsPath);
      const nextKey = normalizeFsPath(projectUri.fsPath);
      if (prevKey !== nextKey) {
        await this.clearSelectedProfile();
      }
    }

    await this.workspaceState.update(constants.STATE_KEY_CSPROJ, projectUri.toString());
  }

  public async getSelectedProfile(): Promise<string | undefined> {
    return this.workspaceState.get<string>(constants.STATE_KEY_LAUNCH_PROFILE);
  }

  public async setSelectedProfile(profileName: string): Promise<void> {
    await this.workspaceState.update(constants.STATE_KEY_LAUNCH_PROFILE, profileName);
  }

  public async clearSelectedProfile(): Promise<void> {
    await this.workspaceState.update(constants.STATE_KEY_LAUNCH_PROFILE, undefined);
  }

  public async clearState(): Promise<void> {
    await this.workspaceState.update(constants.STATE_KEY_CSPROJ, undefined);
    await this.workspaceState.update(constants.STATE_KEY_LAUNCH_PROFILE, undefined);
  }

  private async findCsprojFiles(): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules,.git,.vs}/**');
  }

  private getWorkspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  private getAnyWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private async pickLaunchProfileInternal(
    csprojUri: vscode.Uri,
    options: { title: string; placeHolder: string },
  ): Promise<string | undefined> {
    const launchSettingsUri = await this.csprojService.getLaunchSettingsUriForProject(csprojUri);
    if (!launchSettingsUri) {
      void vscode.window.showErrorMessage(
        `No launchSettings.json found for ${path.basename(csprojUri.fsPath)} (expected Properties/launchSettings.json).`,
      );
      return undefined;
    }

    let profileNames: string[];
    try {
      profileNames = await this.csprojService.readLaunchProfileNames(launchSettingsUri);
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

    const items: Array<vscode.QuickPickItem & { profileName: string }> = profileNames.map((profileName) => ({
      label: profileName,
      profileName
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: options.title,
      placeHolder: options.placeHolder,
      matchOnDescription: true
    });
    if (!picked) {
      return undefined;
    }

    return picked.profileName;
  }

  private async showPreselectedQuickPick<T extends vscode.QuickPickItem>(
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
}
