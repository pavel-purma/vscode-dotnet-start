import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type LaunchProfileDetails = {
  commandName?: string;
  commandLineArgs?: string;
  applicationUrl?: string;
  environmentVariables?: Record<string, string>;
};

type MsbuildProjectProperties = {
  TargetPath?: string;
  TargetFramework?: string;
  TargetFrameworks?: string;
  OutputPath?: string;
  BaseOutputPath?: string;
  AssemblyName?: string;
  TargetExt?: string;
  TargetFileName?: string;
  AppendTargetFrameworkToOutputPath?: string;
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
export class DotnetStartDebugService {
  public async getLaunchSettingsUriForProject(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
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

  public async readLaunchProfileNames(launchSettingsUri: vscode.Uri): Promise<string[]> {
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

  public async buildCoreclrDotnetStartConfiguration(options: {
    csprojUri: vscode.Uri;
    profileName: string;
    configurationName: string;
  }): Promise<vscode.DebugConfiguration | undefined> {
    const { csprojUri, profileName, configurationName } = options;
    const projectDir = path.dirname(csprojUri.fsPath);

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

    let resolved = await this.resolveTargetBinaryPath(csprojUri);
    if (!(await this.fileExists(resolved.binaryUri))) {
      const buildResult = await this.tryDotnetBuild(csprojUri);
      if (!buildResult.ok) {
        void vscode.window.showErrorMessage(
          `dotnet build failed. Ensure .NET SDK is installed and "dotnet" is on PATH. ${buildResult.message}`,
        );
        return undefined;
      }

      resolved = await this.resolveTargetBinaryPath(csprojUri);
      if (!(await this.fileExists(resolved.binaryUri))) {
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

    const runtimeArgs = this.parseCommandLineArgs(details.commandLineArgs);

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

  private splitSemicolonList(value: string | undefined): string[] {
    if (!value) {
      return [];
    }
    return value
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  private parseMsbuildGetPropertyOutput(propertyName: string, output: string): string | undefined {
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

  private parseBooleanMsbuildProperty(value: string | undefined): boolean | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
    return undefined;
  }

  private parseMsbuildProperties(output: string, propertyNames: readonly (keyof MsbuildProjectProperties)[]): MsbuildProjectProperties {
    const result: MsbuildProjectProperties = {};
    for (const name of propertyNames) {
      const value = this.parseMsbuildGetPropertyOutput(String(name), output);
      if (value !== undefined) {
        result[name] = value;
      }
    }
    return result;
  }

  private computeExpectedTargetPathFromMsbuildProperties(
    csprojUri: vscode.Uri,
    configuration: 'Debug' | 'Release',
    props: MsbuildProjectProperties,
  ): string | undefined {
    const projectDir = path.dirname(csprojUri.fsPath);
    const projectName = path.parse(csprojUri.fsPath).name;

    const tfm = props.TargetFramework ?? this.splitSemicolonList(props.TargetFrameworks)[0];

    const outputPathRaw = (props.OutputPath && props.OutputPath.trim().length > 0 ? props.OutputPath : undefined) ??
      (props.BaseOutputPath && props.BaseOutputPath.trim().length > 0 ? props.BaseOutputPath : undefined) ??
      path.join('bin', configuration, path.sep);

    const outputPath = path.isAbsolute(outputPathRaw) ? outputPathRaw : path.join(projectDir, outputPathRaw);

    const appendTfm = this.parseBooleanMsbuildProperty(props.AppendTargetFrameworkToOutputPath);
    const shouldAppendTfm = tfm && (appendTfm ?? true);

    const normalizedOutputParts = path
      .normalize(outputPath)
      .split(path.sep)
      .filter((p) => p.length > 0)
      .map((p) => p.toLowerCase());

    const outputDir = shouldAppendTfm && !normalizedOutputParts.includes(tfm.toLowerCase()) ? path.join(outputPath, tfm) : outputPath;

    const targetFileName =
      (props.TargetFileName && props.TargetFileName.trim().length > 0 ? props.TargetFileName : undefined) ??
      `${props.AssemblyName && props.AssemblyName.trim().length > 0 ? props.AssemblyName : projectName}${props.TargetExt ?? '.dll'}`;

    return path.join(outputDir, targetFileName);
  }

  private async tryGetMsbuildProjectProperties(
    csprojUri: vscode.Uri,
    options: { configuration: 'Debug' | 'Release' },
  ): Promise<MsbuildProjectProperties | undefined> {
    const projectDir = path.dirname(csprojUri.fsPath);

    const propertyNames: readonly (keyof MsbuildProjectProperties)[] = [
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

    const args = ['msbuild', csprojUri.fsPath, '-nologo', ...propertyNames.map((p) => `-getProperty:${String(p)}`), `-property:Configuration=${options.configuration}`];

    try {
      const { stdout, stderr } = await execFileAsync('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        timeout: 15_000,
      });
      const combined = `${stdout}\n${stderr}`;
      return this.parseMsbuildProperties(combined, propertyNames);
    } catch {
      return undefined;
    }
  }

  private async findFallbackOutputDll(csprojUri: vscode.Uri): Promise<vscode.Uri | undefined> {
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

  private async resolveTargetBinaryPath(
    csprojUri: vscode.Uri,
  ): Promise<{ binaryUri: vscode.Uri; source: 'msbuild' | 'fallback-search' }> {
    const fallback = await this.findFallbackOutputDll(csprojUri);
    if (fallback) {
      return { binaryUri: fallback, source: 'fallback-search' };
    }

    const props = await this.tryGetMsbuildProjectProperties(csprojUri, { configuration: 'Debug' });
    if (props) {
      const directTargetPath = props.TargetPath && props.TargetPath.trim().length > 0 ? props.TargetPath : undefined;
      if (directTargetPath) {
        return { binaryUri: vscode.Uri.file(directTargetPath), source: 'msbuild' };
      }

      const computed = this.computeExpectedTargetPathFromMsbuildProperties(csprojUri, 'Debug', props);
      if (computed) {
        return { binaryUri: vscode.Uri.file(computed), source: 'msbuild' };
      }
    }

    return { binaryUri: vscode.Uri.file(csprojUri.fsPath), source: 'fallback-search' };
  }

  private async tryDotnetBuild(csprojUri: vscode.Uri): Promise<{ ok: true } | { ok: false; message: string }> {
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
}
