import type { Member } from '@talkie/protocol';
import { Elapsed } from './TimeSince';

interface MemberRowProps {
  member: Member;
  selfId: string | null;
  queuePosition: number | null;
  clockOffset: number;
}

export function MemberRow({ member, selfId, queuePosition, clockOffset }: MemberRowProps) {
  const isSelf = member.id === selfId;
  const connected = member.connected !== false;
  const queued = connected && member.intent === 'queued';

  return (
    <div
      className="member"
      data-self={isSelf ? 'true' : undefined}
      data-queued={queued ? 'true' : undefined}
      data-first={queuePosition === 1 ? 'true' : undefined}
      data-offline={connected ? undefined : 'true'}
    >
      <span className="member-name">
        {member.name}
        {isSelf ? (
          <>
            {' '}
            <span className="you">you</span>
          </>
        ) : null}
      </span>
      <span className="member-side">
        {!connected ? (
          <span className="row-muted">reconnecting…</span>
        ) : queued && queuePosition ? (
          <>
            <span className="queue-number">{queuePosition}</span>
            {member.queuedAt ? (
              <span className="row-muted">
                <Elapsed since={member.queuedAt} offset={clockOffset} />
              </span>
            ) : null}
          </>
        ) : null}
      </span>
    </div>
  );
}
