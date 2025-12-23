import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type MsbuildProjectProperties = {
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
 * Fetches and parses MSBuild project properties using `dotnet msbuild -getProperty:*`.
 */
export class MsbuildProjectPropertiesService {
  public async tryGetProjectProperties(
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

    const args = [
      'msbuild',
      csprojUri.fsPath,
      '-nologo',
      ...propertyNames.map((p) => `-getProperty:${String(p)}`),
      `-property:Configuration=${options.configuration}`,
    ];

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

  public computeExpectedTargetPath(
    csprojUri: vscode.Uri,
    configuration: 'Debug' | 'Release',
    props: MsbuildProjectProperties,
  ): string | undefined {
    const projectDir = path.dirname(csprojUri.fsPath);
    const projectName = path.parse(csprojUri.fsPath).name;

    const tfm = props.TargetFramework ?? this.splitSemicolonList(props.TargetFrameworks)[0];

    const outputPathRaw =
      (props.OutputPath && props.OutputPath.trim().length > 0 ? props.OutputPath : undefined) ??
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

    const outputDir =
      shouldAppendTfm && !normalizedOutputParts.includes(tfm.toLowerCase()) ? path.join(outputPath, tfm) : outputPath;

    const targetFileName =
      (props.TargetFileName && props.TargetFileName.trim().length > 0 ? props.TargetFileName : undefined) ??
      `${props.AssemblyName && props.AssemblyName.trim().length > 0 ? props.AssemblyName : projectName}${
        props.TargetExt ?? '.dll'
      }`;

    return path.join(outputDir, targetFileName);
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

  private parseMsbuildProperties(
    output: string,
    propertyNames: readonly (keyof MsbuildProjectProperties)[],
  ): MsbuildProjectProperties {
    const result: MsbuildProjectProperties = {};
    for (const name of propertyNames) {
      const value = this.parseMsbuildGetPropertyOutput(String(name), output);
      if (value !== undefined) {
        result[name] = value;
      }
    }
    return result;
  }
}
