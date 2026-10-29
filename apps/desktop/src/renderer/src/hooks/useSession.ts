import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  ERROR_TEXT,
  LIMITS,
  PROTOCOL_VERSION,
  clampText,
  extractRoomCode,
  queueOf,
  type ClientMessage,
  type ErrorCode,
  type Intent,
  type JoinRequest,
  type Member,
  type RoomInfo,
  type ServerMessage,
} from '@talkie/protocol';
import type { ConnectionStatus } from '@shared/ipc';
import { normalizeServerUrl, warmServer } from '../lib/server';
import type { SoundName } from '../lib/sounds';

export interface JoinInput {
  mode: 'create' | 'enter';
  name: string;
  roomName: string;
  code: string;
  passcode: string;
  serverUrl: string;
}

export interface InitialRoom {
  code: string;
  name: string;
  passcode?: string;
}

export interface SessionError {
  code?: ErrorCode;
  message: string;
}

export interface SessionCallbacks {
  onJoined?: (room: RoomInfo, passcode: string | undefined) => void;
  onLeft?: () => void;
  onNotice?: (message: string, tone?: 'info' | 'error' | 'success') => void;
  onSound?: (name: SoundName) => void;
  onNotify?: (kind: 'hand' | 'turn', name?: string) => void;
  onJoinFailed?: (auto: boolean) => void;
}

interface Options {
  initialRoom: InitialRoom | null;
  name: string;
  serverUrl: string;
  clientId: string;
  callbacks: SessionCallbacks;
}

export type SessionPhase = 'boot' | 'onboarding' | 'room';

interface State {
  phase: SessionPhase;
  bootRoomName: string | null;
  status: ConnectionStatus;
  busy: boolean;
  room: RoomInfo | null;
  me: { id: string; host: boolean } | null;
  members: Member[];
  error: SessionError | null;
  latency: number | null;
}

type Action =
  | { type: 'boot'; roomName: string }
  | { type: 'joinStart' }
  | { type: 'joinFailed'; error: SessionError }
  | { type: 'joined'; room: RoomInfo; me: { id: string; host: boolean }; members: Member[] }
  | { type: 'reconnecting' }
  | { type: 'offline' }
  | { type: 'memberAdded'; member: Member }
  | { type: 'memberUpdated'; member: Member }
  | { type: 'memberRemoved'; id: string }
  | { type: 'roomUpdated'; room: RoomInfo }
  | { type: 'latency'; latency: number }
  | { type: 'left' }
  | { type: 'cancel' }
  | { type: 'intent'; memberId: string; intent: Intent; at: number }
  | { type: 'renamed'; id: string; name: string }
  | { type: 'clearError' };

interface Target {
  mode: 'create' | 'enter';
  name: string;
  roomName: string;
  code: string;
  passcode: string;
  serverUrl: string;
  clientId: string;
}

function initialState(options: Options): State {
  const canAutoJoin = Boolean(options.initialRoom && options.name.trim());
  return {
    phase: canAutoJoin ? 'boot' : 'onboarding',
    bootRoomName: options.initialRoom?.name ?? null,
    status: canAutoJoin ? 'connecting' : 'idle',
    busy: false,
    room: null,
    me: null,
    members: [],
    error: null,
    latency: null,
  };
}

