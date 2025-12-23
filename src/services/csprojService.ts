import * as path from 'path';
import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as readline from 'readline';

import {
  MsbuildProjectProperties,
  MsbuildProjectPropertiesService,
} from './msbuildProjectPropertiesService';
import { OutputChannelService } from './outputChannelService';

type LaunchProfileDetails = {
  commandName?: string;
  commandLineArgs?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
};

/**
 * Builds and starts `coreclr` debug configurations for a selected `.csproj` + launch profile.
 *
 * This class owns:
 * - Reading `launchSettings.json`
 * - MSBuild property extraction (`dotnet msbuild -getProperty:*`)
 * - Resolving the output binary path (TargetPath / fallback search)
 * - Constructing the final VS Code debug configuration
 */
export class CsprojService {
  private readonly msbuild = new MsbuildProjectPropertiesService();

  private log(message: string): void {
    OutputChannelService.appendLine(`[dotnet-start] ${message}`);
  }

  private toWorkspaceRelative(uri: vscode.Uri): string {
    try {
      return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
    } catch {
      return uri.fsPath;
    }
  }

  private pickProperties(
    allProperties: Record<string, string | undefined>,
    names: readonly string[],
  ): Record<string, string | undefined> {
    const picked: Record<string, string | undefined> = {};
    for (const name of names) {
      const v = allProperties[name];
      if (typeof v === 'string' && v.trim().length > 0) {
        picked[name] = v.trim();
      }
    }
    return picked;
  }

  public parseMsbuildProperties(output: string, names: readonly string[]): Record<string, string | undefined> {
    const all = this.msbuild.parseMsbuildProperties(output);
    return this.pickProperties(all, names);
  }

  private computeExpectedTargetPathFromMsbuildProperties(
    csprojUri: vscode.Uri,
    configuration: 'Debug' | 'Release',
    props: Record<string, string | undefined>,
  ): string | undefined {
    return this.msbuild.computeExpectedTargetPath(csprojUri, configuration, props as MsbuildProjectProperties);
  }

  public async getLaunchSettingsUriForProject(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const projectDir = path.dirname(csprojUri.fsPath);
    const candidates = [
      vscode.Uri.file(path.join(projectDir, 'Properties', 'launchSettings.json')),
      vscode.Uri.file(path.join(projectDir, 'launchSettings.json')),
    ];

    this.log(`Searching launchSettings.json for ${this.toWorkspaceRelative(csprojUri)}.`);

    for (const candidate of candidates) {
      try {
        await vscode.workspace.fs.stat(candidate);
        this.log(`Found launchSettings.json at ${this.toWorkspaceRelative(candidate)}.`);
        return candidate;
      } catch {
        // ignore
      }
    }

    this.log('No launchSettings.json found (checked Properties/launchSettings.json and launchSettings.json).');
    return undefined;
  }

  public async readLaunchProfileNames(launchSettingsUri: vscode.Uri): Promise<string[]> {
    this.log(`Reading launch profiles from ${this.toWorkspaceRelative(launchSettingsUri)}.`);
    const bytes = await vscode.workspace.fs.readFile(launchSettingsUri);
    const text = Buffer.from(bytes).toString('utf8');
    const json = JSON.parse(text) as unknown;

    if (!json || typeof json !== 'object') {
      return [];
    }

    const profiles = (json as { profiles?: unknown }).profiles;
    if (!profiles || typeof profiles !== 'object') {
      this.log('launchSettings.json has no "profiles" object.');
      return [];
    }

    const names = Object.keys(profiles as Record<string, unknown>).sort((a, b) => a.localeCompare(b));
    this.log(`Found ${names.length} launch profile(s).`);
    return names;
  }

