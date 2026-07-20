import * as vscode from "vscode";
import { Patcher, tooltipLines } from "./patcher";

// A status-bar item at the far right. Hover shows a read-only font-size summary
// with a settings link; click opens the webview panel for interactive controls.
// The warning (amber) background signals that settings don't match the on-disk
// bundle state — e.g. after a Claude Code update reverted the patch.
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(private readonly patcher: Patcher) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      -1000000,
    );
    this.item.name = "Claude Code UI Patch";
    this.item.command = "claudeCodeUiPatch.panel";
    this.render();
    this.item.show();
    this.sub = patcher.onDidChange(() => this.render());
  }

  private render(): void {
    const snap = this.patcher.snapshot();
    this.item.text = "$(text-size)";

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    const lines = tooltipLines(snap);
    md.appendMarkdown(
      lines.length
        ? lines.join("\n")
        : "**Claude Code UI Patch**\n\nClaude Code not detected.",
    );
    this.item.tooltip = md;

    // Flag an unapplied / stale / pending-reload patch with the warning background.
    this.item.backgroundColor =
      snap && snap.needsReload
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
