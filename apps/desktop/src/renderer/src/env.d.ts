/// <reference types="vite/client" />

import type { TalkieBridge } from '../../shared/ipc';

declare global {
  interface Window {
    talkie?: TalkieBridge;
  }
}

export {};
