interface BootScreenProps {
  roomName: string | null;
  onCancel: () => void;
}

export function BootScreen({ roomName, onCancel }: BootScreenProps) {
  return (
    <div className="boot">
      <span className="boot-pulse" aria-hidden="true" />
      <h2>Joining {roomName ?? 'your room'}…</h2>
      <button type="button" className="text-link" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
