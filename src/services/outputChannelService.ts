import * as vscode from 'vscode';

/**
 * Provides a single shared OutputChannel for the whole extension.
 */
export class OutputChannelService {
  private static _channel: vscode.OutputChannel | undefined;

  public static initialize(context: vscode.ExtensionContext, name = 'dotnet-start'): vscode.OutputChannel {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel(name);
      context.subscriptions.push(this._channel);
    }

    return this._channel;
  }

  public static get channel(): vscode.OutputChannel {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel('dotnet-start');
    }
    return this._channel;
  }

  public static appendLine(text: string): void {
    this.channel.appendLine(text);
  }

  public static append(text: string): void {
    this.channel.append(text);
  }
}
