import { useCallback } from 'react';
import { useToast } from '../components/Toasts';

export function useClipboard() {
  const { push } = useToast();

  return useCallback(
    async (text: string, label = 'Copied'): Promise<boolean> => {
      try {
        if (window.talkie) {
          await window.talkie.copyText(text);
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error('Clipboard unavailable');
        }
        push(label, 'success');
        return true;
      } catch {
        push('Could not copy to the clipboard.', 'error');
        return false;
      }
    },
    [push],
  );
}
