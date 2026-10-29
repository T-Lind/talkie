import { useEffect, useState } from 'react';
import { formatRoomCode, LIMITS, type RoomInfo } from '@talkie/protocol';
import type { NativeShell } from '../hooks/useNativeShell';
import type { Prefs } from '../lib/prefs';
import { DEFAULT_SERVER } from '../lib/prefs';
import type { Session } from '../hooks/useSession';
import { useClipboard } from '../hooks/useClipboard';
import { normalizeServerUrl, probeServer, serverHost } from '../lib/server';
import { useToast } from './Toasts';
import { Sheet } from './Sheet';
import { Switch } from './Switch';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void;
  native: NativeShell;
  session: Session;
  onInvite: () => void;
  onLeave: () => void;
  onEndRoom: () => void;
}

export function SettingsSheet({
  open,
  onClose,
  prefs,
  updatePrefs,
  native,
  session,
  onInvite,
  onLeave,
  onEndRoom,
}: SettingsSheetProps) {
  const { push } = useToast();
  const copy = useClipboard();
  const [name, setName] = useState(prefs.name);
  const [server, setServer] = useState(prefs.serverUrl);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) {
      setName(prefs.name);
      setServer(prefs.serverUrl);
      setConfirmEnd(false);
    }
  }, [open, prefs.name, prefs.serverUrl]);

  const room: RoomInfo | null = session.room;
  const isHost = Boolean(session.me?.host);
  const nativeSettings =
    native.settings ?? {
      alwaysOnTop: true,
      hideFromCapture: true,
      closeToTray: true,
      launchAtLogin: false,
      bounds: null,
    };
  const windowState = native.window;
  const captureSupported = windowState?.captureSupported ?? false;
  const mac = windowState?.platform === 'darwin';

  const commitName = (): void => {
    const clean = name.trim().slice(0, 28);
    if (!clean) {
      push('Name cannot be empty.', 'error');
      setName(prefs.name);
      return;
    }
    if (clean === prefs.name) return;
    updatePrefs({ name: clean });
    setName(clean);
    if (session.phase === 'room') session.rename(clean);
  };

  const applyServer = async (): Promise<void> => {
    const normalized = normalizeServerUrl(server);
    if (!normalized) {
      push('That server address is not valid.', 'error');
      return;
    }
    updatePrefs({ serverUrl: normalized });
    setServer(normalized);
    if (session.phase === 'room') {
      push('Server saved. It applies the next time you join.', 'info');
    } else {
      push('Server updated.', 'success');
    }
    setChecking(true);
    const result = await probeServer(normalized, 12_000);
    setChecking(false);
    if (result.ok) {
      push(`Server online${result.latencyMs != null ? ` · ${result.latencyMs} ms` : ''}`, 'success');
    } else {
      push("Couldn't reach that server.", 'error');
    }
  };

  const connectionText =
    session.status === 'online'
      ? `Online${session.latency != null ? ` · ${session.latency} ms` : ''}`
      : session.status === 'reconnecting'
        ? 'Reconnecting…'
        : session.status === 'offline'
          ? 'Offline'
          : 'Not connected';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="tall"
      title="Settings"
    >
      <section className="settings-section">
        <h3>You</h3>
        <div className="setting">
          <div className="setting-text">
            <label className="setting-title" htmlFor="settings-name">
              Display name
            </label>
            <span className="setting-desc">What your team sees in the queue.</span>
          </div>
        </div>
        <div className="settings-inline-field">
          <input
            id="settings-name"
            value={name}
            maxLength={28}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitName();
                event.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="mini-btn"
            onClick={commitName}
            disabled={name.trim() === prefs.name}
          >
            Save
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Room</h3>
        {room ? (
          <>
            <div className="setting">
              <div className="setting-text">
                <span className="setting-title">
                  {room.name}
                  {isHost ? <span className="host-tag">host</span> : null}
                </span>
                <span className="setting-desc">
                  <button
                    type="button"
                    className="inline-code"
                    onClick={() => void copy(room.code, 'Room code copied')}
                    title="Copy room code"
                  >
                    {formatRoomCode(room.code)}
                  </button>
                  <span className="dot-sep" aria-hidden="true" />
                  {session.members.length} of {LIMITS.membersPerRoom}
                </span>
              </div>
              <button type="button" className="mini-btn" onClick={onInvite}>
                Invite
              </button>
            </div>
            {isHost ? (
              <div className="setting">
                <div className="setting-text">
                  <span className="setting-title">Lock room</span>
                  <span className="setting-desc">Block new people from joining.</span>
                </div>
                <Switch
                  checked={room.locked}
                  onChange={(locked) => session.setLocked(locked)}
                  label="Lock room"
                />
              </div>
            ) : null}
            <div className="settings-button-row">
              <button type="button" className="ghost-btn" onClick={onLeave}>
                Leave room
              </button>
              {isHost ? (
                confirmEnd ? (
                  <span className="inline-confirm">
                    <span>End for everyone?</span>
                    <button type="button" className="text-link danger" onClick={onEndRoom}>
                      Yes
                    </button>
                    <button type="button" className="text-link" onClick={() => setConfirmEnd(false)}>
                      No
                    </button>
                  </span>
                ) : (
                  <button type="button" className="text-link danger" onClick={() => setConfirmEnd(true)}>
                    End room
                  </button>
                )
              ) : null}
            </div>
          </>
        ) : (
          <p className="inline-note">You are not in a room.</p>
        )}
      </section>

      <section className="settings-section">
        <h3>Sound</h3>
        <div className="setting">
          <div className="setting-text">
            <span className="setting-title">Sounds</span>
            <span className="setting-desc">Soft chimes when a hand goes up.</span>
          </div>
          <Switch
            checked={prefs.sounds}
            onChange={(sounds) => updatePrefs({ sounds })}
            label="Sounds"
          />
        </div>
      </section>

      <section className="settings-section">
        <h3>Desktop</h3>
        {native.supported ? (
          <>
            <div className="setting">
              <div className="setting-text">
                <span className="setting-title">Always on top</span>
                <span className="setting-desc">Float above calls, browsers, and full-screen apps.</span>
              </div>
              <Switch
                checked={nativeSettings.alwaysOnTop}
                onChange={(alwaysOnTop) => void native.update({ alwaysOnTop })}
                label="Always on top"
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span className="setting-title">Hide from screen share</span>
                <span className="setting-desc">
                  Keep the widget out of screen shares and recordings. Applied by the OS; some
                  capture tools can bypass it.
                  {!captureSupported ? ' Not available on this platform.' : ''}
                </span>
              </div>
              <Switch
                checked={nativeSettings.hideFromCapture}
                onChange={(hideFromCapture) => {
                  void native.update({ hideFromCapture });
                  push(
                    hideFromCapture ? 'Hidden from screen shares.' : 'Visible to screen shares again.',
                    hideFromCapture ? 'success' : 'info',
                  );
                }}
                label="Hide from screen share"
                disabled={!captureSupported}
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span className="setting-title">Close to tray</span>
                <span className="setting-desc">Keep running when you close the window.</span>
              </div>
              <Switch
                checked={nativeSettings.closeToTray}
                onChange={(closeToTray) => void native.update({ closeToTray })}
                label="Close to tray"
              />
            </div>
            <div className="setting">
              <div className="setting-text">
                <span className="setting-title">Launch at login</span>
                <span className="setting-desc">
                  {windowState?.isPackaged
                    ? 'Start Talkie quietly when you sign in.'
                    : 'Available in the installed app.'}
                </span>
              </div>
              <Switch
                checked={nativeSettings.launchAtLogin}
                onChange={(launchAtLogin) => void native.update({ launchAtLogin })}
                label="Launch at login"
                disabled={!windowState?.isPackaged}
              />
            </div>
          </>
        ) : (
          <p className="inline-note">
            Always-on-top and screen-share privacy are built into the desktop app.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3>Connection</h3>
        <div className="setting">
          <div className="setting-text">
            <span className="setting-title">Realtime server</span>
            <span className="setting-desc">
              <span className="mono">{serverHost(prefs.serverUrl)}</span>
              <span className="dot-sep" aria-hidden="true" />
              {connectionText}
            </span>
          </div>
          <span className="status-dot" data-status={session.status} aria-hidden="true" />
        </div>
        <div className="settings-inline-field">
          <input
            value={server}
            spellCheck={false}
            autoComplete="off"
            placeholder={DEFAULT_SERVER}
            onChange={(event) => setServer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void applyServer();
              }
            }}
          />
          <button type="button" className="mini-btn" onClick={() => void applyServer()} disabled={checking}>
            {checking ? 'Checking…' : 'Apply'}
          </button>
        </div>
        <p className="setting-footnote">
          Use ws:// locally and wss:// in production. Changes apply the next time you join.
        </p>
      </section>

      <section className="settings-section">
        <h3>Shortcuts</h3>
        <div className="shortcut-list">
          <div>
            <span>{mac ? '⌘' : 'Ctrl'} + Shift + Space</span>
            <kbd>{session.self?.intent === 'queued' ? 'Lower hand' : 'Raise hand'}</kbd>
          </div>
          <div>
            <span>{mac ? '⌘' : 'Ctrl'} + Shift + H</span>
            <kbd>Hide widget</kbd>
          </div>
          <div>
            <span>Space</span>
            <kbd>Signal when focused</kbd>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <div className="about-block">
          <div className="about-row">
            <span>Talkie</span>
            <span className="mono">v{windowState?.version ?? '0.1.0'}</span>
          </div>
          <p>
            Rooms live in memory and never touch a database. The room code is the only key, and
            everything disappears when the room ends.
          </p>
          {native.supported ? (
            <button type="button" className="text-link danger" onClick={native.quit}>
              Quit Talkie
            </button>
          ) : null}
        </div>
      </section>
    </Sheet>
  );
}
