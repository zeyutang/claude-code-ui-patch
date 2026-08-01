import * as vscode from "vscode";
import {
  Patcher,
  Snapshot,
  Knob,
  PreviewModel,
  SECTION_ORDER,
  HIDDEN_KNOBS,
} from "./patcher";

// A webview panel that serves as the detailed control surface (opened by
// clicking the status-bar item). The hover tooltip is a compact read-only
// summary; this panel adds per-knob ▼/▲ adjust, Restore Last Applied / Factory
// Reset, and per-knob sync-state dots. Communication uses postMessage.
//
// Snappiness: clicking an arrow updates the px display in the webview
// immediately (optimistically) and posts the absolute target value. The full
// HTML is rebuilt only when the panel's structure changes (version, which knobs
// exist); ordinary value/dot/status updates are pushed as lightweight "sync"
// messages that patch the DOM in place, so nothing reloads on each click.
export class PatchPanel {
  private static current: PatchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly sub: vscode.Disposable;
  private shape = ""; // signature of the last full render's structure

  private constructor(private readonly patcher: Patcher) {
    this.panel = vscode.window.createWebviewPanel(
      "claudeCodeUiPatch.panel",
      "Claude Code UI Patch",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: true,
      },
    );
    this.sub = vscode.Disposable.from(
      patcher.onDidChange(() => this.update()),
      this.panel.onDidDispose(() => {
        PatchPanel.current = undefined;
        this.sub.dispose();
      }),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
    );
    this.update();
  }

  static show(patcher: Patcher): void {
    if (PatchPanel.current) {
      PatchPanel.current.panel.reveal();
      return;
    }
    PatchPanel.current = new PatchPanel(patcher);
  }

  // Full re-render on a structural change; otherwise patch the DOM in place.
  private update(): void {
    const snap = this.patcher.snapshot();
    const shape = shapeOf(snap);
    if (shape !== this.shape) {
      this.shape = shape;
      this.panel.webview.html = this.html(snap);
    } else if (snap) {
      void this.panel.webview.postMessage({
        type: "sync",
        ...syncPayload(snap),
      });
    }
  }

  private async onMessage(msg: {
    command: string;
    target?: string;
    value?: number;
    on?: boolean;
    key?: string;
  }): Promise<void> {
    switch (msg.command) {
      case "set":
        if (msg.target !== undefined && msg.value !== undefined)
          await this.patcher.setSize(msg.target, msg.value);
        break;
      case "nativeSet":
        if (msg.target !== undefined && msg.value !== undefined)
          await this.patcher.setNative(msg.target, msg.value);
        break;
      case "toggleSet":
        if (msg.target !== undefined && msg.on !== undefined)
          await this.patcher.setToggle(msg.target, msg.on);
        break;
      case "discard":
        await this.patcher.discard();
        break;
      case "restore":
        await this.patcher.restore();
        break;
      case "reload":
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "openSettings":
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          msg.key ?? "claudeCodeUiPatch",
        );
        break;
    }
  }

  // --- HTML generation ---

  private knobHtml(k: Knob): string {
    const { cls: dotClass, title: dotTitle } = dotInfo(k);
    const dot = `<span class="dot-slot"><span class="dot ${dotClass}" title="${dotTitle}">●</span></span>`;
    if (k.kind === "toggle") {
      return `      <div class="knob" data-id="${k.id}" data-kind="toggle">
        ${dot}
        <span class="label">${k.label}</span>
        <span class="controls"><button class="btn-toggle ${k.on ? "on" : "off"}" data-cmd="toggle" role="switch" aria-checked="${k.on}">${k.on ? "On" : "Off"}</button></span>
      </div>`;
    }
    const cmd = k.native ? "nativeAdjust" : "adjust";
    // Range and unit ride on the row, the step on each arrow's delta, so one
    // handler adjusts a px size and a bare font-weight alike.
    return `      <div class="knob" data-id="${k.id}" data-min="${k.min}" data-max="${k.max}" data-unit="${k.unit}">
        ${dot}
        <span class="label">${k.label}</span>
        <span class="controls">
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${-k.step}"><b>&#9660;</b></button>
          <span class="px">${k.px}${k.unit}</span>
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${k.step}"><b>&#9650;</b></button>
        </span>
      </div>`;
  }

  private html(snap: Snapshot | undefined): string {
    const nonce = getNonce();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    if (!snap || !snap.available) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${csp}
<style>${baseCss}</style></head><body>
<p>Claude Code extension not detected.</p></body></html>`;
    }

    const groups = SECTION_ORDER.map((sec) => ({
      sec,
      knobs: snap.knobs.filter(
        (k) => k.section === sec && !HIDDEN_KNOBS.has(k.id),
      ),
    })).filter((g) => g.knobs.length);
    // A divider sits between sections (above every group after the first), not
    // under each title, so section headings read as headings, not underlines.
    const sections = groups
      .map(
        (g, i) =>
          `${i > 0 ? '    <hr class="divider">\n' : ""}    <h2>${g.sec}</h2>\n${g.knobs
            .map((k) => this.knobHtml(k))
            .join("\n")}`,
      )
      .join("\n");

    // The live preview mirrors the two knob sections; show a surface only when
    // that section has knobs on this Claude Code version.
    const hasChat = groups.some((g) => g.sec === "Chat Panel or Tab");
    const hasPlan = groups.some((g) => g.sec === "Plan Mode Markdown Preview");
    const preview = hasChat || hasPlan ? previewHtml(hasChat, hasPlan) : "";
    // Embed the initial values so the first paint is styled before any sync
    // arrives. Escape "<" so a font family can never close the <script>.
    const initialPreview = JSON.stringify(snap.preview).replace(
      /</g,
      "\\u003c",
    );

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
${csp}
<style>${baseCss}</style>
</head>
<body>
  <div class="layout">
    <div class="col col-controls">
      <h1>Claude Code UI Patch</h1>
      <div class="spacer"></div>
      <div class="version-line">Patching: <span class="version-value">Claude Code v${snap.version}</span></div>
      <div class="header-status">${statusInner(snap)}</div>
      <hr class="divider">
${sections}
      <hr class="divider">
      <div class="actions">
        <button class="btn btn-green${snap.needsReload ? "" : " quiet"}" data-cmd="discard" title="Revert to the values on disk at the last window reload">Restore Last Applied</button>
        <button class="btn btn-red" data-cmd="restore" title="Reset every setting to Claude Code's native values">Factory Reset</button>
      </div>
      <a class="link" data-cmd="openSettings">&#9881; Open Settings</a>
      <a class="link link-reload${snap.needsReload ? " link-reload-pending" : ""}" data-cmd="reload">&#8635; Reload Window</a>
    </div>
${preview}  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const pending = {}; // knob id -> last optimistic value we sent (ignore stale echoes until it matches)
    const pendingToggle = {}; // toggle id -> last optimistic on/off we sent
    function fmt(n) { return String(Math.round(n * 100) / 100); }
    function setToggleBtn(btn, on) {
      btn.classList.toggle('on', on);
      btn.classList.toggle('off', !on);
      btn.textContent = on ? 'On' : 'Off';
      btn.setAttribute('aria-checked', String(on));
    }

    // Live preview: style the sample DOM from the effective values so each block
    // is WYSIWYG-true, i.e. exactly what the Claude Code window shows after a
    // reload (same px, family, and paragraph spacing). Nothing here is scaled. A
    // null family means native, so we clear the inline family and let the
    // element's CSS rule (a --vscode-*-font-family var) take over.
    const initialPreview = ${initialPreview};
    function pvPx(n) { return (Math.round(n * 100) / 100) + 'px'; }
    function pvFam(f) { return f || ''; }
    function pvLabel(f) { return f ? f : 'native'; }
    function pvSetVal(key, text) {
      const el = document.querySelector('.pv-cap-val[data-val="' + key + '"]');
      if (el) el.textContent = text;
    }
    function pvStyle(sel, sizePx, family) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (sizePx != null) el.style.fontSize = pvPx(sizePx);
        el.style.fontFamily = pvFam(family);
      });
    }
    function applyPreview(p) {
      if (!p) return;
      const c = p.chat, pl = p.plan;
      // Chat surface.
      pvStyle('.pv-agent-text', c.agentSizePx, c.agentFamily);
      // Bold runs carry their own weight, so paragraph 2's <strong> shows the
      // regular/bold contrast the knob is tuning against the same reading font.
      document.querySelectorAll('.pv-agent-text strong').forEach(function (el) {
        el.style.fontWeight = String(c.agentBoldWeight);
      });
      // Paragraph gaps are em-relative, tracking the agent size exactly as the
      // native rule (margin-top .1em, margin-bottom .2em) times the spacing
      // multiplier; the first block keeps a zero top margin.
      document.querySelectorAll('.pv-agent-text p').forEach(function (pp, i) {
        pp.style.marginTop = i === 0 ? '0' : ('calc(0.1em * ' + c.paraSpacing + ')');
        pp.style.marginBottom = 'calc(0.2em * ' + c.paraSpacing + ')';
      });
      pvStyle('.pv-input-text', c.inputSizePx, null); // input box uses the native UI font
      pvStyle('.pv-chat-inline-ctx', c.agentSizePx, c.agentFamily); // prose around the token
      pvStyle('.pv-chat-inline', c.codeInlineSizePx, c.codeFamily);
      pvStyle('.pv-chat-code', c.codeBlockSizePx, c.codeFamily);
      pvStyle('.pv-user-text', c.userSizePx, c.userFamily);
      // Plan surface.
      pvStyle('.pv-plan-text', pl.textSizePx, pl.textFamily);
      pvStyle('.pv-plan-inline-ctx', pl.textSizePx, pl.textFamily);
      pvStyle('.pv-plan-inline', pl.codeInlineSizePx, pl.codeFamily);
      pvStyle('.pv-plan-code', pl.codeBlockSizePx, pl.codeFamily);
      // Captions read out the true configured values.
      pvSetVal('chatAgent', pvPx(c.agentSizePx) + ' · ' + pvLabel(c.agentFamily) + ' · bold ' + c.agentBoldWeight + ' · paragraph spacing ' + c.paraSpacing + '×');
      pvSetVal('chatInput', pvPx(c.inputSizePx) + ' · native');
      pvSetVal('chatInline', pvPx(c.codeInlineSizePx) + ' · ' + pvLabel(c.codeFamily));
      pvSetVal('chatCode', pvPx(c.codeBlockSizePx) + ' · ' + pvLabel(c.codeFamily));
      pvSetVal('chatUser', pvPx(c.userSizePx) + ' · ' + pvLabel(c.userFamily));
      pvSetVal('planAgent', pvPx(pl.textSizePx) + ' · ' + pvLabel(pl.textFamily));
      pvSetVal('planInline', pvPx(pl.codeInlineSizePx) + ' · ' + pvLabel(pl.codeFamily));
      pvSetVal('planCode', pvPx(pl.codeBlockSizePx) + ' · ' + pvLabel(pl.codeFamily));
    }
    applyPreview(initialPreview);

    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      e.preventDefault();
      const cmd = el.dataset.cmd;
      if (cmd === 'toggle') {
        const knob = el.closest('.knob');
        if (!knob) return;
        const id = knob.dataset.id;
        const next = !el.classList.contains('on');
        setToggleBtn(el, next); // optimistic: flip instantly
        pendingToggle[id] = next;
        vscode.postMessage({ command: 'toggleSet', target: id, on: next });
        return;
      }
      if (cmd === 'adjust' || cmd === 'nativeAdjust') {
        const knob = el.closest('.knob');
        if (!knob) return;
        const pxEl = knob.querySelector('.px');
        const id = knob.dataset.id;
        const min = parseFloat(knob.dataset.min);
        const max = parseFloat(knob.dataset.max);
        const cur = parseFloat(pxEl.textContent);
        let next = Math.min(max, Math.max(min, cur + parseFloat(el.dataset.delta)));
        next = Math.round(next * 100) / 100;
        if (next === cur) return;
        pxEl.textContent = fmt(next) + (knob.dataset.unit || ''); // optimistic: show it instantly
        pending[id] = fmt(next);
        vscode.postMessage({ command: cmd === 'nativeAdjust' ? 'nativeSet' : 'set', target: id, value: next });
        return;
      }
      vscode.postMessage({ command: cmd, key: el.dataset.key });
    });

    window.addEventListener('message', function (e) {
      const m = e.data;
      if (!m || m.type !== 'sync') return;
      (m.knobs || []).forEach(function (k) {
        const knob = document.querySelector('.knob[data-id="' + k.id + '"]');
        if (!knob) return;
        const dot = knob.querySelector('.dot');
        if (dot) { dot.className = 'dot ' + k.dotClass; dot.title = k.dotTitle; }
        const pxEl = knob.querySelector('.px');
        if (pxEl) {
          const unit = knob.dataset.unit || '';
          if (pending[k.id] === undefined) { pxEl.textContent = k.px + unit; }
          else if (pending[k.id] === k.px) { pxEl.textContent = k.px + unit; delete pending[k.id]; }
        }
        const tg = knob.querySelector('.btn-toggle');
        if (tg && typeof k.on === 'boolean') {
          if (pendingToggle[k.id] === undefined) { setToggleBtn(tg, k.on); }
          else if (pendingToggle[k.id] === k.on) { setToggleBtn(tg, k.on); delete pendingToggle[k.id]; }
        }
      });
      if (typeof m.status === 'string') {
        const st = document.querySelector('.header-status');
        if (st) st.innerHTML = m.status;
      }
      const rl = document.querySelector('a[data-cmd="reload"]');
      if (rl) rl.classList.toggle('link-reload-pending', !!m.reloadPending);
      const disc = document.querySelector('button[data-cmd="discard"]');
      if (disc) disc.classList.toggle('quiet', !m.reloadPending);
      if (m.preview) applyPreview(m.preview);
    });
  </script>
</body>
</html>`;
  }
}

