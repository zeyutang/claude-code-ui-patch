# Changelog

All notable changes to Claude Code UI Patch are documented here. This project follows [Semantic Versioning](https://semver.org).

## Supported versions

| Claude Code | UI Patch |
| ----------- | -------- |
| 2.1.201+    | 1.1.x    |

## 1.1.11

- Add `claudeCodeUiPatch.chatJumpToMessageButtons`: two always-visible buttons above the chat input box's top-right corner, a chevron-up "previous" and a chevron-down "next" that step through the conversation a turn at a time, lining up left of the scroll-to-bottom button when both are enabled.
  A direction with nowhere to go dims.
- The scroll-to-bottom button no longer hides at the bottom: it stays visible and dims when there is nothing to scroll to.

## 1.1.10

- Scroll-to-bottom uses a fixed 100ms scrolling instead of smooth scrolling, regardless of how long the history (instant under reduced motion)
- Align the scroll-to-bottom button with the send button, with more pronounced highlight

## 1.1.9

- Add `claudeCodeUiPatch.chatScrollToBottomDot`: a small button just above the chat input box's top-right corner (outside its contour) that shows whenever the conversation is scrolled away from the very bottom; hovering names it ("Go to the bottom of the conversation") and clicking glides back to the latest message in a fixed 100ms, however long the history (instant under reduced motion).
  The button mirrors the send button's rounded-square shape with a downward arrow, in the input's own neutral surface and text color, and hides again once the view reaches the bottom.

## 1.1.7

- Surface partial patch loss in the panel: a setting changed from its native value whose patch target is gone on the installed Claude Code version now renders as a lost knob with a red dot, under a Claude clay status banner, instead of the panel reading "All settings applied".
  Lost knobs keep live controls, so the preference is retained and re-applies if a later Claude Code build restores the anchor; a missing point still at its native value stays hidden.
- Reword the post-update reload notification.

## 1.1.6

- Add reload notification after `claude-code` update
- Add `claudeCodeUiPatch.planPreviewCommentInputCtrlEnterToSend`: in the Plan Mode preview's comment box, send on `Cmd`/`Ctrl`+`Enter` and let plain `Enter` insert a newline (`Shift`+`Enter` also inserts a newline; the **Add Comment** button and `Escape` are unchanged). Off keeps the native behavior, where `Enter` sends and `Shift`+`Enter` inserts a newline.
- Fix `claudeCodeUiPatch.planPreviewFontFamily`: the floating **Add Comment** button that appears when you select text in the Plan Mode preview no longer picks up the reading font. It is a native VS Code button but inherited the preview's `<body>` font, so a proportional reading font rendered it in that face; it is now pinned back to the UI font. The rest of the preview (prose, the review banner, and the comment popup's own controls) keeps the reading font as before.

## 1.1.5

- Add `claudeCodeUiPatch.chatInputMaxLines`: how many lines the chat input box grows to before it scrolls, folding two fixes into one number. Natively the box stops growing at a fixed 200px (so the line count depends on `chat.fontSize`), and once it scrolls, typing at the end reveals only the caret's line, leaving the last line flush on the box edge with its bottom padding hidden. Setting `N` caps the box at exactly `N` lines at any chat font size (clamped to 70% of the window height so a large `N` cannot swallow a short window) and adds `scroll-padding`, so the caret always keeps the box's own padding visible below the last line. `0` keeps both native behaviors.

## 1.1.4

- Add `claudeCodeUiPatch.codeFontFamily`: one font family for code **only**, applied to every code surface at once: fenced blocks and inline code in the chat panel and the Plan Mode preview, plus the permission command block. Prose text, interface chrome, and diff cards stay native. Empty follows the native monospace font. This is scoped to win over the code re-styling that `chatHistoryFontFamily` applies, so a chat reading font and a dedicated code font can be set together.
- Normalize the code-block setting keys to `CodeBlock` casing
  (`chatCodeBlockFontSize`, `planPreviewCodeBlockFontSize`,
  `chatPermissionCodeMatchChatCodeBlock`); existing values migrate automatically.

## 1.1.3

- Add `claudeCodeUiPatch.chatPermissionCodeNoWrap`: stop the permission command block from wrapping. It switches the block to `white-space: pre` with horizontal scroll, so every visual row is exactly one logical line and a long command scrolls sideways instead of wrapping ambiguously onto the next row. Line numbers and syntax highlighting aren't offered for this block, because the command renders as a single editable text node with no per-line structure to anchor them to.

## 1.1.2

- Retire the `Claude Code UI Patch: Restore Font Sizes` command. Use the panel's **Factory Reset** button instead, which reverts every setting (not just font sizes) to Claude Code's native values.
- Panel polish: the "Reload Window" link is always a badge now (green when everything is applied, yellow when a reload is pending), so it no longer changes size between states. "Restore Last Applied" recedes to a quiet outline when there is nothing to revert, and turns solid green only while a reload is pending.
- Panel header: the target version reads as a light "Patching: " followed by a clay-colored "Claude Code v…" rather than a filled badge, and the status line is now a full-width banner (green when applied, yellow when a reload is due or the version is unsupported) rather than tinted text.

## 1.1.1

- Fix `claudeCodeUiPatch.chatShowMoreAndLessAlign`: pinning the "Show more" button no longer enlarges the message box vertically when it appears on hover. It keeps its native absolute positioning (only the horizontal anchor is forced) instead of being dropped into normal flow, which had added the button's height to the box.

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
