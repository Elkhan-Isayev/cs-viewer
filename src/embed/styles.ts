/**
 * Styles for the embeddable widget.
 *
 * They live in a string rather than a `.css` file because the widget renders
 * into a shadow root: the host page's stylesheet cannot reach in, and these
 * rules cannot leak out. That matters when the viewer is dropped onto a site
 * whose CSS resets are unknown.
 */
export const WIDGET_CSS = /* css */ `
:host {
  --csv-bg: #0b0e13;
  --csv-panel: rgba(18, 22, 30, 0.92);
  --csv-border: rgba(255, 255, 255, 0.1);
  --csv-text: #e8ecf2;
  --csv-muted: #96a0b0;
  --csv-accent: #f0a63c;
  --csv-team-t: #e6683c;
  --csv-team-ct: #4f9ad6;

  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 240px;
  overflow: hidden;
  background: var(--csv-bg);
  color: var(--csv-text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  contain: layout paint;
}

*, *::before, *::after { box-sizing: border-box; }

canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}

[hidden] { display: none !important; }

/* --- overlays --- */

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(6, 8, 12, 0.82);
  backdrop-filter: blur(6px);
  z-index: 40;
}

.panel {
  width: min(420px, 100%);
  padding: 24px 26px;
  border: 1px solid var(--csv-border);
  border-radius: 14px;
  background: var(--csv-panel);
  text-align: center;
}

.panel h2 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
.hint { margin: 12px 0 0; color: var(--csv-muted); font-size: 12.5px; }
.error-text {
  margin: 0 0 4px;
  color: #ff9b8a;
  font-size: 13px;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
}

.progress { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.1); overflow: hidden; }
.progress > div { height: 100%; width: 0; background: var(--csv-accent); transition: width 0.15s ease-out; }

/* --- sidebar --- */

.sidebar {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 232px;
  max-height: calc(100% - 96px);
  padding: 12px;
  border: 1px solid var(--csv-border);
  border-radius: 12px;
  background: var(--csv-panel);
  overflow-y: auto;
  z-index: 20;
}

.match-map { font-weight: 600; font-size: 14px; }
.match-server { color: var(--csv-muted); font-size: 12px; margin-bottom: 10px; }

.section-title {
  margin: 12px 0 5px;
  font-size: 10.5px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--csv-muted);
}

.team-group { margin-bottom: 8px; }
.team-label { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 3px; }
.team-label.t { color: var(--csv-team-t); }
.team-label.ct { color: var(--csv-team-ct); }

.roster-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--csv-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.roster-row:hover { background: rgba(255, 255, 255, 0.07); }
.roster-row.active { background: rgba(240, 166, 60, 0.18); box-shadow: inset 2px 0 0 var(--csv-accent); }
.roster-row .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.roster-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.kill-row { font-size: 12px; padding: 1px 0; color: var(--csv-muted); }
.kill-row .who { color: var(--csv-text); }
.kill-row .hs { color: var(--csv-accent); }

/* --- hud --- */

.hud {
  position: absolute;
  top: 14px;
  left: 0;
  right: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  z-index: 15;
}

.banner {
  padding: 5px 15px;
  border-radius: 999px;
  background: rgba(10, 13, 18, 0.75);
  border: 1px solid var(--csv-border);
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.3s;
}
.banner.show { opacity: 1; }

/* --- transport --- */

.controls {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--csv-border);
  border-radius: 12px;
  background: var(--csv-panel);
  z-index: 25;
}

.icon-button {
  width: 32px;
  height: 32px;
  flex: none;
  border: 1px solid var(--csv-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--csv-text);
  font-size: 13px;
  cursor: pointer;
}
.icon-button:hover { background: rgba(255, 255, 255, 0.11); }

.time { font-variant-numeric: tabular-nums; color: var(--csv-muted); font-size: 12.5px; flex: none; }

.scrubber { flex: 1; min-width: 60px; accent-color: var(--csv-accent); }

.control { display: flex; align-items: center; gap: 5px; flex: none; font-size: 12px; color: var(--csv-muted); }

.control select,
.control input[type="range"] {
  background: rgba(255, 255, 255, 0.06);
  color: var(--csv-text);
  border: 1px solid var(--csv-border);
  border-radius: 6px;
  padding: 3px 5px;
  font: inherit;
  max-width: 120px;
  accent-color: var(--csv-accent);
}

/* Narrow embeds drop the sidebar and the secondary controls rather than
   letting the transport bar wrap into a wall of widgets. */
@container (max-width: 720px) {
  .sidebar { display: none; }
  .control.optional { display: none; }
}

@media (max-width: 720px) {
  .sidebar { display: none; }
  .control.optional { display: none; }
}
`
