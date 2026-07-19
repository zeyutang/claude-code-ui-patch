# Claude Code UI Patch

Patch Claude Code VS Code extension UI to provide finegrained settings for various UI details (font sizes, code blocks, diff cards, and more).

## Every Knob, One Panel

|              Configuration Panel               |                       Status Bar Summary                        |
| :--------------------------------------------: | :-------------------------------------------------------------: |
| ![Configuration panel](assets/img/webview.png) |          ![Status bar summary](assets/img/tooltip.png)          |
|    Adjust the knobs, then **Reload Window**    | Hover the `aA` to show the summary, and click to open the panel |

|                 Previous and Next Turn, Scroll to Bottom                  |
| :-----------------------------------------------------------------------: |
|            ![Chat navigation button](assets/img/composer.png)             |
| Jump to the previous / next message, or to the bottom of the chat history |

1. Open the configuration panel  
   Press `Cmd+Shift+P` / `Ctrl+Shift+P` (or `F1`) to open the Command Palette, then run **Claude Code UI Patch: Open Panel**. Or alternatively, click the `aA` item at the far right of the status bar.
2. Modify the settings.  
   The yellow light in front of the item and the yellow highlight of the status bar icon will indicate that a **Reload Window** is needed in order for the configurations to fully apply.
3. **Reload Window**  
   Click it at the bottom of the panel for the changes to take effect. Or alternatively, open the Command Palette, then run **Developer: Reload Window**.
4. Repeat until satisfied.

## What This Extension Patches

Settings live under the `claudeCodeUiPatch.*` namespace (prefix omitted below) and each defaults to Claude Code's native value. The tree shows every knob, what it targets, and what scales with what: an indented child follows its parent until you give it a value.

```text
chat.fontSize & chat.fontFamily        # native VS Code settings, shared by every chat extension
   │                                   # therefore, this patch does NOT override them
   ├── input box
   ├── interface chrome (buttons, headers, token counts)
   ├── user messages + attachment chips (text font: see chatInputHistoryFontFamily)
   └── other chat extensions (Codex, Copilot, ...)

Chat Panel and Tab                     # chat history only, private to Claude Code
   ├── chatHistoryFontSize             # agent message text, 0 -> follows chat.fontSize
   ├── chatHistoryFontFamily           # agent message font, empty -> native UI font
   ├── chatInputHistoryFontFamily      # sent user message text, empty -> native chat font
   ├── chatCodeBlockFontSize           # fenced code blocks
   │      └── chatCodeInlineFontSize   # inline code, 0 -> follows chatCodeBlockFontSize
   ├── chatMathRendering               # TeX math via bundled KaTeX if On
   │      └── chatMathFontSizeEm       # math size in em of chat text, 1.0 = match (KaTeX stock 1.21)
   └── diff cards                      # Edit / MultiEdit tool cards + expand modal
          ├── chatDiffCardFontSize     # diff code size
          ├── chatDiffCardLineNumbers  # true file line numbers (when known) if On
          └── chatDiffCardThemeSync    # follow VS Code light/dark theme if On

Plan Mode Markdown Preview
   ├── planPreviewFontSize             # preview text (headings scale with it)
   ├── planPreviewFontFamily           # preview font, empty -> native
   ├── planPreviewCodeBlockFontSize    # fenced code blocks
   │      └── planPreviewCodeInlineFontSize      # 0 -> follows planPreviewCodeBlockFontSize
   └── select-and-comment UI
          ├── planPreviewCommentInputFontSize    # comment box text
          ├── planPreviewCommentInputRows        # comment box height in rows, 0 -> native
          ├── planPreviewCommentQuoteFontSize    # selected-text quote
          └── planPreviewCommentBadgeFontSize    # comment badge (14px circle, keep <= 12)

Behavior
   ├── chatInputMaxLines               # input box: grow to N lines + keep bottom gap, 0 -> native
   ├── chatJumpToMessageButtons        # always-shown prev/next buttons: jump between turns, if On
   ├── chatScrollToBottomDot           # button above input box: click scrolls chat to newest, if On
   ├── chatShowMoreAndLessAlign        # "left" / "right", empty "" -> native
   ├── chatPermissionCodeMatchChatCodeBlock      # chatCodeBlockFontSize (On) or chat.fontSize (Off)
   ├── chatPermissionCodeNoWrap        # permission cmd: no-wrap + h-scroll (On) or wrap (Off)
   ├── effortSyncFix                   # push persisted effort level to a reloaded session if On
   └── planPreviewCommentInputCtrlEnterToSend  # Cmd/Ctrl+Enter sends, plain Enter newlines if On

Unified codeFontFamily                 # code font only; IN/OUT block, chrome, diff cards stay native
   ├── chat panel and tab  (fenced code + inline code)
   ├── plan mode preview   (fenced code + inline code)
   └── permission prompt   (command block)
```