// Structure signature: a full re-render happens only when this changes.
function shapeOf(snap: Snapshot | undefined): string {
  if (!snap || !snap.available) return "none";
  return [
    snap.supported,
    snap.version,
    snap.knobs.map((k) => k.id).join(","),
  ].join("|");
}

// The per-knob "traffic light": green when the patch is in effect, yellow when a
// window reload is due, red when the setting is wanted but its anchor is gone on
// this Claude Code version (so it can't apply until a build restores it).
function dotInfo(k: Knob): { cls: string; title: string } {
  if (k.lost)
    return {
      cls: "dot-lost",
      title: "unavailable on this Claude Code version",
    };
  if (k.native) return { cls: "dot-ok", title: "live" };
  return k.pendingReload
    ? { cls: "dot-warn", title: "reload window to take effect" }
    : { cls: "dot-ok", title: "in effect" };
}

function statusInner(snap: Snapshot): string {
  if (!snap.supported)
    return `<span class="status-banner warn">Patch not supported on Claude Code v${snap.version}</span>`;
  if (snap.partialLoss)
    return `<span class="status-banner lost">Some settings can't be applied on this version</span>`;
  if (snap.needsReload)
    return `<span class="status-banner warn">Reload window to apply changes</span>`;
  return `<span class="status-banner ok">All settings applied</span>`;
}

