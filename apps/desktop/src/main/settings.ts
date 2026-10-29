import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NativeSettings, WindowBounds } from '../shared/ipc';

const DEFAULTS: NativeSettings = {
  alwaysOnTop: true,
  hideFromCapture: true,
  closeToTray: true,
  launchAtLogin: false,
  bounds: null,
};

function sanitizeBounds(input: unknown): WindowBounds | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width < 320 || width > 1_200 || height < 110 || height > 1_600) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export class SettingsStore {
  private readonly file: string;
  private data: NativeSettings;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = join(app.getPath('userData'), 'window-settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  get(): NativeSettings {
    return {
      ...this.data,
      bounds: this.data.bounds ? { ...this.data.bounds } : null,
    };
  }

  patch(patch: Partial<NativeSettings>): NativeSettings {
    if (typeof patch.alwaysOnTop === 'boolean') this.data.alwaysOnTop = patch.alwaysOnTop;
    if (typeof patch.hideFromCapture === 'boolean') this.data.hideFromCapture = patch.hideFromCapture;
    if (typeof patch.closeToTray === 'boolean') this.data.closeToTray = patch.closeToTray;
    if (typeof patch.launchAtLogin === 'boolean') this.data.launchAtLogin = patch.launchAtLogin;
    if (patch.bounds !== undefined) this.data.bounds = sanitizeBounds(patch.bounds);
    this.scheduleSave();
    return this.get();
  }

  setBounds(bounds: WindowBounds): void {
    const clean = sanitizeBounds(bounds);
    if (!clean) return;
    if (
      this.data.bounds &&
      this.data.bounds.x === clean.x &&
      this.data.bounds.y === clean.y &&
      this.data.bounds.width === clean.width &&
      this.data.bounds.height === clean.height
    ) {
      return;
    }
    this.data.bounds = clean;
    this.scheduleSave();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<NativeSettings>;
      const merged: NativeSettings = { ...DEFAULTS };
      if (typeof parsed.alwaysOnTop === 'boolean') merged.alwaysOnTop = parsed.alwaysOnTop;
      if (typeof parsed.hideFromCapture === 'boolean') merged.hideFromCapture = parsed.hideFromCapture;
      if (typeof parsed.closeToTray === 'boolean') merged.closeToTray = parsed.closeToTray;
      if (typeof parsed.launchAtLogin === 'boolean') merged.launchAtLogin = parsed.launchAtLogin;
      merged.bounds = sanitizeBounds(parsed.bounds);
      this.data = merged;
    } catch {
      this.data = { ...DEFAULTS };
    }
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 300);
  }

  private save(): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // Failing to persist window geometry must never take down the app.
    }
  }
}
