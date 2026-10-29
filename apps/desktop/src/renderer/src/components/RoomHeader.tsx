import { Minus, Settings, X } from 'lucide-react';
import type { Session } from '../hooks/useSession';
import type { NativeShell } from '../hooks/useNativeShell';

interface RoomHeaderProps {
  session: Session;
  native: NativeShell;
  onOpenSettings: () => void;
}

export function RoomHeader({ session, native, onOpenSettings }: RoomHeaderProps) {
  const room = session.room;
  if (!room) return null;

  const count = session.members.length;
  const queued = session.self?.intent === 'queued';
  const position = session.queuePosition;

  const statusText =
    session.status === 'online'
      ? `${count} ${count === 1 ? 'person' : 'people'} here`
      : session.status === 'reconnecting'
        ? 'Reconnecting…'
        : session.status === 'offline'
          ? 'Offline'
          : 'Connecting…';

  return (
    <div className="room-head drag">
      <div className="room-title">
        <div className="room-name-row">
          <h1>{room.name}</h1>
          {room.locked ? <span className="room-locked">Locked</span> : null}
        </div>
        <div className="room-meta">
          <span className="status-dot" data-status={session.status} aria-hidden="true" />
          <span>{statusText}</span>
          {session.status === 'online' && queued && position > 0 ? (
            <>
              <span className="dot-sep" aria-hidden="true" />
              <span>{position === 1 ? "you're next" : `#${position} in line`}</span>
            </>
          ) : null}
          {session.status === 'offline' ? (
            <button type="button" className="room-retry" onClick={session.retry}>
              Retry
            </button>
          ) : null}
        </div>
      </div>

      <div className="room-actions no-drag">
        <button
          type="button"
          className="hand-action"
          data-raised={queued ? 'true' : undefined}
          disabled={!session.online || !session.self}
          onClick={() => session.setIntent(queued ? 'listening' : 'queued')}
          title={queued ? 'Lower your hand' : 'Raise your hand'}
        >
          {queued ? 'Lower hand' : 'Raise hand'}
        </button>

        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          aria-label="Room settings"
          title="Room settings"
        >
          <Settings size={14} />
        </button>

        {native.supported ? (
          <div className="window-controls">
            <button
              type="button"
              className="window-btn"
              onClick={native.minimize}
              aria-label="Minimize"
              title="Minimize"
            >
              <Minus size={12} />
            </button>
            <button
              type="button"
              className="window-btn close"
              onClick={native.close}
              aria-label="Close Team Talkie"
              title="Close"
            >
              <X size={13} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
