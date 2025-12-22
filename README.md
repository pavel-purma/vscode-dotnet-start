# dotnet-start

GitHub source: <https://github.com/pavel-purma/vscode-dotnet-start>

Use this extension when you want a **“start project” + “launch profile”** workflow for .NET in VS Code (similar to what the .NET Dev Kit experience enables), **without requiring Dev Kit**.

It lets you quickly:

- Pick which `.csproj` is the **start project** in the current workspace
- Pick which `launchSettings.json` **profile** should be used

Then you can press `F5` and choose **dotnet-start** from VS Code’s native debug picker to start the selected project using the selected profile.

## What it does

This extension provides a small set of commands to save (per workspace) which `.csproj` and launch profile you want to run, and then starts debugging by generating a `coreclr` configuration.

It’s especially useful in solutions with many projects where you frequently switch which project/profile you’re debugging.

## How it works (at a glance)

- Launch profiles come from `Properties/launchSettings.json` next to the selected `.csproj`.
- Debugging uses `dotnet run --project <csproj> --launch-profile <profile>`.
- The extension delegates to your installed .NET debugger (`coreclr`) via `vscode.debug.startDebugging(...)`.

## Usage

In your workspace:

- Choose a `.csproj` in your workspace as the **start project**.
- Choose a `launchSettings.json` **launch profile** (Visual Studio-style profiles).
- Press `F5` and choose **dotnet-start** in VS Code's native debug configuration picker to start debugging the selected project/profile.

You don’t need to have a specific file open. The **dotnet-start** entry will appear in the `F5` picker, and (on first use) it will prompt you to select a start project and launch profile.

Optional: you can also add a `dotnet-start` entry to your workspace’s `launch.json` (via the command **dotnet-start: Add dotnet-start to launch.json**). After that, selecting **dotnet-start** as your active debug configuration makes `F5` behave like your regular “start debugging” trigger—except it will start the `.csproj` and launch profile you selected with this extension.

## Try it

1. Build the extension: `npm run compile`
2. Press `F5` (Run Extension) to open an Extension Development Host window.
3. In the Extension Host window:
   - Run: **dotnet-start: Select Start Project (.csproj)**
   - Run: **dotnet-start: Select Launch Profile (launchSettings.json)**
   - Press `F5` and pick **dotnet-start** in the debug configuration picker

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
