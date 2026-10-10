# Agent instructions for vscode-dotnet-start

This is the shared, repository-wide guide for coding agents. Read it before making changes. For user-facing behavior and prerequisites, see [README.md](./README.md); for commands and extension contributions, see [package.json](./package.json).

## Project structure

This project is a TypeScript VS Code extension that selects a .NET start project and launch profile, then delegates debugging to an installed `coreclr` debugger. It does not implement a debug adapter.

- [src/extension.ts](./src/extension.ts): activation, commands, Dynamic and Initial debug configuration providers, debug startup, and optional launch configuration insertion.
- [src/services/dotnetStartManager.ts](./src/services/dotnetStartManager.ts): project/profile/action Quick Picks and per-workspace selection state.
- [src/services/csprojInstance.ts](./src/services/csprojInstance.ts): launch settings, profile validation, Debug builds, DLL discovery, and debug configuration generation.
- [src/services/msbuildProjectPropertiesService.ts](./src/services/msbuildProjectPropertiesService.ts): MSBuild property queries and target-path calculation.
- [src/services/outputChannelService.ts](./src/services/outputChannelService.ts): shared `dotnet-start` output channel.
- [src/test/](./src/test/): Mocha tests running in the VS Code extension host, with workspace fixtures and API stubs.

## Behavior to preserve

- Start debugging through `vscode.debug.startDebugging(...)` using a `coreclr` launch configuration. Build the selected project in Debug, then run `program: builtDllPath` with `args: profileArgs`, the project directory as `cwd`, and `console: "integratedTerminal"`. Do not replace this with the old `dotnet run --launch-profile` flow.
- Preserve the Dynamic/Initial debug-provider integration, existing commands and keybinding, action picker, and optional launch configuration generation. Keep command registrations aligned with contributions in [package.json](./package.json).
- Use native VS Code UI and the existing output channel. Do not introduce webviews or additional UX flows unless requested.
- Store selected project/profile choices in `context.workspaceState`. Changing the selected project clears its saved profile; one-off profile runs must not overwrite the saved profile.
- Treat Quick Pick cancellation as cancellation, and retain automatic selection when only one launch profile exists.
- Discover `*.csproj` files while excluding `bin`, `obj`, `.git`, `.vs`, and `node_modules`.
- Read `Properties/launchSettings.json`, with project-root `launchSettings.json` as the fallback. A missing settings file is supported; malformed settings or an invalid selected profile must not silently become a successful default launch.
- Support only profiles with `commandName: "Project"`. Preserve profile arguments and string environment variables, including the `applicationUrl` to `ASPNETCORE_URLS` mapping when that variable is not already set.
- Reuse the existing build, MSBuild query, and DLL fallback logic. Preserve build output streaming, timeouts, and explicit error reporting.
- Use `vscode.Uri`, `workspace.fs`, and `RelativePattern` for workspace resources, and path helpers rather than hard-coded platform-specific separators. Invoke `dotnet` with argument arrays through the existing process helpers.

## TypeScript code style

The sources of truth are [tsconfig.json](./tsconfig.json), [eslint.config.mjs](./eslint.config.mjs), [.editorconfig](./.editorconfig), and the surrounding source. There is no configured Prettier workflow.

- Keep TypeScript `strict` compatibility with the existing ES2022 target and Node16 module settings.
- Use two-space indentation, single-quoted TypeScript strings, semicolons, and trailing commas in multiline structures.
- Follow existing imports: namespace imports for VS Code and Node modules, and named imports for project symbols. Import identifiers follow the existing camelCase/PascalCase lint rule.
- Use PascalCase for classes/interfaces/types and camelCase for functions, methods, and variables. Prefer meaningful names, explicit class member visibility, and explicit method return types.
- Keep responsibilities in small classes, modules, and helpers; reuse existing services rather than adding parallel implementations. Prefer `async`/`await` for asynchronous control flow.
- Treat parsed JSON and external values as `unknown`, then narrow them with runtime checks. Do not introduce `any`, suppression directives, or unchecked double assertions to bypass type errors.
- Use concise JSDoc for public APIs or non-obvious contracts. Avoid boilerplate comments on self-explanatory code.
- Surface user-facing failures through `showErrorMessage` and operational detail through `OutputChannelService`. Do not swallow errors or substitute success-shaped defaults for failures.

## Working and validation

Use pnpm and preserve [pnpm-lock.yaml](./pnpm-lock.yaml). Install dependencies only when needed; do not add runtime dependencies or a new formatter without a task requirement.

Available commands:

| Command | Purpose |
| --- | --- |
| `pnpm run check-types` | Type-check without emitting files |
| `pnpm run lint` | Lint TypeScript sources |
| `pnpm run compile` | Type-check, lint, and build the extension bundle |
| `pnpm test` | Compile tests and extension, then run VS Code-hosted Mocha tests |
| `pnpm run package` | Type-check, lint, and build the production bundle |
| `pnpm run vsix` | Build and package the extension as a VSIX |

- Keep changes focused, preserve unrelated work, and update directly affected documentation.
- For TypeScript changes, run `pnpm run compile`; it includes type-checking and linting. Run relevant tests when changing project discovery, selection state, profile handling, builds, or debug configurations.
- Tests use VS Code/Electron, not a standalone Node-only test runner. Follow the existing fixture/stub lifecycle and clean up test resources. `DOTNET_START_SKIP_DOTNET_BUILD` is an internal test hook, not a user setting.
- Documentation-only changes do not require application builds or integration tests. Validate customization frontmatter and local links when changing agent definitions.
- Edit source, not generated bundles in `dist` or compiled tests in `out`. Keep development-only agent guidance out of the VSIX using [.vscodeignore](./.vscodeignore).
- Report what changed, which checks actually ran, and any unresolved validation limitations.
