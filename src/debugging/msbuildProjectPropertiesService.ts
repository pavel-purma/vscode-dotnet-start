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
      const { stdout, stderr } = await execFileAsync('dotnet', args, {
        cwd: projectDir,
        windowsHide: true,
        timeout: 15_000,
      });
      const combined = `${stdout}\n${stderr}`;
      const parsed = this.parseMsbuildProperties(combined, propertyNames) as MsbuildProjectProperties;
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

      const combined = `${stdout}\n${stderr}`;
      const parsed = this.parseMsbuildProperties(combined, propertyNames) as MsbuildProjectProperties;
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

  private parseMsbuildGetPropertyOutput(propertyName: string, output: string): string | undefined {
    const text = output.replaceAll('\r\n', '\n');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const propertyLower = propertyName.toLowerCase();

    const parseRemainder = (remainder: string): string | undefined => {
      if (remainder.length === 0) {
        return undefined;
      }
      const first = remainder[0];
      const value = (first === '=' || first === ':') ? remainder.slice(1).trim() : remainder.trim();
      return value.length > 0 ? value : undefined;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lower = line.toLowerCase();
      if (!lower.startsWith(propertyLower)) {
        continue;
      }

      // Avoid prefix collisions like TargetFramework vs TargetFrameworks.
      const boundary = lower.slice(propertyLower.length, propertyLower.length + 1);
      if (boundary.length > 0 && boundary !== ' ' && boundary !== '\t' && boundary !== '=' && boundary !== ':') {
        continue;
      }

      // Trim the property name off and parse the remainder.
      const remainder = line.slice(propertyName.length).trimStart();
      const sameLine = parseRemainder(remainder);
      if (sameLine !== undefined) {
        return sameLine;
      }

      // Some MSBuild outputs (notably with -getProperty) print:
      //   PropertyName:
      //     value
      // Handle the "value on next non-empty line" case.
      // We only do this when the line looks like a property header (exact name, or name followed by ':' / '=').
      const headerSuffix = remainder.trim();
      const looksLikeHeader = headerSuffix.length === 0 || headerSuffix === ':' || headerSuffix === '=';
      if (!looksLikeHeader) {
        continue;
      }

      const next = lines[i + 1];
      if (typeof next === 'string' && next.trim().length > 0) {
        const value = next.trim();

        // If the "value" looks like another property header (e.g. "OutputPath:"),
        // treat this property as unset rather than mis-parsing the header as a value.
        const looksLikeHeaderLine = /^[A-Za-z_][A-Za-z0-9_.]*\s*[:=]\s*$/.test(value);
        if (!looksLikeHeaderLine && value.length > 0) {
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

  public parseMsbuildProperties(output: string, propertyNames: readonly (keyof MsbuildProjectProperties)[]): MsbuildProjectProperties;
  public parseMsbuildProperties(output: string, propertyNames: readonly string[]): Record<string, string | undefined>;
  public parseMsbuildProperties(output: string, propertyNames: readonly string[]): Record<string, string | undefined> {
    const fromJson = this.tryParseMsbuildGetPropertyJson(output, propertyNames);
    if (fromJson) {
      return fromJson;
    }

    const result: Record<string, string | undefined> = {};
    for (const name of propertyNames) {
      const value = this.parseMsbuildGetPropertyOutput(String(name), output);
      if (value !== undefined) {
        result[String(name)] = value;
      }
    }
    return result;
  }

  private tryParseMsbuildGetPropertyJson(
    output: string,
    propertyNames: readonly string[],
  ): Record<string, string | undefined> | undefined {
    const trimmed = output.trim();

    const tryParseObject = (text: string): Record<string, string | undefined> | undefined => {
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        return undefined;
      }

      if (!json || typeof json !== 'object') {
        return undefined;
      }

      const properties = (json as { Properties?: unknown }).Properties;
      if (!properties || typeof properties !== 'object') {
        return undefined;
      }

      const record = properties as Record<string, unknown>;
      const result: Record<string, string | undefined> = {};
      for (const name of propertyNames) {
        const raw = record[name];
        if (typeof raw === 'string') {
          const v = raw.trim();
          if (v.length > 0) {
            result[name] = v;
          }
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    };

    // Newer dotnet/msbuild can return a clean JSON object.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = tryParseObject(trimmed);
      if (parsed) {
        return parsed;
      }
    }

    // Some hosts may prepend/append non-JSON text; attempt to parse the outermost JSON block.
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      return tryParseObject(candidate);
    }

    return undefined;
  }
}
