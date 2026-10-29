import { Minus, X } from 'lucide-react';
import type { NativeShell } from '../hooks/useNativeShell';

interface TitleBarProps {
  native: NativeShell;
}

/**
 * A hairline drag strip. On the web there is no window to manage, so it
 * disappears entirely and the content gets the full canvas.
 */
export function TitleBar({ native }: TitleBarProps) {
  if (!native.supported) return null;

  return (
    <header className="titlebar">
      <div className="titlebar-drag drag" aria-hidden="true" />
      <div className="titlebar-actions no-drag">
        <button
          type="button"
          className="win-btn"
          onClick={native.minimize}
          aria-label="Minimize"
          title="Minimize"
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          className="win-btn close"
          onClick={native.close}
          aria-label="Close Team Talkie"
          title="Close"
        >
          <X size={13} />
        </button>
      </div>
    </header>
  );
}
