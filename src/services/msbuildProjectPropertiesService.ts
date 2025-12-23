import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
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
      const { stdout } = await execFileAsync('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        timeout: 15_000,
      });
      // Assume dotnet/msbuild emits JSON on stdout; stderr can contain non-JSON warnings.
      const parsedAll = this.parseMsbuildProperties(stdout);
      const parsed = this.pickProperties(parsedAll, propertyNames) as MsbuildProjectProperties;
      const hasAny = propertyNames.some((p) => {
        const v = parsed[String(p) as keyof MsbuildProjectProperties];
        return typeof v === 'string' && v.trim().length > 0;
      });
      if (hasAny) {
        return parsed;
      }

      // Fallback: some MSBuild versions or hosts don't emit parseable output for -getProperty.
      // Import a tiny temporary targets file that prints properties in a stable `Name = Value` format.
      const fallback = await this.tryGetProjectPropertiesViaTargetsImport(csprojUri, options, propertyNames);
      return fallback;
    } catch {
      return undefined;
    }
  }

  private async tryGetProjectPropertiesViaTargetsImport(
    csprojUri: vscode.Uri,
    options: { configuration: 'Debug' | 'Release' },
    propertyNames: readonly (keyof MsbuildProjectProperties)[],
  ): Promise<MsbuildProjectProperties | undefined> {
    const projectDir = path.dirname(csprojUri.fsPath);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnet-start-msbuild-'));
    const targetsPath = path.join(tempDir, 'dotnet-start.props.targets');

    const lines = propertyNames
      .map((p) => {
        const name = String(p);
        return `    <Message Importance="High" Text="${name} = $(${name})" />`;
      })
      .join('\n');

    const targetsContents = [
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      '  <Target Name="DotnetStart_PrintProperties">',
      lines,
      '  </Target>',
      '</Project>',
      '',
    ].join('\n');

    try {
      await fs.writeFile(targetsPath, targetsContents, { encoding: 'utf8' });

      const args = [
        'msbuild',
        csprojUri.fsPath,
        '-nologo',
        '-verbosity:minimal',
        '-target:DotnetStart_PrintProperties',
        `-property:Configuration=${options.configuration}`,
        `-property:CustomAfterMicrosoftCommonTargets=${targetsPath}`,
      ];

      const { stdout, stderr } = await execFileAsync('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const parsedAll = this.parseMsbuildProperties(stdout);
      const parsed = this.pickProperties(parsedAll, propertyNames) as MsbuildProjectProperties;
      const hasAny = propertyNames.some((p) => {
        const v = parsed[String(p) as keyof MsbuildProjectProperties];
        return typeof v === 'string' && v.trim().length > 0;
      });
      return hasAny ? parsed : undefined;
    } catch {
      return undefined;
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
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

    const appendTfm = this.convertMsbuildPropertyToBoolean(props.AppendTargetFrameworkToOutputPath);
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

  private convertMsbuildPropertyToBoolean(value: string | undefined): boolean | undefined {
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

  public parseMsbuildProperties(output: string): Record<string, string | undefined> {
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
      return result;
    }
    throw new Error('MSBuild properties JSON does not contain a valid "Properties" object.');
  }
}
