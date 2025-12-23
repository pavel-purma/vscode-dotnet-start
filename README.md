# dotnet-start

## What it does

This extension provides a small set of commands to save (per workspace) which `.csproj` and launch profile you want to run, and then starts debugging by generating a `coreclr` configuration.

It’s especially useful in solutions with many projects where you frequently switch which project/profile you’re debugging.

Use this extension when you want a **“start project” + “launch profile”** workflow for .NET in VS Code (similar to what the .NET Dev Kit experience enables), **without requiring Dev Kit**.

It lets you quickly:

- Pick which `.csproj` is the **start project** in the current workspace
- Pick which `launchSettings.json` **profile** should be used

Then you can press `Alt+F5` to start debugging the selected project using the selected profile.

If you prefer the standard VS Code flow, you can also press `F5` and choose **dotnet-start** from VS Code’s native debug picker. Note: when you don’t already have a workspace `launch.json`, VS Code may first prompt you to select/create a debug configuration (e.g., a .NET/C# “build type”) before you can pick **dotnet-start**.

## Usage

In your workspace:

- Choose a `.csproj` in your workspace as the **start project**.
- Choose a `launchSettings.json` **launch profile** (Visual Studio-style profiles).
- Press `Alt+F5` to start debugging the selected project/profile.

Optional: you can also press `F5` and select **dotnet-start** from VS Code’s debug configuration picker (subject to VS Code’s normal “select/create a debug configuration” prompts when no `launch.json` exists).

Optional: you can also add a `dotnet-start` entry to your workspace’s `launch.json` (via the command **dotnet-start: Add dotnet-start to launch.json**). After that, selecting **dotnet-start** as your active debug configuration makes `F5` behave like your regular “start debugging” trigger—except it will start the `.csproj` and launch profile you selected with this extension.

```launch.json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "coreclr",
            "request": "launch",
            "name": "dotnet-start",
            "program": "dotnet"
        }
    ]
}

```

Notes:

- Launch profiles are read from `Properties/launchSettings.json` next to the selected `.csproj`.
- Debugging launches the built output (`dotnet <path-to-binary>`) and applies `launchSettings.json` env/args from the selected profile. This avoids common breakpoint issues with `dotnet run`.
- VS Code’s `F5` behavior depends on which debug configuration is currently selected. After you pick **dotnet-start** once, it should remain selected in that window; if VS Code asks you to pick a configuration again, just pick **dotnet-start**.
- The extension delegates to your installed .NET debugger (`coreclr`) via `vscode.debug.startDebugging(...)`.

## FAQ

### Can it show up as its own top-level debug category (like “C#”)?

> VS Code's top-level debug "categories" in the picker are driven by installed debugger types (debug adapters) contributed by extensions. This extension does not ship a debugger; it starts debugging by generating a `coreclr` configuration and calling `vscode.debug.startDebugging(...)`.
>
> As a result, `dotnet-start` appears under the existing .NET / `coreclr` grouping provided by your installed .NET tooling.

## Links

GitHub source: <https://github.com/pavel-purma/vscode-dotnet-start>
