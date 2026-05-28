import type { RecordingState, ExtensionMessage } from '@docext/shared';

const LOGO_SVG_HTML = `
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block">
    <circle cx="12" cy="12" r="10" fill="#6366f1"></circle>
    <path
      d="M9 7.5h4a4.5 4.5 0 0 1 0 9H9"
      fill="none"
      stroke="#ffffff"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
  </svg>
`;

let toolbarHost: HTMLElement | null = null;
let toolbarShadow: ShadowRoot | null = null;
let toolbarTimer: ReturnType<typeof setInterval> | null = null;
let promptDismissTimer: ReturnType<typeof setTimeout> | null = null;
let promptOnYes: (() => void) | null = null;
let promptOnNo: (() => void) | null = null;

export function getToolbarHost(): HTMLElement | null {
  return toolbarHost;
}

function safeSendMessage(msg: ExtensionMessage): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function createFloatingToolbar(editMode: boolean, onEditToggle: () => void) {
  if (toolbarHost) return;

  toolbarHost = document.createElement('div');
  toolbarHost.id = 'docext-toolbar';
  toolbarHost.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:auto;';
  toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });

  toolbarShadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        box-shadow: 0 4px 24px rgba(99,102,241,0.12), 0 1px 3px rgba(0,0,0,0.06);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #334155;
        user-select: none;
      }
      .confirm-row {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 7px 14px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        box-shadow: 0 4px 16px rgba(99,102,241,0.10), 0 1px 3px rgba(0,0,0,0.05);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        color: #475569;
        user-select: none;
        white-space: nowrap;
        animation: slide-up 0.15s ease-out;
      }
      .confirm-row.visible { display: flex; }
      @keyframes slide-up {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .confirm-label {
        font-weight: 500;
        color: #334155;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .confirm-label em {
        font-style: normal;
        color: #6366f1;
        font-weight: 600;
      }
      .logo { width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
      .rec-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow: 0 0 0 3px rgba(239,68,68,0.15);
        animation: pulse 1.5s ease-in-out infinite;
        flex-shrink: 0;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 3px rgba(239,68,68,0.15); }
        50% { opacity: 0.5; box-shadow: 0 0 0 5px rgba(239,68,68,0.08); }
      }
      .info {
        font-variant-numeric: tabular-nums;
        color: #64748b;
        font-size: 12px;
        font-weight: 500;
        min-width: 90px;
      }
      .sep {
        width: 1px;
        height: 18px;
        background: #e2e8f0;
        flex-shrink: 0;
      }
      button {
        background: #f8fafc;
        color: #475569;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        font-family: inherit;
        transition: all 0.15s;
      }
      button:hover { background: #f1f5f9; border-color: #cbd5e1; }
      button.stop {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border-color: transparent;
        color: #fff;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(239,68,68,0.2);
      }
      button.stop:hover { opacity: 0.9; }
      button.cancel {
        color: #64748b;
        border-color: #cbd5e1;
        background: #f8fafc;
      }
      button.cancel:hover { color: #334155; background: #f1f5f9; border-color: #94a3b8; }
      button.edit-active {
        background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
        border-color: transparent;
        color: #fff;
        box-shadow: 0 2px 8px rgba(99,102,241,0.2);
      }
      button.yes-btn {
        background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
        border-color: transparent;
        color: #fff;
        font-weight: 600;
        padding: 4px 11px;
        box-shadow: 0 2px 6px rgba(34,197,94,0.2);
      }
      button.yes-btn:hover { opacity: 0.9; }
      button.no-btn {
        background: #f8fafc;
        color: #64748b;
        border-color: #cbd5e1;
        padding: 4px 11px;
      }
      button.no-btn:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }
      button.screenshot {
        padding: 5px 9px;
        color: #475569;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      button.screenshot:hover { background: #f1f5f9; border-color: #cbd5e1; }
      button.screenshot.capturing {
        opacity: 0.6;
        cursor: default;
        pointer-events: none;
      }
    </style>
    <div class="wrap">
      <div class="confirm-row" id="confirm-row">
        <span class="confirm-label" id="confirm-label">Highlight this?</span>
        <button class="yes-btn" id="confirm-yes">✓ Keep</button>
        <button class="no-btn" id="confirm-no">✗ Skip</button>
      </div>
      <div class="bar">
        <span class="logo">${LOGO_SVG_HTML}</span>
        <span class="rec-dot"></span>
        <span class="info" id="info">0:00 · 0 actions</span>
        <div class="sep"></div>
        <button id="edit">${editMode ? '✎ Done Editing' : '✎ Edit Page'}</button>
        <div class="sep"></div>
        <button id="screenshot" class="screenshot" title="Capture screenshot">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
        </button>
        <div class="sep"></div>
        <button id="cancel" class="cancel">✕ Cancel</button>
        <button id="stop" class="stop">■ Stop</button>
      </div>
    </div>
  `;

  toolbarShadow.getElementById('stop')!.addEventListener('click', () => {
    safeSendMessage({ type: 'STOP_RECORDING' });
  });
  toolbarShadow.getElementById('cancel')!.addEventListener('click', () => {
    safeSendMessage({ type: 'CANCEL_RECORDING' });
  });
  toolbarShadow.getElementById('edit')!.addEventListener('click', onEditToggle);

  toolbarShadow.getElementById('screenshot')!.addEventListener('click', () => {
    const btn = toolbarShadow!.getElementById('screenshot')!;
    if (btn.classList.contains('capturing')) return;
    btn.classList.add('capturing');
    safeSendMessage({ type: 'CAPTURE_SCREENSHOT' }).then(() => {
      btn.classList.remove('capturing');
    }).catch(() => {
      btn.classList.remove('capturing');
    });
  });

  toolbarShadow.getElementById('confirm-yes')!.addEventListener('click', () => {
    const cb = promptOnYes;
    hideHighlightPrompt();
    cb?.();
  });
  toolbarShadow.getElementById('confirm-no')!.addEventListener('click', () => {
    const cb = promptOnNo;
    hideHighlightPrompt();
    cb?.();
  });

  document.documentElement.appendChild(toolbarHost);
}

export function showHighlightPrompt(label: string, onYes: () => void, onNo: () => void) {
  if (!toolbarShadow) { onYes(); return; }

  // Clear any previous pending prompt (treat as "Yes")
  if (promptOnYes) {
    const prev = promptOnYes;
    promptOnYes = null;
    promptOnNo = null;
    clearPromptTimer();
    prev();
  }

  promptOnYes = onYes;
  promptOnNo = onNo;

  const row = toolbarShadow.getElementById('confirm-row');
  const labelEl = toolbarShadow.getElementById('confirm-label');
  if (row) row.classList.add('visible');
  if (labelEl) {
    const short = label.length > 30 ? label.slice(0, 28) + '…' : label;
    labelEl.innerHTML = `Annotate <em>${short}</em>?`;
  }

  // Auto-dismiss after 4s and treat as "Yes"
  promptDismissTimer = setTimeout(() => {
    const cb = promptOnYes;
    hideHighlightPrompt();
    cb?.();
  }, 4000);
}

export function hideHighlightPrompt() {
  clearPromptTimer();
  promptOnYes = null;
  promptOnNo = null;
  if (!toolbarShadow) return;
  const row = toolbarShadow.getElementById('confirm-row');
  if (row) row.classList.remove('visible');
}

function clearPromptTimer() {
  if (promptDismissTimer !== null) {
    clearTimeout(promptDismissTimer);
    promptDismissTimer = null;
  }
}

export function destroyFloatingToolbar() {
  if (toolbarHost) {
    toolbarHost.remove();
    toolbarHost = null;
    toolbarShadow = null;
  }
}

export function updateToolbar(s: RecordingState) {
  if (!toolbarShadow) return;

  const infoEl = toolbarShadow.getElementById('info');
  if (infoEl && s.startedAt) {
    const elapsed = Date.now() - s.startedAt;
    const totalSec = Math.floor(elapsed / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    infoEl.textContent = `${min}:${sec.toString().padStart(2, '0')} · ${s.eventCount} actions`;
  }

  const editBtn = toolbarShadow.getElementById('edit');
  if (editBtn) {
    editBtn.className = s.editMode ? 'edit-active' : '';
    editBtn.textContent = s.editMode ? '✎ Done Editing' : '✎ Edit Page';
  }
}

export function startToolbarTimer() {
  if (toolbarTimer) return;
  toolbarTimer = setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s: RecordingState) => {
        if (chrome.runtime.lastError) return;
        if (s) updateToolbar(s);
      });
    } catch { /* extension context invalidated */ }
  }, 1000);
}

export function stopToolbarTimer() {
  if (toolbarTimer) {
    clearInterval(toolbarTimer);
    toolbarTimer = null;
  }
}

export function hideToolbar() {
  if (toolbarHost) toolbarHost.style.display = 'none';
}

export function showToolbar() {
  if (toolbarHost) toolbarHost.style.display = '';
}
