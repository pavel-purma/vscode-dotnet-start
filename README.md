# dotnet-start

VS Code extension that helps you:

- Choose a `.csproj` in your workspace as the **start project**.
- Choose a `launchSettings.json` **launch profile** (Visual Studio-style profiles).
- Press `F5` and choose **dotnet-start** in VS Code's native debug configuration picker to start debugging the selected project/profile.

This extension delegates debugging to the installed .NET debugger (`coreclr`).

You do not need to have a specific file open. The **dotnet-start** entry will appear in the `F5` debug picker, and when chosen it will prompt you to select a start project (`.csproj`) (and a launch profile if needed).

## Try it

1. Build the extension: `npm run compile`
2. Press `F5` (Run Extension) to open an Extension Development Host window.
3. In the Extension Host window:
   - Run command: **dotnet-start: Select Start Project (.csproj)**
   - Run command: **dotnet-start: Select Launch Profile (launchSettings.json)**
   - Press `F5` and pick **dotnet-start** in the native debug configuration picker

Notes:

- Launch profiles are read from `Properties/launchSettings.json` next to the selected `.csproj`.
- Debugging uses `dotnet run --project <csproj> --launch-profile <profile>` under the hood.

## FAQ

### Can it show up as its own top-level debug category (like “C#”)?

No. VS Code’s top-level debug “categories” in the picker are driven by installed debugger types (debug adapters) contributed by extensions. This extension does not ship a debugger; it starts debugging by generating a `coreclr` configuration and calling `vscode.debug.startDebugging(...)`.

As a result, `dotnet-start` appears under the existing .NET / `coreclr` grouping provided by your installed .NET tooling.

### Will it remember my selections and auto-start next time?

Yes. Your selected `.csproj` and launch profile are saved in per-workspace state.

- First run: you’ll be prompted to pick a `.csproj` and a launch profile.
- Later runs: starting **dotnet-start** uses the saved selections and starts immediately (no extra prompts).

Note: VS Code’s `F5` behavior depends on which debug configuration is currently selected. After you pick **dotnet-start** once, it should remain selected in that window; if VS Code asks you to pick a configuration again, just pick **dotnet-start**.