function updateMember(members: Member[], member: Member): Member[] {
  const index = members.findIndex((m) => m.id === member.id);
  if (index < 0) return [...members, member];
  const next = [...members];
  next[index] = member;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'boot':
      return {
        ...state,
        phase: 'boot',
        bootRoomName: action.roomName,
        status: 'connecting',
        busy: false,
        error: null,
      };
    case 'joinStart':
      return {
        ...state,
        phase: 'onboarding',
        bootRoomName: null,
        status: 'connecting',
        busy: true,
        error: null,
      };
    case 'joinFailed':
      return {
        ...state,
        phase: 'onboarding',
        bootRoomName: null,
        status: 'idle',
        busy: false,
        room: null,
        me: null,
        members: [],
        error: action.error,
      };
    case 'joined':
      return {
        ...state,
        phase: 'room',
        bootRoomName: null,
        status: 'online',
        busy: false,
        room: action.room,
        me: action.me,
        members: action.members,
        error: null,
      };
    case 'reconnecting':
      return { ...state, status: 'reconnecting' };
    case 'offline':
      return { ...state, status: 'offline' };
    case 'memberAdded': {
      if (state.members.some((m) => m.id === action.member.id)) return state;
      return { ...state, members: [...state.members, action.member] };
    }
    case 'memberUpdated': {
      const isMe = state.me?.id === action.member.id;
      return {
        ...state,
        members: updateMember(state.members, action.member),
        me: isMe ? { id: action.member.id, host: action.member.host } : state.me,
      };
    }
    case 'memberRemoved':
      return { ...state, members: state.members.filter((m) => m.id !== action.id) };
    case 'roomUpdated':
      return { ...state, room: action.room };
    case 'latency':
      return { ...state, latency: action.latency };
    case 'left':
    case 'cancel':
      return {
        ...state,
        phase: 'onboarding',
        bootRoomName: null,
        status: 'idle',
        busy: false,
        room: null,
        me: null,
        members: [],
        error: null,
      };
    case 'intent': {
      const member = state.members.find((m) => m.id === action.memberId);
      if (!member) return state;
      return {
        ...state,
        members: updateMember(state.members, {
          ...member,
          intent: action.intent,
          queuedAt: action.intent === 'queued' ? action.at : null,
        }),
      };
    }
    case 'renamed':
      return {
        ...state,
        members: state.members.map((m) => (m.id === action.id ? { ...m, name: action.name } : m)),
      };
    case 'clearError':
      return { ...state, error: null };
    default:
      return state;
  }
}

function cleanError(code: ErrorCode, message: string | undefined): SessionError {
  const text = message && message.trim() ? message : ERROR_TEXT[code];
  return { code, message: text };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return Math.round(sorted[mid] ?? 0);
}