// Lightweight per-knob state + header status for in-place DOM updates.
function syncPayload(snap: Snapshot): {
  knobs: Array<{
    id: string;
    px: string;
    on: boolean;
    dotClass: string;
    dotTitle: string;
  }>;
  status: string;
  reloadPending: boolean;
  preview: PreviewModel;
} {
  const knobs = snap.knobs.map((k) => {
    const { cls: dotClass, title: dotTitle } = dotInfo(k);
    return { id: k.id, px: k.px, on: k.on, dotClass, dotTitle };
  });
  return {
    knobs,
    status: statusInner(snap),
    reloadPending: snap.needsReload,
    preview: snap.preview,
  };
}

// Static sample markup for the live-preview column. The webview script sizes and
// fonts it from the PreviewModel on first paint and on every sync, and fills each
// caption's value. Inline code and code blocks get separate examples, and the two
// surfaces are grouped under headings that mirror the control sections; each is
// gated on whether its knob section exists on this Claude Code version. Keep the
// code samples free of backticks and "${" so they survive this template literal.
function previewHtml(hasChat: boolean, hasPlan: boolean): string {
  const chat = hasChat
    ? `      <hr class="divider">
      <h2>Chat Panel or Tab</h2>
      <div class="pv-cap">Agent response <span class="pv-cap-val" data-val="chatAgent"></span></div>
      <div class="pv-bubble"><div class="pv-agent-text"><p>This is paragraph 1: this is an example sentence. This is another sentence.</p><p>This is paragraph 2: this live preview serves as a quick mock-up, where <strong>every block is WYSIWYG-true</strong> to what a reload would show.</p></div></div>
      <div class="pv-cap">User message input <span class="pv-cap-val" data-val="chatInput"></span></div>
      <div class="pv-inputbox"><div class="pv-input-text">This is the textarea where you type...</div></div>
      <div class="pv-cap">User message history <span class="pv-cap-val" data-val="chatUser"></span></div>
      <div class="pv-bubble pv-user"><div class="pv-user-text">This is the message you sent.</div></div>
      <div class="pv-cap">Inline code <span class="pv-cap-val" data-val="chatInline"></span></div>
      <div class="pv-bubble"><div class="pv-chat-inline-ctx">Inline code example: <code class="pv-inline pv-chat-inline">helloWorld()</code>.</div></div>
      <div class="pv-cap">Code block <span class="pv-cap-val" data-val="chatCode"></span></div>
      <pre class="pv-pre pv-chat-code"><code>function greet(name) {\n  return "Hello, " + name;\n}</code></pre>\n`
    : "";
  const plan = hasPlan
    ? `      <hr class="divider">
      <h2>Plan Mode Markdown Preview</h2>
      <div class="pv-cap">Agent response <span class="pv-cap-val" data-val="planAgent"></span></div>
      <div class="pv-bubble"><div class="pv-plan-text"><p>This is the rendered Markdown plan in the Plan Mode.</p></div></div>
      <div class="pv-cap">Inline code <span class="pv-cap-val" data-val="planInline"></span></div>
      <div class="pv-bubble"><div class="pv-plan-inline-ctx">This is the inline code in Markdown Preview <code class="pv-inline pv-plan-inline">helloWorld()</code>.</div></div>
      <div class="pv-cap">Code block <span class="pv-cap-val" data-val="planCode"></span></div>
      <pre class="pv-pre pv-plan-code"><code>def load_config(path):\n    with open(path) as f:\n        return json.load(f)</code></pre>\n`
    : "";
  return `    <div class="col col-preview">
      <h2 class="pv-title">Live Preview</h2>
      <div class="pv-note">Only font size and spacing knobs that you tune by eye are previewed here, not the whole patch (toggles, diff cards, buttons, find bar, and other fixes are not in this preview). Every block is shown true to size, so it matches what the Claude Code interface will show after the window reload.</div>
${chat}${plan}    </div>
`;
}

