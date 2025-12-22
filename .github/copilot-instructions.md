# Copilot instructions for `vscode-dotnet-start`

## Goal

This repository is a VS Code extension that:

- Lets the user pick a `.csproj` as the “start project”.
- Lets the user pick a `launchSettings.json` profile.
- On `F5`, shows a VS Code Quick Pick entry `dotnet-start` that starts debugging the chosen project/profile.

The extension must not implement its own debug adapter. It must start debugging by calling `vscode.debug.startDebugging(...)` with a `coreclr` debug configuration.

## UX rules (strict)

- Use native VS Code UI only (`showQuickPick`, `showErrorMessage`).
- Keep the number of picks minimal:
  - Select project (`.csproj`)
  - Select profile (from `Properties/launchSettings.json`)
  - Start (`F5` picker with `dotnet-start`)
- Do not add extra screens, settings, icons, or “nice-to-have” flows.

## Implementation conventions

- Prefer `context.workspaceState` for saved choices (per-workspace)
- When searching for `.csproj`, exclude common folders: `bin`, `obj`, `.git`, `.vs`, `node_modules`
- Read launch profiles from `Properties/launchSettings.json` (and optionally `launchSettings.json` as fallback)
- Keep TypeScript `strict` compatibility
- Do not add new runtime dependencies unless required

## Debug configuration (required)

When starting debugging, generate a `coreclr` launch config that runs:

- `program: "dotnet"`
- `args: ["run", "--project", <csproj>, "--launch-profile", <profile>]`
- `cwd: <csproj directory>`
- `console: "integratedTerminal"`

## Code style

- Structure code into classes and modules for clarity.
- Use async/await for asynchronous operations.
- Follow VS Code extension best practices.
- Document functions and classes with JSDoc comments.
- Use meaningful variable and function names.
- Follow consistent indentation and formatting (use Prettier if configured).
- Keep code changes minimal and targeted.
- Avoid adding inline comments unless clarifying a non-obvious VS Code API behavior.
- Prefer small helper functions over large monolithic command handlers.

## Validation

- Ensure `pnpm run compile` passes.
- Keep lint clean (`pnpm run lint`).
