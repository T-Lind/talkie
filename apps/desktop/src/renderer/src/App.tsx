import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BootScreen } from './components/BootScreen';
import { InviteSheet } from './components/InviteSheet';
import { Onboarding } from './components/Onboarding';
import { RoomHeader } from './components/RoomHeader';
import { SettingsSheet } from './components/SettingsSheet';
import { TeamPanel } from './components/TeamPanel';
import { TitleBar } from './components/TitleBar';
import { ToastProvider, useToast } from './components/Toasts';
import { useClipboard } from './hooks/useClipboard';
import { useNativeShell } from './hooks/useNativeShell';
import { usePrefs } from './hooks/usePrefs';
import { useSession, type JoinInput } from './hooks/useSession';
import { playSound, type SoundName } from './lib/sounds';
import { warmServer } from './lib/server';
import type { TrayState } from '@shared/ipc';

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <Talkie />
      </ToastProvider>
    </ErrorBoundary>
  );
}

function Talkie() {
  const { prefs, update } = usePrefs();
  const native = useNativeShell();
  const { push } = useToast();
  const copy = useClipboard();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [webHeight, setWebHeight] = useState<number | null>(null);
  const [prefillCode, setPrefillCode] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    return code ? code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : null;
  });

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const lastHandNotify = useRef(0);

  const onSound = useCallback((name: SoundName) => {
    if (prefsRef.current.sounds) playSound(name);
  }, []);

  const onNotify = useCallback((kind: 'hand' | 'turn', name?: string) => {
    if (document.hasFocus()) return;
    const bridge = window.talkie;
    if (!bridge) return;
    if (kind === 'hand') {
      const now = Date.now();
      if (now - lastHandNotify.current < 5_000) return;
      lastHandNotify.current = now;
    }
    const stealth = nativeRef.current.window?.hideFromCapture ?? true;
    const body =
      kind === 'turn'
        ? "You're next."
        : stealth
          ? 'A teammate wants to speak.'
          : `${name ?? 'A teammate'} wants to speak.`;
    bridge.notify({ title: 'Talkie', body, silent: true });
  }, []);

  const onJoined = useCallback(
    (room: { code: string; name: string }, passcode: string | undefined) => {
      update({
        lastRoom: {
          code: room.code,
          name: room.name,
          ...(passcode ? { passcode } : {}),
        },
      });
    },
    [update],
  );

  const onLeft = useCallback(() => {
    update({ lastRoom: null });
  }, [update]);

  const onJoinFailed = useCallback(
    (auto: boolean) => {
      if (!auto) return;
      const last = prefsRef.current.lastRoom;
      if (last) setPrefillCode(last.code);
      update({ lastRoom: null });
    },
    [update],
  );

  const onNotice = useCallback(
    (message: string, tone: 'info' | 'error' | 'success' = 'info') => {
      push(message, tone);
    },
    [push],
  );

  const session = useSession({
    initialRoom: prefs.lastRoom,
    name: prefs.name,
    serverUrl: prefs.serverUrl,
    clientId: prefs.clientId,
    callbacks: { onJoined, onLeft, onJoinFailed, onNotice, onSound, onNotify },
  });

  const inRoom = session.phase === 'room' && Boolean(session.room);
  const passcode =
    inRoom && prefs.lastRoom?.code === session.room?.code ? prefs.lastRoom?.passcode : undefined;

  // Wake a sleeping Cloud Run instance while the user is still getting ready.
  useEffect(() => {
    void warmServer(prefsRef.current.serverUrl);
  }, []);

  const handleJoin = useCallback(
    (input: JoinInput) => {
      update({ name: input.name });
      setSettingsOpen(false);
      setInviteOpen(false);
      session.join(input);
    },
    [session.join, update],
  );

  const openInvite = useCallback(() => {
    if (!session.room) return;
    setSettingsOpen(false);
    setInviteOpen(true);
  }, [session.room]);

  const leaveRoom = useCallback(() => {
    if (session.phase !== 'room') return;
    setInviteOpen(false);
    setSettingsOpen(false);
    session.leave();
    push('You left the room.', 'info');
  }, [push, session.leave, session.phase]);

  const endRoom = useCallback(() => {
    setSettingsOpen(false);
    setInviteOpen(false);
    session.endRoom();
  }, [session.endRoom]);

  useEffect(() => {
    if (session.phase !== 'room') {
      setInviteOpen(false);
      setSettingsOpen(false);
    }
  }, [session.phase]);

  useEffect(() => {
    document.title = inRoom && session.room ? `${session.room.name} · Talkie` : 'Talkie';
    const bridge = window.talkie;
    if (!bridge) return;
    const state: TrayState = {
      inRoom,
      ...(session.room ? { roomName: session.room.name, roomCode: session.room.code } : {}),
      memberCount: session.members.length,
      queued: session.self?.intent === 'queued',
      connection: session.status,
    };
    bridge.syncTray(state);
  }, [
    inRoom,
    session.room,
    session.members.length,
    session.self?.intent,
    session.status,
  ]);

  useEffect(() => {
    const bridge = window.talkie;
    if (!bridge) return;
    return bridge.onAction((action) => {
      if (action === 'toggle-hand') {
        if (session.phase === 'room') session.toggleHand();
      } else if (action === 'open-settings') {
        setSettingsOpen(true);
      } else if (action === 'copy-code') {
        if (session.room) void copy(session.room.code, 'Room code copied');
      }
    });
  }, [copy, session.phase, session.room, session.toggleHand]);

  useEffect(() => {
    const bridge = window.talkie;
    if (!bridge) return;
    const apply = (code: string): void => {
      if (session.phase === 'room') {
        push('Leave your current room before joining another.', 'info');
        return;
      }
      setPrefillCode(code);
      setSettingsOpen(false);
      setInviteOpen(false);
    };
    const unsubscribe = bridge.onDeepLink(apply);
    void bridge.takePendingDeepLink().then((code) => {
      if (code) apply(code);
    });
    return unsubscribe;
  }, [push, session.phase]);

  const toggleHand = session.toggleHand;
  const phase = session.phase;

  // The widget is only as tall as its content. Sheets temporarily give it
  // enough room to be comfortable, then it collapses again.
  const measureAndApply = useCallback(() => {
    // Never resize the window while a sheet is open; the sheet scrolls inside
    // whatever size the widget already has.
    if (phase === 'room' && (inviteOpen || settingsOpen)) return;

    const bridge = window.talkie;
    const heightOf = (selector: string): number => {
      const element = document.querySelector(selector);
      return element ? element.getBoundingClientRect().height : 0;
    };

    let height: number;
    if (phase === 'room') {
      const panel = document.querySelector('.panel') as HTMLElement | null;
      const padding = panel
        ? parseFloat(getComputedStyle(panel).paddingTop) +
          parseFloat(getComputedStyle(panel).paddingBottom)
        : 0;
      height = Math.ceil(heightOf('.room-head') + heightOf('.columns') + padding + 2);
    } else if (phase === 'onboarding') {
      const onboarding = document.querySelector('.onboarding') as HTMLElement | null;
      const padding = onboarding
        ? parseFloat(getComputedStyle(onboarding).paddingTop) +
          parseFloat(getComputedStyle(onboarding).paddingBottom)
        : 0;
      height = Math.ceil(heightOf('.titlebar') + heightOf('.onboard-scroll') + padding + 2);
    } else {
      height = 260;
    }

    const max = bridge ? 620 : Math.max(280, window.innerHeight - 32);
    const target = Math.max(110, Math.min(max, height));
    if (bridge) bridge.window.setHeight(target);
    else setWebHeight(target);
  }, [inviteOpen, phase, settingsOpen]);

  useLayoutEffect(() => {
    let frame = 0;
    const run = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measureAndApply);
    };
    run();

    const selector = phase === 'room' ? '.columns' : phase === 'onboarding' ? '.onboard-scroll' : null;
    const target = selector ? document.querySelector(selector) : null;
    const observer = new ResizeObserver(run);
    if (target) observer.observe(target);

    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) run();
    });

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measureAndApply, phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      const target = event.target as HTMLElement | null;
      const interactive = target?.closest(
        'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="switch"], [role="tab"], [role="menuitem"]',
      );
      if (interactive) return;
      if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (phase !== 'room' || settingsOpen || inviteOpen) return;
        event.preventDefault();
        toggleHand();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, settingsOpen, inviteOpen, toggleHand]);

  return (
    <div
      className="app"
      data-phase={session.phase}
      style={!window.talkie && webHeight ? { height: `${webHeight}px` } : undefined}
    >
      {session.phase === 'boot' ? (
        <div key="boot" className="screen">
          <TitleBar native={native} />
          <BootScreen roomName={session.bootRoomName} onCancel={session.cancel} />
        </div>
      ) : session.phase === 'room' && session.room ? (
        <div key="room" className="screen">
          <RoomHeader
            session={session}
            native={native}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <main className="content">
            <TeamPanel session={session} onInvite={openInvite} />
          </main>
        </div>
      ) : (
        <div key="onboarding" className="screen">
          <TitleBar native={native} />
          <Onboarding
            name={prefs.name}
            serverUrl={prefs.serverUrl}
            error={session.error}
            busy={session.busy}
            prefillCode={prefillCode}
            onJoin={handleJoin}
            onUpdateName={(name) => update({ name })}
            onOpenSettings={() => setSettingsOpen(true)}
            onClearError={session.clearError}
          />
        </div>
      )}

      <InviteSheet
        open={inviteOpen && inRoom}
        onClose={() => setInviteOpen(false)}
        room={session.room}
        memberCount={session.members.length}
        passcode={passcode}
        isHost={Boolean(session.me?.host)}
        onLock={(locked) => session.setLocked(locked)}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={prefs}
        updatePrefs={update}
        native={native}
        session={session}
        onInvite={openInvite}
        onLeave={leaveRoom}
        onEndRoom={endRoom}
      />
    </div>
  );
}

interface ErrorState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorState> {
  state: ErrorState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('Team Talkie crashed:', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>Something went quiet.</h1>
          <p>Team Talkie hit an unexpected error. Reloading usually fixes it.</p>
          <button type="button" className="submit-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