## Using This UI Patch

- **Panel controls:** sizes use `▼`/`▲`, toggles an On/Off switch, and each row's sync dot shows green (in effect), yellow (reload needed), or red (unavailable on this Claude Code version, with the header banner turning Claude clay).
- **Direct edits:** Font families, the math size (`chatMathFontSizeEm`), the input-box line cap, comment-box rows, and the "Show more/less" button alignment have no panel control, set them in VS Code Settings via direct edits. `claudeCodeUiPatch.*` settings apply upon a window reload. Example:

  ```json
  {
    // These settings affect ALL native chats, including Claude Code, Codex, Copilot, etc.
    // Therefore, UI Patch does not touch them
    // "chat.fontFamily": "default",
    // "chat.fontSize": 15,

    // UI Patch font size settings in a unified namespace `claudeCodeUiPatch`
    "claudeCodeUiPatch.chatCodeBlockFontSize": 14,
    "claudeCodeUiPatch.chatCodeInlineFontSize": 14,
    "claudeCodeUiPatch.chatDiffCardFontSize": 13.5,
    "claudeCodeUiPatch.chatHistoryFontSize": 15.75,
    "claudeCodeUiPatch.chatInputMaxLines": 20,
    "claudeCodeUiPatch.planPreviewFontSize": 15.75,
    "claudeCodeUiPatch.planPreviewCodeBlockFontSize": 14,
    "claudeCodeUiPatch.planPreviewCodeInlineFontSize": 14,
    "claudeCodeUiPatch.planPreviewCommentBadgeFontSize": 12,
    "claudeCodeUiPatch.planPreviewCommentInputFontSize": 15,
    "claudeCodeUiPatch.planPreviewCommentInputRows": 7,
    "claudeCodeUiPatch.planPreviewCommentQuoteFontSize": 12.5
  }
  ```

- **Commands:** `Claude Code UI Patch: Open Panel`.

## Caveats

- **The patch reverts when Claude Code updates.** The settings re-apply on the next window reload, and a notification then prompts you to **Reload Window** once more to see them. VS Code may show a one-time "corrupt installation" warning, which is safe to dismiss.
- **`chatDiffCardLineNumbers` shows true file positions only for edits made in the live session.**
  Each diff card is numbered against the file as it stood before and after that particular edit (both panes share the edit's true starting line), so numbers stay honest even when several edits to one file shift lines between calls.
  The position metadata rides only on live Edit results: Claude Code re-emits conversation history without it, so cards replayed after a window reload or session resume fall back to numbering from 1, as do failed edits and `replace_all` edits (several sites, no single true start).
- **`chatHistoryFontSize` / `chatHistoryFontFamily` restyle the agent transcript only** (deliberate design, not a bug).
  The input box, the interface, and other extensions' chats (Codex, Copilot, etc.) stay native, and can be configured with `chat.fontSize` and `chat.fontFamily`.
  To restyle the text of your own sent messages in the history, set `chatInputHistoryFontFamily`: it scopes to the user-message text wrapper alone, so attachment chips, the "Show more"/"Show less" buttons, slash-command echoes (deliberately monospace), and the live input box keep the native font.
- **`chatMathRendering` bundles KaTeX into the chat webview** (code under MIT, fonts under the SIL Open Font License 1.1; the exact version and both license texts ship in `assets/katex/`): the script and stylesheet are appended to the chat bundle and the `woff2` math fonts are copied next to it, all removed again when the toggle turns off or on Factory Reset.
  Math is detected in the raw markdown before the parser runs, so `_`, `*`, and `|` inside math never turn into emphasis or break tables; delimiters are `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, with Pandoc's `$` heuristics keeping currency like `$5 and $10` literal.
  Fenced code blocks and inline code are protected (4-space-indented code blocks are not, though Claude virtually always fences); a span containing a blank line never matches; invalid TeX renders KaTeX's red error span showing the raw source.
  Agent messages and thinking blocks render math, user messages stay native, and selecting rendered math copies KaTeX's internal reading of it rather than the original TeX source.
  The Plan Mode preview is a separate webview whose stricter content-security policy allows no font loading, so math rendering covers the chat only.
