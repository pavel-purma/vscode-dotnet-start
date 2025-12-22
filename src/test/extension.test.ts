import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

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
		const originalStartDebugging = vscode.debug.startDebugging;

		let capturedFolder: vscode.WorkspaceFolder | undefined;
		let capturedConfig: vscode.DebugConfiguration | undefined;
		let quickPickCalls = 0;

		try {
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
			(vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
		}
	});

	test('dotnetStart.f5 shows dotnet-start entry and triggers debugging when picked', async () => {
		const originalShowQuickPick = vscode.window.showQuickPick;
		const originalStartDebugging = vscode.debug.startDebugging;

		let sawF5Item = false;
		let startDebuggingCalls = 0;

		try {
			(vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = (async (
				items: readonly AnyQuickPickItem[],
			) => {
				assert.ok(items.length > 0, 'Expected QuickPick items.');
				const first = items[0];
				if (typeof first === 'object' && first && 'action' in first) {
					sawF5Item = items.some((i) => typeof i === 'object' && i && i.label === 'dotnet-start');
					return first as unknown; // pick dotnet-start
				}

				if (typeof first === 'object' && first && 'uri' in first) {
					return items[0] as unknown;
				}

				if (typeof first === 'object' && first && 'profileName' in first) {
					return items.find((i) => typeof i === 'object' && i && 'profileName' in i && i.profileName === 'Prod') as unknown;
				}

				return first as unknown;
			}) as unknown;

			(vscode.debug as unknown as { startDebugging: unknown }).startDebugging = (async () => {
				startDebuggingCalls++;
				return true;
			}) as unknown;

			await vscode.commands.executeCommand('dotnetStart.f5');

			assert.ok(sawF5Item, 'Expected the F5 picker to include a dotnet-start entry.');
			assert.strictEqual(startDebuggingCalls, 1, 'Expected picking dotnet-start to start debugging once.');
		} finally {
			(vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalShowQuickPick as unknown;
			(vscode.debug as unknown as { startDebugging: unknown }).startDebugging = originalStartDebugging as unknown;
		}
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
});