  public async buildCoreclrDotnetStartConfiguration(options: {
    csprojUri: vscode.Uri;
    profileName: string;
    configurationName: string;
  }): Promise<vscode.DebugConfiguration | undefined> {
    const { csprojUri, profileName, configurationName } = options;
    const projectDir = path.dirname(csprojUri.fsPath);

    this.log(`Building debug configuration "${configurationName}" for ${this.toWorkspaceRelative(csprojUri)} (profile: ${profileName}).`);

    const launchSettingsUri = await this.getLaunchSettingsUriForProject(csprojUri);
    if (!launchSettingsUri) {
      void vscode.window.showErrorMessage(
        `No launchSettings.json found for ${path.basename(csprojUri.fsPath)} (expected Properties/launchSettings.json).`,
      );
      return undefined;
    }

    let details: LaunchProfileDetails | undefined;
    try {
      details = await this.readLaunchProfileDetails(launchSettingsUri, profileName);
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

    this.log('Resolving target binary path (Debug).');

    let resolved = await this.resolveTargetBinaryPath(csprojUri);
    this.log(`Resolved binary: ${this.toWorkspaceRelative(resolved.binaryUri)} (source: ${resolved.source}).`);
    if (!(await this.fileExists(resolved.binaryUri))) {
      void vscode.window.showErrorMessage(
        `Build output was not found at ${resolved.binaryUri.fsPath}. (resolved via ${resolved.source})`,
      );
      return undefined;
    }

    const env = { ...(details.environmentVariables ?? {}) };
    if (details.applicationUrl && !env.ASPNETCORE_URLS) {
      env.ASPNETCORE_URLS = details.applicationUrl;
    }

    const runtimeArgs = this.parseCommandLineArgs(details.commandLineArgs);

    this.log(`Runtime args: ${runtimeArgs.length > 0 ? runtimeArgs.join(' ') : '(none)'}`);
    this.log(`Env vars: ${Object.keys(env).length} key(s).`);

    return {
      type: 'coreclr',
      request: 'launch',
      name: configurationName,
      program: 'dotnet',
      args: [resolved.binaryUri.fsPath, ...runtimeArgs],
      cwd: projectDir,
      console: 'integratedTerminal',
      internalConsoleOptions: 'neverOpen',
      env,
    };
  }

  private coerceStringRecord(value: unknown): Record<string, string> {
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

  private async readLaunchProfileDetails(
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
      environmentVariables: this.coerceStringRecord(record.environmentVariables),
    };
  }

  private parseCommandLineArgs(text: string | undefined): string[] {
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

  private async fileExists(fileUri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(fileUri);
      return true;
    } catch {
      return false;
    }
  }

  private async findFallbackOutputDll(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const projectDir = path.dirname(csprojUri.fsPath);
    const projectName = path.parse(csprojUri.fsPath).name;
    const base = vscode.Uri.file(projectDir);

    this.log('Attempting fallback DLL search under bin/Debug.');

    const preferredPattern = new vscode.RelativePattern(base, `bin/Debug/**/${projectName}.dll`);
    const preferred = await vscode.workspace.findFiles(preferredPattern, '**/{obj,node_modules,.git,.vs}/**', 2);
    if (preferred.length > 0) {
      this.log(`Fallback search hit (preferred): ${this.toWorkspaceRelative(preferred[0])}.`);
      return preferred[0];
    }

    const anyDebugDllPattern = new vscode.RelativePattern(base, 'bin/Debug/**/*.dll');
    const anyDebug = await vscode.workspace.findFiles(anyDebugDllPattern, '**/{obj,node_modules,.git,.vs}/**', 20);
    if (anyDebug.length > 0) {
      const exact = anyDebug.find((u) => path.basename(u.fsPath).toLowerCase() === `${projectName.toLowerCase()}.dll`);
      this.log(`Fallback search hit (bin/Debug/**/*.dll): ${this.toWorkspaceRelative((exact ?? anyDebug[0])!)}.`);
      return exact ?? anyDebug[0];
    }

    const anyDllPattern = new vscode.RelativePattern(base, '**/*.dll');
    const anyDll = await vscode.workspace.findFiles(anyDllPattern, '**/{obj,node_modules,.git,.vs}/**', 50);
    if (anyDll.length > 0) {
      const exact = anyDll.find((u) => path.basename(u.fsPath).toLowerCase() === `${projectName.toLowerCase()}.dll`);
      this.log(`Fallback search hit (any dll): ${this.toWorkspaceRelative((exact ?? anyDll[0])!)}.`);
      return exact ?? anyDll[0];
    }

    this.log('Fallback DLL search found nothing.');
    return undefined;
  }

  private logMsbuildProjectProperties(props: MsbuildProjectProperties): void {
    const keys: readonly (keyof MsbuildProjectProperties)[] = [
      'TargetPath',
      'TargetFramework',
      'TargetFrameworks',
      'OutputPath',
      'BaseOutputPath',
      'AssemblyName',
      'TargetExt',
      'TargetFileName',
      'AppendTargetFrameworkToOutputPath',
    ];

    this.log('MSBuild properties:');
    for (const k of keys) {
      const v = props[k];
      const value = typeof v === 'string' && v.trim().length > 0 ? v : '<unset>';
      this.log(`  ${String(k)} = ${value}`);
    }
  }

  private async resolveTargetBinaryPath(
    csprojUri: vscode.Uri,
  ): Promise<{ binaryUri: vscode.Uri; source: 'msbuild' | 'fallback-search' }> {
    const projectDir = path.dirname(csprojUri.fsPath);
    const projectName = path.parse(csprojUri.fsPath).name;

    const props: MsbuildProjectProperties | undefined = await this.msbuild.tryGetProjectProperties(csprojUri, {
      configuration: 'Debug',
    });
    if (props) {
      this.log('MSBuild properties fetched successfully.');
      this.logMsbuildProjectProperties(props);

      const directTargetPath = props.TargetPath && props.TargetPath.trim().length > 0 ? props.TargetPath : undefined;
      if (directTargetPath) {
        const normalized = directTargetPath.trim();
        const absolute = path.isAbsolute(normalized) ? normalized : path.join(projectDir, normalized);
        this.log(`Using MSBuild TargetPath: ${absolute}.`);
        return { binaryUri: vscode.Uri.file(absolute), source: 'msbuild' };
      }

      const computed = this.msbuild.computeExpectedTargetPath(csprojUri, 'Debug', props);
      if (computed) {
        this.log(`Computed expected target path from MSBuild properties: ${computed}.`);
        return { binaryUri: vscode.Uri.file(computed), source: 'msbuild' };
      }

      this.log('MSBuild did not provide TargetPath or a computable target path; trying fallback DLL search.');
    } else {
      this.log('Failed to fetch MSBuild properties (dotnet msbuild -getProperty:*).');
    }

    const fallback = await this.findFallbackOutputDll(csprojUri);
    if (fallback) {
      return { binaryUri: fallback, source: 'fallback-search' };
    }

    // Last resort: point at a reasonable default so we can error clearly if it's missing.
    return {
      binaryUri: vscode.Uri.file(path.join(projectDir, 'bin', 'Debug', `${projectName}.dll`)),
      source: 'fallback-search',
    };
  }

  public async runDotnetBuild(
    csprojUri: vscode.Uri,
    options?: {
      onStdoutLine?: (line: string) => void;
      onStderrLine?: (line: string) => void;
      timeoutMs?: number;
      cancellationToken?: vscode.CancellationToken;
    },
  ): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; message: string; stdout: string; stderr: string }> {
    const skipBuild =
      process.env.DOTNET_START_SKIP_DOTNET_BUILD === '1' ||
      process.env.DOTNET_START_SKIP_DOTNET_BUILD?.toLowerCase() === 'true';
    if (skipBuild) {
      return {
        ok: true,
        stdout: 'dotnet build skipped (DOTNET_START_SKIP_DOTNET_BUILD is set).',
        stderr: '',
      };
    }

    const projectDir = path.dirname(csprojUri.fsPath);
    try {
      const timeoutMs = options?.timeoutMs ?? 120_000;
      const args = ['build', csprojUri.fsPath, '-c', 'Debug', '-v', 'minimal'];

      const child = childProcess.spawn('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;

      const kill = () => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      };

      const timeoutHandle = setTimeout(() => {
        killedByTimeout = true;
        kill();
      }, timeoutMs);

      const cancellationDisposable = options?.cancellationToken?.onCancellationRequested(() => {
        kill();
      });

      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;

      const stdoutRl = stdoutStream
        ? readline.createInterface({ input: stdoutStream, crlfDelay: Infinity })
        : undefined;
      const stderrRl = stderrStream
        ? readline.createInterface({ input: stderrStream, crlfDelay: Infinity })
        : undefined;

      stdoutRl?.on('line', (line) => {
        stdout += `${line}\n`;
        options?.onStdoutLine?.(line);
      });
      stderrRl?.on('line', (line) => {
        stderr += `${line}\n`;
        options?.onStderrLine?.(line);
      });

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('error', (err) => reject(err));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      clearTimeout(timeoutHandle);
      cancellationDisposable?.dispose();
      stdoutRl?.close();
      stderrRl?.close();

      const ok = result.code === 0;
      if (ok) {
        return { ok: true, stdout, stderr };
      }

      const reason = killedByTimeout
        ? `timed out after ${timeoutMs}ms`
        : result.signal
          ? `terminated by signal ${result.signal}`
          : `exited with code ${String(result.code)}`;

      return { ok: false, message: reason, stdout, stderr };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stdout =
        typeof (e as { stdout?: unknown }).stdout === 'string' ? (e as { stdout?: string }).stdout ?? '' : '';
      const stderr =
        typeof (e as { stderr?: unknown }).stderr === 'string' ? (e as { stderr?: string }).stderr ?? '' : '';
      return { ok: false, message, stdout, stderr };
    }
  }

  /**
   * Runs `dotnet build` for the given project and pipes output to the shared dotnet-start output channel.
   * Returns `true` when the build succeeds.
   */
  public async runDotnetBuildAndPipeOutput(csprojUri: vscode.Uri): Promise<boolean> {
    const output = OutputChannelService.channel;
    output.clear();
    output.appendLine(`dotnet build ${this.toWorkspaceRelative(csprojUri)} -c Debug -v minimal`);
    output.appendLine('');
    output.show(true);

    const result = await this.runDotnetBuild(csprojUri, {
      onStdoutLine: (line) => output.appendLine(line),
      onStderrLine: (line) => output.appendLine(line),
    });

    if (!result.ok) {
      output.appendLine('');
      output.appendLine(`dotnet build failed: ${result.message}`);
      return false;
    }

    return true;
  }
}
