import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The unit tests scan their workspace for .csproj files, so keep the committed ReSharper fixture out of it.
const unitWorkspace = path.join(__dirname, 'out', 'unit-workspace');
fs.mkdirSync(unitWorkspace, { recursive: true });

export default defineConfig([
	{
		label: 'unit',
		files: 'out/test/*.test.js',
		workspaceFolder: unitWorkspace,
	},
	{
		// Real debug sessions through the JetBrains ReSharper debugger (needs network on first run
		// to install the extension). Run with: pnpm exec vscode-test --label resharper
		label: 'resharper',
		files: 'out/test/resharper/**/*.test.js',
		workspaceFolder: path.join(__dirname, 'test-fixtures', 'resharper-app'),
		installExtensions: ['JetBrains.resharper-code'],
		mocha: { timeout: 120_000 },
	},
	{
		// Same breakpoint test through the Microsoft C# debugger (installs the extension on first run).
		label: 'csharp',
		files: 'out/test/resharper/**/*.test.js',
		workspaceFolder: path.join(__dirname, 'test-fixtures', 'resharper-app'),
		// Install first with: .vscode-test/<vscode>/bin/code.cmd --user-data-dir .vscode-test/user-data-csharp --extensions-dir .vscode-test/extensions-csharp --install-extension ms-dotnettools.csharp
		launchArgs: ['--user-data-dir', path.join(__dirname, '.vscode-test', 'user-data-csharp'), '--extensions-dir', path.join(__dirname, '.vscode-test', 'extensions-csharp')],
		env: { DOTNET_START_DEBUGGER_EXTENSION: 'ms-dotnettools.csharp' },
		mocha: { timeout: 180_000 },
	},
]);