const baseCss = `
  body {
    font-family: var(--vscode-font-family);
    font-size: calc(var(--vscode-font-size) * 1.2);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 1040px;
    padding: 16px 28px;
  }
  /* Controls on the left, live preview on the right. They wrap to a single
     column when the panel is too narrow to hold both at their min widths. */
  .layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 36px; }
  .col-controls { flex: 1 1 440px; min-width: 420px; max-width: 520px; }
  .col-preview { flex: 1 1 340px; min-width: 300px; }
  h1 { font-size: 1.7em; font-weight: 700; margin: 0; }
  /* The preview's column title. Its section headings reuse the h2 rule below, so
     they match the control panel's section headings in size and color exactly. */
  .pv-title { font-size: 1.35em; font-weight: 700; margin: 0 0 4px; }
  .spacer { height: 4px; }
  .version-line { font-size: 1.1em; font-weight: 400; margin-bottom: 4px; }
  .version-value { color: #d97757; }
  .header-status { margin-top: 10px; margin-bottom: 2px; font-size: 1.1em; font-weight: 500; }
  h2 { font-size: 1.1em; margin: 12px 0 5px; }
  .knob { display: flex; align-items: center; padding: 3px 0; }
  .knob .dot-slot { width: 14px; flex-shrink: 0; text-align: center; margin-right: 14px; }
  .knob .label { flex: 1 1 auto; min-width: 160px; }
  .knob .controls { display: flex; align-items: center; justify-content: center; width: 168px; flex-shrink: 0; margin-left: 16px; }
  .knob .btn-sm { width: 34px; flex-shrink: 0; text-align: center; margin: 0 2px; }
  .knob .px { width: 72px; flex-shrink: 0; text-align: center; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; color: var(--vscode-textLink-foreground); }
  .knob .note { font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .btn { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 5px 16px; border-radius: 2px; cursor: pointer; font-size: inherit; font-weight: 600; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-green { background: #3fa34d; color: #fff; }
  .btn-green:hover { background: #368c42; }
  /* Quiet (nothing pending): "Restore Last Applied" has nothing to revert, so it
     recedes to an outline instead of shouting in solid green. The border is an
     inset box-shadow, not a real border, so the box stays the same size as the
     solid state and toggling between them never shifts layout. */
  .btn-green.quiet { background: transparent; color: #3fa34d; box-shadow: inset 0 0 0 1px #3fa34d; }
  .btn-green.quiet:hover { background: rgba(63, 163, 77, 0.12); }
  .btn-red { background: #c74e39; color: #fff; }
  .btn-red:hover { background: #b13f2c; }
  .btn-sm { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 0; border-radius: 2px; cursor: pointer; font-size: inherit; font-weight: bold; }
  .btn-sm:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .knob .btn-toggle { width: 100%; text-align: center; border: none; border-radius: 2px; padding: 3px 0; cursor: pointer; font-size: inherit; font-weight: 600; }
  .knob .btn-toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .knob .btn-toggle.off { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .knob .btn-toggle.on:hover { background: var(--vscode-button-hoverBackground); }
  .knob .btn-toggle.off:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { margin-top: 12px; display: flex; flex-direction: row; justify-content: space-between; align-items: center; gap: 10px; }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 9px 0; }
  /* Every header status is a full-width banner so the strip never changes height
     between states: green when everything is applied, yellow when a reload is due
     or the version is unsupported, and Claude clay when some wanted settings can't
     be applied on this Claude Code version. */
  .status-banner { display: block; color: #fff; padding: 4px 12px; border-radius: 3px; font-weight: 700; }
  .status-banner.ok { background: #3fa34d; }
  .status-banner.warn { background: var(--vscode-statusBarItem-warningBackground, #b7791f); }
  .status-banner.lost { background: #d97757; }
  .dot { font-size: .8em; }
  .dot-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .dot-warn { color: var(--vscode-editorWarning-foreground); }
  .dot-lost { color: var(--vscode-editorError-foreground, #c74e39); }
  a.link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; font-size: 1.1em; margin-top: 12px; display: block; }
  /* The reload link is always a badge with the same box in both states, so it
     never jitters when the pending state flips: green while everything is
     applied, yellow when a reload is due. */
  a.link.link-reload { display: inline-block; background: #3fa34d; color: #fff; padding: 3px 12px; border-radius: 3px; font-weight: 700; }
  a.link.link-reload.link-reload-pending { background: var(--vscode-statusBarItem-warningBackground, #b7791f); }
  /* Live preview. A faithful mock of the chat and plan surfaces; the script
     sizes and fonts each element from the PreviewModel. The font-family rules
     below are the native state (family null), overridden inline by the script
     when a family is set, so clearing the inline style falls back to native. */
  .pv-note { font-size: .9em; color: var(--vscode-descriptionForeground); margin: 2px 0 10px; line-height: 1.4; }
  .pv-cap { font-size: .85em; color: var(--vscode-descriptionForeground); margin: 10px 0 3px; }
  .pv-cap-val { font-variant-numeric: tabular-nums; opacity: .85; }
  .pv-bubble { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 7px 10px; background: var(--vscode-editor-background); }
  .pv-bubble.pv-user { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.08)); }
  .pv-agent-text, .pv-chat-inline-ctx { font-family: var(--vscode-font-family); }
  .pv-agent-text p { margin: 0; white-space: pre-wrap; }
  /* Native bold: what a browser computes for <strong> against a 400 parent. Pinned
     rather than left to the UA default so a theme body weight can't shift the
     baseline the script overrides. */
  .pv-agent-text strong { font-weight: 700; }
  .pv-user-text { font-family: var(--vscode-font-family); }
  /* The chat input box: a mock text field sized by the native chat.fontSize. */
  .pv-inputbox { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; padding: 7px 10px; background: var(--vscode-input-background, var(--vscode-editor-background)); }
  .pv-input-text { font-family: var(--vscode-font-family); color: var(--vscode-input-foreground, var(--vscode-foreground)); }
  .pv-plan-text, .pv-plan-inline-ctx { font-family: var(--vscode-markdown-font-family, var(--vscode-font-family)); }
  .pv-plan-text p { margin: 0; }
  .pv-inline { padding: 0 4px; border-radius: 3px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15)); }
  .pv-chat-inline, .pv-plan-inline { font-family: var(--vscode-editor-font-family); }
  .pv-pre { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); overflow-x: auto; white-space: pre; }
  .pv-pre code { font-family: inherit; }
  .pv-chat-code, .pv-plan-code { font-family: var(--vscode-editor-font-family); }
`;

// Per-render nonce so the Content-Security-Policy can allow only this panel's
// own inline <script> (the HTML is fully extension-generated, so this is
// defense in depth rather than a fix for a known injection).
function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
