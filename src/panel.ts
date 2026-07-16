import * as vscode from "vscode";
import { Patcher, Snapshot, Knob, SECTION_ORDER, STEP, MIN_PX } from "./patcher";

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
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
    this.sub = vscode.Disposable.from(
      patcher.onDidChange(() => this.update()),
      this.panel.onDidDispose(() => {
        PatchPanel.current = undefined;
        this.sub.dispose();
      }),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m))
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
      void this.panel.webview.postMessage({ type: "sync", ...syncPayload(snap) });
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
          msg.key ?? "claudeCodeUiPatch"
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
    return `      <div class="knob" data-id="${k.id}" data-min="${MIN_PX}" data-max="${k.max}">
        ${dot}
        <span class="label">${k.label}</span>
        <span class="controls">
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${-STEP}"><b>&#9660;</b></button>
          <span class="px">${k.px}px</span>
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${STEP}"><b>&#9650;</b></button>
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
      knobs: snap.knobs.filter((k) => k.section === sec),
    })).filter((g) => g.knobs.length);
    // A divider sits between sections (above every group after the first), not
    // under each title, so section headings read as headings, not underlines.
    const sections = groups
      .map(
        (g, i) =>
          `${i > 0 ? '    <hr class="divider">\n' : ""}    <h2>${g.sec}</h2>\n${g.knobs
            .map((k) => this.knobHtml(k))
            .join("\n")}`
      )
      .join("\n");

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
${csp}
<style>${baseCss}</style>
</head>
<body>
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
  <a class="link" data-cmd="openSettings">&#9881; Open VS Code Settings</a>
  <a class="link link-reload${snap.needsReload ? " link-reload-pending" : ""}" data-cmd="reload">&#8635; Reload Window</a>
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
        pxEl.textContent = fmt(next) + 'px'; // optimistic: show it instantly
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
          if (pending[k.id] === undefined) { pxEl.textContent = k.px + 'px'; }
          else if (pending[k.id] === k.px) { pxEl.textContent = k.px + 'px'; delete pending[k.id]; }
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
    });
  </script>
</body>
</html>`;
  }
}

// Structure signature: a full re-render happens only when this changes.
function shapeOf(snap: Snapshot | undefined): string {
  if (!snap || !snap.available) return "none";
  return [snap.supported, snap.version, snap.knobs.map((k) => k.id).join(",")].join("|");
}

// The per-knob "traffic light": green when the patch is in effect, yellow when a
// window reload is due, red when the setting is wanted but its anchor is gone on
// this Claude Code version (so it can't apply until a build restores it).
function dotInfo(k: Knob): { cls: string; title: string } {
  if (k.lost)
    return { cls: "dot-lost", title: "unavailable on this Claude Code version" };
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
  knobs: Array<{ id: string; px: string; on: boolean; dotClass: string; dotTitle: string }>;
  status: string;
  reloadPending: boolean;
} {
  const knobs = snap.knobs.map((k) => {
    const { cls: dotClass, title: dotTitle } = dotInfo(k);
    return { id: k.id, px: k.px, on: k.on, dotClass, dotTitle };
  });
  return { knobs, status: statusInner(snap), reloadPending: snap.needsReload };
}

const baseCss = `
  body {
    font-family: var(--vscode-font-family);
    font-size: calc(var(--vscode-font-size) * 1.2);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 480px;
    padding: 16px 28px;
  }
  h1 { font-size: 1.7em; font-weight: 700; margin: 0; }
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
