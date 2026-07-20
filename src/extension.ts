import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  Patcher,
  initFindKeys,
  initMathAssets,
  migrateLegacyKeys,
} from "./patcher";
import { StatusBar } from "./statusBar";
import { PatchPanel } from "./panel";

// The user keybindings.json, derived from globalStorageUri
// (<userData>/User/globalStorage/<ext-id> -> two levels up is the User dir).
// This resolves on VS Code and its forks alike, portable mode included, with
// no per-product path table. The find-bar toggle bakes the chords resolved
// from this file into the patched bundle.
function userKeybindingsPath(context: vscode.ExtensionContext): string {
  return path.join(
    path.dirname(path.dirname(context.globalStorageUri.fsPath)),
    "keybindings.json",
  );
}

// Re-apply (debounced) when the user edits keybindings.json, so the find bar's
// baked chords follow without waiting for the next activation. Watching the
// parent dir covers the file not existing yet; a watch failure just means the
// chords refresh on the next activation instead.
function watchKeybindings(kbPath: string, patcher: Patcher): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = fs.watch(path.dirname(kbPath), (_event, file) => {
      if (file !== path.basename(kbPath)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => patcher.reapply(), 500);
    });
    return {
      dispose: () => {
        if (timer) clearTimeout(timer);
        try {
          watcher.close();
        } catch {
          // already closed
        }
      },
    };
  } catch {
    return { dispose: () => undefined };
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Move any pre-rename chatDiff* settings to chatDiffCard* before the Patcher
  // reads them, so a rebuild after the rename keeps the user's values.
  await migrateLegacyKeys();
  // Load the vendored KaTeX payloads and the keybindings.json location before
  // the Patcher's constructor analyzes the bundle (the math toggle reports
  // missing without the former; the find-bar cfg line bakes chords from the
  // latter).
  initMathAssets(context.extensionUri.fsPath);
  const kbPath = userKeybindingsPath(context);
  initFindKeys(kbPath);
  const patcher = new Patcher(context);
  const statusBar = new StatusBar(patcher);

  context.subscriptions.push(
    statusBar,
    ...patcher.register(),
    watchKeybindings(kbPath, patcher),
    vscode.commands.registerCommand("claudeCodeUiPatch.panel", () =>
      PatchPanel.show(patcher),
    ),
  );
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}
