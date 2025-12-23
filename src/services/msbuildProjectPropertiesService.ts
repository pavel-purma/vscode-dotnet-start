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

  public async getMsbuildProjectProperties(
    csprojUri: vscode.Uri,
    options: { configuration: 'Debug' | 'Release' },
  ): Promise<MsbuildProjectProperties> {
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
      const { stdout } = await execFileAsync('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        timeout: 15_000,
      });
      // Assume dotnet/msbuild emits JSON on stdout; stderr can contain non-JSON warnings.
      const parsedAll = this.parseMsbuildProperties(stdout);
      if (!parsedAll || Object.keys(parsedAll).length === 0) {
        throw new Error('MSBuild properties JSON does not contain any properties.');
      }
      const parsed: MsbuildProjectProperties = {
        TargetPath: this.trimOrUndefined(parsedAll.TargetPath),
        TargetFramework: this.trimOrUndefined(parsedAll.TargetFramework),
        TargetFrameworks: this.trimOrUndefined(parsedAll.TargetFrameworks),
        OutputPath: this.trimOrUndefined(parsedAll.OutputPath),
        BaseOutputPath: this.trimOrUndefined(parsedAll.BaseOutputPath),
        AssemblyName: this.trimOrUndefined(parsedAll.AssemblyName),
        TargetExt: this.trimOrUndefined(parsedAll.TargetExt),
        TargetFileName: this.trimOrUndefined(parsedAll.TargetFileName),
        AppendTargetFrameworkToOutputPath: this.trimOrUndefined(parsedAll.AppendTargetFrameworkToOutputPath),
      };
      return parsed;
    } catch {
      throw new Error('Failed to retrieve MSBuild project properties via dotnet msbuild.');
    }
  }

  private trimOrUndefined(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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

    const appendTfm = MsbuildProjectPropertiesService.convertMsbuildPropertyToBoolean(props.AppendTargetFrameworkToOutputPath);
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
      `${props.AssemblyName && props.AssemblyName.trim().length > 0 ? props.AssemblyName : projectName}${props.TargetExt ?? '.dll'
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

  private static convertMsbuildPropertyToBoolean(value: string | undefined): boolean | undefined {
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

  private parseMsbuildProperties(output: string): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    const trimmed = output.trim();
    if (trimmed.length === 0) {
      return result;
    }

    const json = JSON.parse(trimmed) as unknown;
    const properties = (json as { Properties?: unknown } | undefined)?.Properties;
    if (properties && typeof properties === 'object') {
      const record = properties as Record<string, unknown>;
      for (const [name, raw] of Object.entries(record)) {
        if (typeof raw === 'string') {
          const v = raw.trim();
          if (v.length > 0) {
            result[name] = v;
          }
        }
      }
    }
    return result;
  }
}
