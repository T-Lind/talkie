import { useEffect, useState, type FormEvent } from 'react';
import { extractRoomCode, LIMITS } from '@talkie/protocol';
import type { JoinInput, SessionError } from '../hooks/useSession';
import { useDebouncedValue } from '../hooks/useNow';
import type { ProbeResult, RoomLookupResult } from '../lib/server';
import { lookupRoom, probeServer, serverHost } from '../lib/server';

interface OnboardingProps {
  name: string;
  serverUrl: string;
  error: SessionError | null;
  busy: boolean;
  prefillCode: string | null;
  onJoin: (input: JoinInput) => void;
  onUpdateName: (name: string) => void;
  onOpenSettings: () => void;
  onClearError: () => void;
}

type Mode = 'create' | 'enter';

export function Onboarding({
  name,
  serverUrl,
  error,
  busy,
  prefillCode,
  onJoin,
  onUpdateName,
  onOpenSettings,
  onClearError,
}: OnboardingProps) {
  const [mode, setMode] = useState<Mode>('create');
  const [localName, setLocalName] = useState(name);
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState('');
  const [passcode, setPasscode] = useState('');
  const [showPasscode, setShowPasscode] = useState(false);
  const [revealPasscode, setRevealPasscode] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [lookup, setLookup] = useState<RoomLookupResult | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    setLocalName(name);
  }, [name]);

  useEffect(() => {
    if (!prefillCode) return;
    setMode('enter');
    setCode(prefillCode);
    setLocalError(null);
  }, [prefillCode]);

  useEffect(() => {
    if (error?.code === 'bad_passcode') setShowPasscode(true);
  }, [error]);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      const result = await probeServer(serverUrl, 12_000);
      if (alive) setProbe(result);
    };
    void run();
    const timer = window.setInterval(() => void run(), 25_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [serverUrl]);

  const normalizedCode = extractRoomCode(code) ?? '';
  const debouncedCode = useDebouncedValue(normalizedCode, 380);

  useEffect(() => {
    if (mode !== 'enter' || debouncedCode.length !== 6) {
      setLookup(null);
      setLooking(false);
      return;
    }
    let alive = true;
    setLooking(true);
    void lookupRoom(serverUrl, debouncedCode)
      .then((result) => {
        if (!alive) return;
        setLookup(result);
        if (result.status === 'found' && result.room.hasPasscode) setShowPasscode(true);
      })
      .finally(() => {
        if (alive) setLooking(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, debouncedCode, serverUrl]);

  const changeMode = (next: Mode): void => {
    setMode(next);
    setLocalError(null);
    setLookup(null);
    setShowPasscode(false);
    onClearError();
  };

  const touch = (): void => {
    if (localError) setLocalError(null);
    if (error) onClearError();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const cleanName = localName.trim().slice(0, 28);
    const room = roomName.trim().slice(0, 34);
    const extracted = extractRoomCode(code) ?? '';

    if (!cleanName) {
      setLocalError('Add your name first.');
      return;
    }
    if (mode === 'create' && !room) {
      setLocalError('Name the room.');
      return;
    }
    if (mode === 'enter' && extracted.length !== 6) {
      setLocalError('Enter the six-character room code.');
      return;
    }
    if (mode === 'enter' && lookup?.status === 'found' && lookup.room.locked) {
      setLocalError('This room is locked. Ask the host to unlock it.');
      return;
    }

    setLocalError(null);
    onUpdateName(cleanName);
    onJoin({
      mode,
      name: cleanName,
      roomName: room,
      code: extracted,
      passcode: showPasscode ? passcode : '',
      serverUrl,
    });
  };

  const shownError = localError ?? error?.message ?? null;
  const host = serverHost(serverUrl);
  const passcodeLabel =
    mode === 'create'
      ? 'Add a passcode'
      : lookup?.status === 'found' && lookup.room.hasPasscode
        ? 'Enter the room passcode'
        : 'Have a passcode?';

  return (
    <div className="onboarding">
      <div className="onboard-scroll">
        <div className="onboard-brand">Talkie</div>

        <form className="onboard-card" onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="talkie-name">Your name</label>
            <input
              id="talkie-name"
              className="text-input"
              value={localName}
              maxLength={28}
              placeholder="Alex Rivera"
              autoComplete="nickname"
              autoFocus={!localName}
              disabled={busy}
              onChange={(event) => {
                setLocalName(event.target.value);
                touch();
              }}
              onBlur={() => {
                if (localName.trim()) onUpdateName(localName.trim());
              }}
            />
          </div>

          <div className="mode-switch">
            <button
              type="button"
              className="mode-option"
              data-active={mode === 'create' ? 'true' : undefined}
              onClick={() => changeMode('create')}
              disabled={busy}
            >
              Create a room
            </button>
            <button
              type="button"
              className="mode-option"
              data-active={mode === 'enter' ? 'true' : undefined}
              onClick={() => changeMode('enter')}
              disabled={busy}
            >
              Join with a code
            </button>
          </div>

          <div className="mode-fields" key={mode}>
            {mode === 'create' ? (
              <div className="field">
                <label htmlFor="talkie-room">Room name</label>
                <input
                  id="talkie-room"
                  className="text-input"
                  value={roomName}
                  maxLength={34}
                  placeholder="Design sync"
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => {
                    setRoomName(event.target.value);
                    touch();
                  }}
                />
                <p className="field-hint">A six-character code is created for your team.</p>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="talkie-code">Room code</label>
                <input
                  id="talkie-code"
                  className="text-input code-input"
                  value={code}
                  maxLength={48}
                  placeholder="K7F2QX"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  autoCapitalize="characters"
                  disabled={busy}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const extracted = /talkie:|[?&]code=/i.test(raw) ? extractRoomCode(raw) : null;
                    setCode((extracted ?? raw).toUpperCase());
                    touch();
                  }}
                />
                <div className="field-hint" aria-live="polite">
                  {looking ? (
                    <span>Looking up the room…</span>
                  ) : lookup?.status === 'found' ? (
                    <span className={lookup.room.locked ? 'hint-warn' : 'hint-ok'}>
                      {lookup.room.name} · {lookup.room.memberCount} of {LIMITS.membersPerRoom}
                      {lookup.room.locked ? ' · locked' : ''}
                    </span>
                  ) : lookup?.status === 'missing' ? (
                    <span className="hint-warn">No room with that code.</span>
                  ) : lookup?.status === 'error' ? (
                    <span>Couldn't check the code — you can still try.</span>
                  ) : (
                    <span>Ask your host for the six-character code.</span>
                  )}
                </div>
              </div>
            )}

            {showPasscode ? (
              <div className="field">
                <label htmlFor="talkie-passcode">
                  Passcode
                  <button
                    type="button"
                    className="label-action"
                    onClick={(event) => {
                      event.preventDefault();
                      setShowPasscode(false);
                      setPasscode('');
                    }}
                  >
                    remove
                  </button>
                </label>
                <div className="input-with-action">
                  <input
                    id="talkie-passcode"
                    type={revealPasscode ? 'text' : 'password'}
                    className="text-input"
                    value={passcode}
                    maxLength={32}
                    placeholder={mode === 'create' ? 'Optional second key' : 'Room passcode'}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => {
                      setPasscode(event.target.value);
                      touch();
                    }}
                  />
                  <button
                    type="button"
                    className="input-toggle"
                    onClick={() => setRevealPasscode((value) => !value)}
                  >
                    {revealPasscode ? 'hide' : 'show'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="text-link passcode-link"
                onClick={() => {
                  setShowPasscode(true);
                  setRevealPasscode(false);
                }}
              >
                {passcodeLabel}
              </button>
            )}
          </div>

          <div className="form-error" role="alert">
            {shownError ?? ''}
          </div>

          <button type="submit" className="submit-btn" disabled={busy}>
            {busy ? <span className="button-spinner" aria-hidden="true" /> : null}
            <span>
              {busy
                ? mode === 'create'
                  ? 'Creating…'
                  : 'Joining…'
                : mode === 'create'
                  ? 'Create room'
                  : 'Join room'}
            </span>
          </button>
        </form>

        <div className="onboard-foot">
          <button
            type="button"
            className="server-pill"
            onClick={onOpenSettings}
            title="Connection settings"
          >
            <span
              className="status-dot"
              data-status={probe === null ? 'connecting' : probe.ok ? 'online' : 'offline'}
              aria-hidden="true"
            />
            <span className="server-name">
              {probe === null ? 'Checking server…' : probe.ok ? host : `${host} · offline`}
            </span>
          </button>
          <button type="button" className="text-link" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </div>
    </div>
  );
}