export function useSession(options: Options) {
  const [state, dispatch] = useReducer(reducer, options, initialState);

  const stateRef = useRef(state);
  stateRef.current = state;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const callbacksRef = useRef(options.callbacks);
  callbacksRef.current = options.callbacks;
  const initialRoomRef = useRef(options.initialRoom);

  const socketRef = useRef<WebSocket | null>(null);
  const targetRef = useRef<Target | null>(null);
  const inRoomRef = useRef(false);
  const closedRef = useRef(false);
  const autoRef = useRef(false);
  const hasJoinedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const lastPongRef = useRef(0);
  const offsetRef = useRef(0);
  const latencySamplesRef = useRef<number[]>([]);
  const openSocketRef = useRef<(target: Target, reconnect: boolean) => void>(() => {});
  const sendRef = useRef<(message: ClientMessage) => boolean>(() => false);

  const stopPing = useCallback(() => {
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  }, []);

  const closeQuietly = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopPing();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }, [stopPing]);

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.t) {
        case 'joined': {
          const firstJoin = !hasJoinedRef.current;
          hasJoinedRef.current = true;
          inRoomRef.current = true;
          autoRef.current = false;
          reconnectAttemptsRef.current = 0;
          latencySamplesRef.current = [];
          offsetRef.current = message.serverTime - Date.now();
          const current = targetRef.current;
          if (current) {
            targetRef.current = {
              ...current,
              mode: 'enter',
              code: message.room.code,
              roomName: message.room.name,
            };
          }
          dispatch({
            type: 'joined',
            room: message.room,
            me: message.me,
            members: message.members,
          });
          callbacksRef.current.onJoined?.(message.room, current?.passcode || undefined);
          if (firstJoin) callbacksRef.current.onSound?.('welcome');
          break;
        }
        case 'member_joined': {
          if (message.member.id === stateRef.current.me?.id) break;
          const isNew = !stateRef.current.members.some((m) => m.id === message.member.id);
          dispatch({ type: 'memberAdded', member: message.member });
          if (isNew) callbacksRef.current.onSound?.('join');
          break;
        }
        case 'member_updated': {
          const previous = stateRef.current.members.find((m) => m.id === message.member.id);
          const isMe = message.member.id === stateRef.current.me?.id;
          dispatch({ type: 'memberUpdated', member: message.member });
          if (!isMe && message.member.intent === 'queued' && previous?.intent !== 'queued') {
            callbacksRef.current.onSound?.('raise');
            callbacksRef.current.onNotify?.('hand', message.member.name);
          }
          break;
        }
        case 'member_left':
          dispatch({ type: 'memberRemoved', id: message.id });
          break;
        case 'room_updated':
          dispatch({ type: 'roomUpdated', room: message.room });
          break;
        case 'pong': {
          lastPongRef.current = Date.now();
          offsetRef.current = message.serverTime - Date.now();
          const sample = Math.max(0, Math.round(performance.now() - message.at));
          latencySamplesRef.current = [...latencySamplesRef.current.slice(-2), sample];
          dispatch({ type: 'latency', latency: median(latencySamplesRef.current) });
          break;
        }
        case 'closed': {
          closedRef.current = true;
          inRoomRef.current = false;
          autoRef.current = false;
          closeQuietly();
          dispatch({ type: 'left' });
          const reason =
            message.reason === 'ended'
              ? `Room ended${message.by ? ` by ${message.by}` : ''}.`
              : message.reason === 'expired'
                ? 'This room expired.'
                : 'This room no longer exists.';
          callbacksRef.current.onLeft?.();
          callbacksRef.current.onNotice?.(reason, 'info');
          break;
        }
        case 'error': {
          const error = cleanError(message.code, message.message);
          if (!inRoomRef.current) {
            closedRef.current = true;
            closeQuietly();
            dispatch({ type: 'joinFailed', error });
            callbacksRef.current.onJoinFailed?.(autoRef.current);
            callbacksRef.current.onSound?.('error');
            autoRef.current = false;
          } else if (stateRef.current.status !== 'online') {
            // A failed resume (expired room, lock, rate limit) must not leave a
            // stale room on screen. Return to the welcome screen with the reason.
            closedRef.current = true;
            inRoomRef.current = false;
            autoRef.current = false;
            closeQuietly();
            dispatch({ type: 'joinFailed', error });
            callbacksRef.current.onLeft?.();
            callbacksRef.current.onNotice?.(error.message, 'error');
          } else {
            callbacksRef.current.onNotice?.(error.message, 'error');
          }
          break;
        }
        default:
          break;
      }
    },
    [closeQuietly],
  );

  const scheduleReconnect = useCallback(() => {
    if (closedRef.current || !targetRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    const attempt = reconnectAttemptsRef.current;
    if (attempt >= 8) {
      dispatch({ type: 'offline' });
      return;
    }
    reconnectAttemptsRef.current = attempt + 1;
    dispatch({ type: 'reconnecting' });
    const delay = Math.min(8_000, 450 * 2 ** attempt) + Math.random() * 250;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      const target = targetRef.current;
      if (target) openSocketRef.current(target, true);
    }, delay);
  }, []);

  const openSocket = useCallback(
    (target: Target, reconnect: boolean) => {
      closeQuietly();
      closedRef.current = false;
      targetRef.current = target;
      if (!reconnect) {
        hasJoinedRef.current = false;
        reconnectAttemptsRef.current = 0;
        inRoomRef.current = false;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(target.serverUrl);
      } catch {
        dispatch({ type: 'joinFailed', error: { message: 'That server address is not valid.' } });
        callbacksRef.current.onJoinFailed?.(autoRef.current);
        return;
      }
      socketRef.current = socket;
      lastPongRef.current = Date.now();

      connectTimerRef.current = window.setTimeout(() => {
        connectTimerRef.current = null;
        if (socket.readyState !== WebSocket.OPEN) {
          try {
            socket.close();
          } catch {
            // Ignore.
          }
        }
      }, 8_000);

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        lastPongRef.current = Date.now();
        const join: JoinRequest =
          target.mode === 'create'
            ? {
                t: 'join',
                mode: 'create',
                name: target.name,
                roomName: target.roomName,
                clientId: target.clientId,
                protocol: PROTOCOL_VERSION,
                ...(target.passcode ? { passcode: target.passcode } : {}),
              }
            : {
                t: 'join',
                mode: 'enter',
                name: target.name,
                code: target.code,
                clientId: target.clientId,
                protocol: PROTOCOL_VERSION,
                ...(target.passcode ? { passcode: target.passcode } : {}),
              };
        try {
          socket.send(JSON.stringify(join));
        } catch {
          // The close handler deals with failure.
        }
        stopPing();
        pingTimerRef.current = window.setInterval(() => {
          if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongRef.current > 25_000) {
            try {
              socket.close();
            } catch {
              // Ignore.
            }
            return;
          }
          try {
            socket.send(JSON.stringify({ t: 'ping', at: performance.now() }));
          } catch {
            // Ignore.
          }
        }, 8_000);
      };

      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        try {
          const payload = JSON.parse(String(event.data)) as ServerMessage;
          if (payload && typeof payload === 'object' && typeof payload.t === 'string') {
            handleMessage(payload);
          }
        } catch {
          // Ignore malformed frames.
        }
      };

      socket.onerror = () => {
        // The close event carries the actionable information.
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        stopPing();
        if (closedRef.current) return;
        if (!inRoomRef.current) {
          dispatch({
            type: 'joinFailed',
            error: {
              message: "Couldn't reach the server. Check the address and try again.",
            },
          });
          callbacksRef.current.onJoinFailed?.(autoRef.current);
          autoRef.current = false;
          return;
        }
        scheduleReconnect();
      };
    },
    [closeQuietly, handleMessage, scheduleReconnect, stopPing],
  );

  openSocketRef.current = openSocket;

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }, []);
  sendRef.current = send;

  useEffect(() => {
    const room = initialRoomRef.current;
    const { name, serverUrl, clientId } = optionsRef.current;
    if (!room || !name.trim()) return;
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) {
      dispatch({ type: 'joinFailed', error: { message: 'The saved server address is not valid.' } });
      callbacksRef.current.onJoinFailed?.(true);
      return;
    }
    autoRef.current = true;
    dispatch({ type: 'boot', roomName: room.name || 'your room' });
    const target: Target = {
      mode: 'enter',
      name: name.trim(),
      roomName: room.name,
      code: room.code,
      passcode: room.passcode ?? '',
      serverUrl: normalized,
      clientId,
    };
    void warmServer(normalized).finally(() => {
      if (closedRef.current) return;
      openSocket(target, false);
    });
  }, [openSocket]);

  useEffect(() => {
    return () => {
      closedRef.current = true;
      closeQuietly();
    };
  }, [closeQuietly]);

  const join = useCallback(
    (input: JoinInput) => {
      const name = clampText(input.name, LIMITS.displayName);
      const passcode = input.passcode.trim().slice(0, 64);
      const normalized = normalizeServerUrl(input.serverUrl);
      if (!name) {
        dispatch({ type: 'joinFailed', error: { message: 'Choose a display name first.' } });
        return;
      }
      if (!normalized) {
        dispatch({ type: 'joinFailed', error: { message: 'That server address is not valid.' } });
        return;
      }
      const code = extractRoomCode(input.code) ?? '';
      const roomName = clampText(input.roomName, LIMITS.roomName);
      if (input.mode === 'enter' && code.length !== LIMITS.roomCodeLength) {
        dispatch({ type: 'joinFailed', error: { message: 'Enter the 6-character room code.' } });
        return;
      }
      if (input.mode === 'create' && !roomName) {
        dispatch({ type: 'joinFailed', error: { message: 'Give your room a name.' } });
        return;
      }
      autoRef.current = false;
      closedRef.current = false;
      dispatch({ type: 'joinStart' });
      const target: Target = {
        mode: input.mode,
        name,
        roomName,
        code: input.mode === 'enter' ? code : '',
        passcode,
        serverUrl: normalized,
        clientId: optionsRef.current.clientId,
      };
      void warmServer(normalized).finally(() => {
        if (closedRef.current) return;
        openSocket(target, false);
      });
    },
    [openSocket],
  );

  const cancel = useCallback(() => {
    closedRef.current = true;
    autoRef.current = false;
    closeQuietly();
    targetRef.current = null;
    inRoomRef.current = false;
    dispatch({ type: 'cancel' });
  }, [closeQuietly]);

  const retry = useCallback(() => {
    const target = targetRef.current;
    if (!target) return;
    closedRef.current = false;
    reconnectAttemptsRef.current = 0;
    if (inRoomRef.current) {
      dispatch({ type: 'reconnecting' });
      openSocket(target, true);
    } else {
      dispatch({ type: 'joinStart' });
      openSocket(target, false);
    }
  }, [openSocket]);

  const leave = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      sendRef.current({ t: 'leave' });
    }
    closedRef.current = true;
    autoRef.current = false;
    closeQuietly();
    targetRef.current = null;
    inRoomRef.current = false;
    hasJoinedRef.current = false;
    reconnectAttemptsRef.current = 0;
    dispatch({ type: 'left' });
    callbacksRef.current.onLeft?.();
  }, [closeQuietly]);

  const setIntent = useCallback((intent: Intent) => {
    const current = stateRef.current;
    if (current.status !== 'online' || !current.me) return;
    const at = Date.now() + offsetRef.current;
    dispatch({ type: 'intent', memberId: current.me.id, intent, at });
    sendRef.current({ t: 'intent', intent });
    if (intent === 'queued') callbacksRef.current.onSound?.('raise');
    else callbacksRef.current.onSound?.('lower');
  }, []);

  const toggleHand = useCallback(() => {
    const current = stateRef.current;
    const me = current.members.find((m) => m.id === current.me?.id);
    if (!me) return;
    setIntent(me.intent === 'queued' ? 'listening' : 'queued');
  }, [setIntent]);

  const rename = useCallback((raw: string) => {
    const name = clampText(raw, LIMITS.displayName);
    const current = stateRef.current;
    if (!name || !current.me) return;
    if (targetRef.current) targetRef.current.name = name;
    dispatch({ type: 'renamed', id: current.me.id, name });
    sendRef.current({ t: 'profile', name });
  }, []);

  const setLocked = useCallback((locked: boolean) => {
    sendRef.current({ t: 'lock', locked });
  }, []);

  const endRoom = useCallback(() => {
    sendRef.current({ t: 'end' });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: 'clearError' });
  }, []);

  const self = useMemo(
    () => state.members.find((m) => m.id === state.me?.id) ?? null,
    [state.members, state.me?.id],
  );
  const queue = useMemo(() => queueOf(state.members), [state.members]);
  const queuePosition =
    self && self.intent === 'queued' ? queue.findIndex((m) => m.id === self.id) + 1 : 0;

  const previousPositionRef = useRef(0);
  useEffect(() => {
    if (state.phase !== 'room' || state.status !== 'online') {
      previousPositionRef.current = 0;
      return;
    }
    if (queuePosition === 1 && previousPositionRef.current > 1) {
      callbacksRef.current.onSound?.('turn');
      callbacksRef.current.onNotify?.('turn');
    }
    previousPositionRef.current = queuePosition;
  }, [queuePosition, state.phase, state.status]);

  return {
    ...state,
    self,
    queue,
    queuePosition,
    online: state.status === 'online',
    clockOffset: offsetRef.current,
    join,
    cancel,
    retry,
    leave,
    setIntent,
    toggleHand,
    rename,
    setLocked,
    endRoom,
    clearError,
  };
}

export type Session = ReturnType<typeof useSession>;
