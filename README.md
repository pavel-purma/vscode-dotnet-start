# dotnet-start

VS Code extension that helps you:

- Choose a `.csproj` in your workspace as the **start project**.
- Choose a `launchSettings.json` **launch profile** (Visual Studio-style profiles).
- Press `F5` and pick **dotnet-start** to start debugging the selected project/profile.

This extension delegates debugging to the installed .NET debugger (`coreclr`).

## Try it

1. Build the extension: `npm run compile`
2. Press `F5` (Run Extension) to open an Extension Development Host window.
3. In the Extension Host window:
   - Run command: **dotnet-start: Select Start Project (.csproj)**
   - Run command: **dotnet-start: Select Launch Profile (launchSettings.json)**
   - Press `F5` and pick **dotnet-start**

Notes:

- Launch profiles are read from `Properties/launchSettings.json` next to the selected `.csproj`.
- Debugging uses `dotnet run --project <csproj> --launch-profile <profile>` under the hood.
