import { useEffect, useState } from 'react';
import { deepLinkForCode, inviteText, LIMITS, type RoomInfo } from '@talkie/protocol';
import { useClipboard } from '../hooks/useClipboard';
import { Sheet } from './Sheet';
import { Switch } from './Switch';

interface InviteSheetProps {
  open: boolean;
  onClose: () => void;
  room: RoomInfo | null;
  memberCount: number;
  passcode?: string;
  isHost: boolean;
  onLock: (locked: boolean) => void;
}

export function InviteSheet({
  open,
  onClose,
  room,
  memberCount,
  passcode,
  isHost,
  onLock,
}: InviteSheetProps) {
  const copy = useClipboard();
  const [copied, setCopied] = useState<'code' | 'invite' | 'link' | null>(null);
  const [revealPasscode, setRevealPasscode] = useState(false);

  useEffect(() => {
    if (!open) {
      setCopied(null);
      setRevealPasscode(false);
    }
  }, [open]);

  if (!room) {
    return (
      <Sheet open={open} onClose={onClose} title="Invite">
        <p className="sheet-empty">Join a room to invite people.</p>
      </Sheet>
    );
  }

  const rawCode = room.code;
  const shareText = inviteText({
    code: rawCode,
    roomName: room.name,
    ...(passcode ? { passcode } : {}),
    includePasscode: Boolean(passcode),
  });

  const markCopied = (kind: 'code' | 'invite' | 'link'): void => {
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1_800);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Invite"
      subtitle={`${room.name} · ${memberCount} of ${LIMITS.membersPerRoom} here`}
    >
      <div className="invite-code-card">
        <div className="invite-code-head">
          <span>Room code</span>
        </div>
        <button
          type="button"
          className="invite-code-grid"
          onClick={() => {
            void copy(rawCode, 'Room code copied').then((ok) => {
              if (ok) markCopied('code');
            });
          }}
          aria-label={`Copy room code ${rawCode}`}
        >
          {rawCode.split('').map((char, index) => (
            <span className="code-char" key={`${char}-${index}`}>
              {char}
            </span>
          ))}
        </button>
        <p className="invite-tap">{copied === 'code' ? 'Copied' : 'Tap the code to copy it.'}</p>
      </div>

      <div className="invite-actions">
        <button
          type="button"
          className="submit-btn"
          onClick={() => {
            void copy(shareText, 'Invite copied').then((ok) => {
              if (ok) markCopied('invite');
            });
          }}
        >
          {copied === 'invite' ? 'Copied invite' : 'Copy invite'}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            void copy(deepLinkForCode(rawCode), 'Invite link copied').then((ok) => {
              if (ok) markCopied('link');
            });
          }}
          title="Copy talkie:// invite link"
        >
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </button>
      </div>

      {passcode ? (
        <div className="invite-passcode">
          <div>
            <span className="invite-passcode-label">Passcode</span>
            <span className="invite-passcode-value">
              {revealPasscode ? passcode : '•'.repeat(Math.min(8, Math.max(4, passcode.length)))}
            </span>
          </div>
          <div className="invite-passcode-actions">
            <button
              type="button"
              className="text-link"
              onClick={() => setRevealPasscode((value) => !value)}
            >
              {revealPasscode ? 'Hide' : 'Reveal'}
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => void copy(passcode, 'Passcode copied')}
            >
              Copy
            </button>
          </div>
        </div>
      ) : null}

      {isHost ? (
        <div className="setting setting-inline">
          <div className="setting-text">
            <span className="setting-title">Lock room</span>
            <span className="setting-desc">
              No new hands can join. People already here can reconnect.
            </span>
          </div>
          <Switch
            checked={room.locked}
            onChange={onLock}
            label={room.locked ? 'Unlock room' : 'Lock room'}
          />
        </div>
      ) : room.locked ? (
        <p className="inline-note">The host has locked this room.</p>
      ) : null}

      <p className="invite-footnote">
        Anyone with the code can join. The code stops working when the room ends.
      </p>
    </Sheet>
  );
}
