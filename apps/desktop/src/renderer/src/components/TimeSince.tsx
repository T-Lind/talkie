import { useNow } from '../hooks/useNow';
import { formatElapsed } from '../lib/format';

interface ElapsedProps {
  since: number;
  offset?: number;
  className?: string;
}

export function Elapsed({ since, offset = 0, className = '' }: ElapsedProps) {
  const now = useNow();
  return <span className={className}>{formatElapsed(now + offset - since)}</span>;
}
