# Changelog

All notable changes to Claude Code UI Patch are documented here. This project follows [Semantic Versioning](https://semver.org).

## 1.3.4

- Add `claudeCodeUiPatch.chatHistoryParagraphSpacing`, a multiplier on the gap between agent-message paragraphs (default `1` = native).
  It scales the native `em` margins, so the spacing still tracks `chatHistoryFontSize`; `1.2` is 20% looser and `0` closes the gap.

## 1.3.3

- With the scroll-to-bottom or previous/next buttons on, the chat history is no longer dimmed to 40% while a permission or question box is up, so it stays readable while you navigate; the native dim returns when both are off.
- The next-message button now glides to the bottom when no later user message exists below, dimming only at the bottom.
  It used to dim anywhere inside the latest turn, exactly where reading history under a pending permission box leaves you.

## 1.3.2

- Fix the find bar's block ruler painting over the pinned user-message header while scrolling; the ruler now spans only the visible part of its block.
- The scroll-to-bottom and previous/next message buttons now also sit above the top-right corner of the permission or question box while it replaces the input box, where they used to disappear.
- With the scroll-to-bottom button on, an incoming permission request or question no longer scrolls the chat history to the bottom while you are reading it.
  The scroll still happens when the view is already at the bottom.
- Clicking the scroll-to-bottom button no longer moves focus (matching the jump buttons), so a permission box's keyboard shortcuts keep working after a click.

## 1.3.1

- Fix the scroll-to-bottom and previous/next message buttons painting over the input box's pop-up menus (the `@` file picker, the mode and model menus): the buttons now hide while any such menu is open.

## 1.3.0

- Add `claudeCodeUiPatch.chatFindBar`, off by default: `Cmd`/`Ctrl`+`F` in the chat (tab or sidebar) opens a find bar that highlights matches with a "k of n" counter and, unlike the native search box, actually moves between them.
  Next/previous follow your Find Next / Find Previous keybindings (single chords); `Escape` closes.
  Block-skip buttons jump between the blocks that hold matches, and a ruler beside the transcript marks the current block; nothing auto-expands.
  Block skip is also on `Cmd`/`Ctrl`+`Enter` (shifted for previous), and all four navigation buttons take extra comma-separated chords via `chatFindBar{Next,Previous}MatchKeys` / `chatFindBar{Next,Previous}MatchBlockKeys`.
- The scroll-to-bottom and jump buttons now show prompt hover tips: "Scroll to Bottom", "Previous Message", "Next Message".
- Rename the settings link in the panel and the status-bar tooltip from "Open VS Code Settings" to "Open Settings", which stays accurate on forks.
- Tighten every settings description in `package.json` to one concise shape: what the setting controls, one behavior note, and the `0`/`Empty`/`Off = native` closing shorthand.

## 1.2.1

- The patcher now locates Claude Code through the extensions API, so it works unchanged on VS Code forks (VSCodium, Cursor, code-server, ...), remote hosts, portable installs, and custom `--extensions-dir` locations, always targeting the copy the current window loads.
- Install folders pending deletion (leftovers of an uninstall, update, or downgrade) are never selected as the patch target.

## 1.2.0

- Add `claudeCodeUiPatch.chatMathRendering`: render TeX math in agent chat messages with a bundled KaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`), off by default.
  Code blocks and inline code are left untouched, and currency like `$5 and $10` stays literal; `$$…$$` alone on its line(s) renders as display math, inline otherwise.
  Invalid TeX shows KaTeX's red error span with the raw source instead of breaking the message.
- Add `claudeCodeUiPatch.chatMathFontSizeEm`: math size in `em`, relative to the surrounding chat text, defaulting to `1.0` (match the text); KaTeX's own document-oriented default is `1.21`.
- Add `claudeCodeUiPatch.chatInputHistoryFontSize`: text size in px for your sent messages in the chat history, `0` (follow the native `chat.fontSize`) by default.
  It shows in the panel and the status-bar summary as "user message history"; attachment chips and slash-command echoes keep the native size.
- Add `claudeCodeUiPatch.chatInputHistoryFontFamily`: font family for the text of your sent messages in the chat history, empty (native) by default.
  Attachment chips, the "Show more"/"Show less" buttons, slash-command echoes, the input box, and the agent transcript keep their native fonts.
- Fix `claudeCodeUiPatch.chatDiffCardLineNumbers` re-applying needlessly at every activation whenever the scroll-to-bottom button or the jump buttons were also on.

## 1.1.13

- `claudeCodeUiPatch.chatDiffCardLineNumbers` now numbers diff-card lines by their true position in the edited file whenever the edit's location is known, instead of always restarting at 1.
  Cards replayed from history, failed edits, and `replace_all` edits keep the 1-based fallback; the expand modal shows the same numbers.
- The line-number gutter is now as narrow as the shown digits require, replacing the fixed two-digit minimum.
- Remove the diff card's dead left strip in the side-by-side view.
- Add ~5px of breathing room where the two panes' line numbers meet in the inline (narrow) view.

## 1.1.12

- Add `claudeCodeUiPatch.chatJumpToMessageButtons`: two always-visible buttons above the chat input box's top-right corner, a chevron-up "previous" and a chevron-down "next" that step through the conversation a turn at a time, lining up left of the scroll-to-bottom button when both are enabled.
  A direction with nowhere to go dims.
- The scroll-to-bottom button no longer hides at the bottom: it stays visible and dims when there is nothing to scroll to.

## 1.1.10

- Scroll-to-bottom uses a fixed 100ms scrolling instead of smooth scrolling, regardless of how long the history (instant under reduced motion)
- Align the scroll-to-bottom button with the send button, with more pronounced highlight

## 1.1.9

- Add `claudeCodeUiPatch.chatScrollToBottomDot`: a small button above the chat input box's top-right corner that shows whenever the conversation is scrolled away from the bottom; clicking glides back to the latest message (instant under reduced motion).

## 1.1.7

- The panel now surfaces partial patch loss: a setting changed from its native value whose patch target is gone on the installed Claude Code version renders as a lost knob with a red dot, instead of the panel reading "All settings applied".
  Lost knobs keep live controls, so the preference re-applies if a later Claude Code build restores support.
- Reword the post-update reload notification.

## 1.1.6

- Add reload notification after `claude-code` update
- Add `claudeCodeUiPatch.planPreviewCommentInputCtrlEnterToSend`: in the Plan Mode preview's comment box, send on `Cmd`/`Ctrl`+`Enter` and let plain `Enter` insert a newline. Off = native (`Enter` sends, `Shift`+`Enter` newlines).
- Fix `claudeCodeUiPatch.planPreviewFontFamily`: the floating **Add Comment** button no longer picks up the reading font; the rest of the preview keeps it.

## 1.1.5

- Add `claudeCodeUiPatch.chatInputMaxLines`: how many lines the chat input box grows to before it scrolls (clamped to 70% of the window height), keeping the box's bottom padding in view while typing at the end.
  `0` = native (a fixed 200px cap).

## 1.1.4

- Add `claudeCodeUiPatch.codeFontFamily`: one font family for code only, covering chat fenced and inline code, the Plan Mode preview, and the permission command block; prose, chrome, and diff cards stay native.
  Composes with `chatHistoryFontFamily`, so a reading font and a code font can be set together.
- Normalize the code-block setting keys to `CodeBlock` casing (`chatCodeBlockFontSize`, `planPreviewCodeBlockFontSize`, `chatPermissionCodeMatchChatCodeBlock`); existing values migrate automatically.

## 1.1.3

- Add `claudeCodeUiPatch.chatPermissionCodeNoWrap`: stop the permission command block from wrapping; each visual row is one logical line and a long command scrolls sideways.

## 1.1.2

- Retire the `Claude Code UI Patch: Restore Font Sizes` command. Use the panel's **Factory Reset** button instead, which reverts every setting (not just font sizes) to Claude Code's native values.
- Panel polish: the "Reload Window" link is always a badge now (green when everything is applied, yellow when a reload is pending), so it no longer changes size between states. "Restore Last Applied" recedes to a quiet outline when there is nothing to revert, and turns solid green only while a reload is pending.
- Panel header: the target version reads as a light "Patching: " followed by a clay-colored "Claude Code v…" rather than a filled badge, and the status line is now a full-width banner (green when applied, yellow when a reload is due or the version is unsupported) rather than tinted text.

## 1.1.1

- Fix `claudeCodeUiPatch.chatShowMoreAndLessAlign`: pinning the "Show more" button no longer enlarges the message box vertically when it appears on hover.

## 1.1.0

- Add `claudeCodeUiPatch.chatHistoryFontSize`: a font size for the agent responses only, private to Claude Code. The input box, interface, your own messages, and other chat extensions stay on the shared native `chat.fontSize`. `0` follows `chat.fontSize`. Replaces the panel's native `chat.fontSize` knob.
- Add `claudeCodeUiPatch.chatHistoryFontFamily`: a font family for the agent responses only. The interface and input box stay in the native UI font, which also keeps the input caret aligned.
- Add `claudeCodeUiPatch.chatCodeInlineFontSize`: size chat inline code separately from fenced blocks. `0` follows `chatCodeBlockFontSize`.
- Add `claudeCodeUiPatch.chatPermissionCodeMatchChatCodeBlock`: match the permission command block to the tool input block size (`0.85em` instead of `0.9em`).
- Add `claudeCodeUiPatch.chatShowMoreAndLessAlign`: pin the chat "Show more" and "Show less" buttons to `left` or `right`. Empty follows the native (drifting) position.
- Add `claudeCodeUiPatch.planPreviewFontFamily`: a font family for the Plan Mode preview panel.
- Add `claudeCodeUiPatch.planPreviewCodeInlineFontSize`: size plan-preview inline code separately from fenced blocks. `0` follows `planPreviewCodeBlockFontSize`.
- Add `claudeCodeUiPatch.planPreviewCommentInputRows`: the select-and-comment box height in rows. `0` follows the native height (about 3).
- Unify the setting descriptions into a concise, consistent style.
- Highlight the panel's Reload Window link while a reload is pending.

## 1.0.3

- Improve README

## 1.0.2

- Include `claudeCodeUiPatch.effortSyncFix`

## 1.0.1

- Include example UI Patch configuration panel figures

## 1.0.0

Initial release. Adds settings that reach font sizes and a few behaviors Claude Code otherwise pins, by editing the installed extension's bundled files in place and reverting cleanly on demand.

### Highlights

- **Chat panel/tab:** code-block font size, plus the Edit-diff card's font size, its line-number gutter, and light/dark theme sync (the latter two as on/off toggles). The native `chat.fontSize` is surfaced alongside them.
- **Plan-mode Markdown preview:** font sizes for the rendered text, code, selected-text quote, comment input, and comment badge.
- **Status bar + panel:** hover the status bar for current values; open the panel for `▼`/`▲` sizing, On/Off toggles, per-knob sync dots, and Discard / Restore.
- **Resilient:** native values are captured per Claude Code version, and settings are re-applied after a Claude Code update reverts the patch.

### Commands

- `Claude Code UI Patch: Open Panel`
- `Claude Code UI Patch: Restore Font Sizes`
