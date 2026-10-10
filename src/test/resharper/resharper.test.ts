import * as assert from 'assert';
import * as vscode from 'vscode';

import { CsprojInstance } from '../../services/csprojInstance';
import * as constants from '../../shared/constants';

type DapMessage = { type?: string; event?: string; command?: string; success?: boolean; message?: string; body?: unknown };

suite('dotnet-start with the installed .NET debugger', () => {
  test('debug configuration hits a breakpoint under the installed coreclr adapter', async function () {
    this.timeout(120_000);

    const debuggerExtensionId = process.env.DOTNET_START_DEBUGGER_EXTENSION ?? 'JetBrains.resharper-code';
    const debuggerExtension = vscode.extensions.getExtension(debuggerExtensionId);
    assert.ok(debuggerExtension, `${debuggerExtensionId} is not installed in the test host.`);
    await debuggerExtension.activate();

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(wsFolder, 'Expected the resharper-app workspace folder.');

    const csprojUri = vscode.Uri.joinPath(wsFolder.uri, 'ResharperApp.csproj');
    const programUri = vscode.Uri.joinPath(wsFolder.uri, 'Program.cs');
    const csproj = new CsprojInstance(csprojUri);

    process.env.DOTNET_START_SKIP_DOTNET_BUILD = '1';
    const config = await csproj.createVscodeDebugConfiguration({
      profileName: undefined,
      configurationName: constants.DOTNET_START_CONFIGURATION_NAME,
    });
    assert.ok(config, 'Expected a debug configuration.');
    console.log(`Debug configuration: ${JSON.stringify(config)}`);

    const messages: DapMessage[] = [];
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('coreclr', {
      createDebugAdapterTracker: () => ({
        onDidSendMessage: (m: DapMessage) => messages.push(m),
        onError: (e: Error) => console.log(`DAP error: ${e.message}`),
      }),
    });

    const stopped = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((m) => m.event === 'stopped')) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
    const terminated = new Promise<void>((resolve) => {
      const d = vscode.debug.onDidTerminateDebugSession(() => {
        d.dispose();
        resolve();
      });
    });

    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(programUri, new vscode.Position(1, 0)));
    vscode.debug.addBreakpoints([breakpoint]);

    try {
      // ReSharper registers its adapters only once its backend is up; retry until it is.
      let started = false;
      const deadline = Date.now() + 90_000;
      while (!started && Date.now() < deadline) {
        try {
          started = await vscode.debug.startDebugging(wsFolder, config);
        } catch (e) {
          console.log(`startDebugging failed, retrying: ${String(e)}`);
        }
        if (!started) {
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
      assert.ok(started, 'startDebugging returned false.');

      const outcome = await Promise.race([
        stopped.then(() => 'stopped'),
        terminated.then(() => 'terminated'),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 90_000)),
      ]);

      console.log(`Outcome: ${outcome}`);
      console.log(`DAP messages: ${JSON.stringify(messages.map((m) => m.event ?? `${m.command}:${String(m.success)}${m.message ? ` (${m.message})` : ''}`))}`);
      assert.strictEqual(outcome, 'stopped', 'Expected the breakpoint to be hit.');
    } finally {
      tracker.dispose();
      vscode.debug.removeBreakpoints([breakpoint]);
      await vscode.debug.stopDebugging();
    }
  });
});
