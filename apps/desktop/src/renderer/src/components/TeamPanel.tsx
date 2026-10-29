import type { Session } from '../hooks/useSession';
import { MemberRow } from './MemberRow';

interface TeamPanelProps {
  session: Session;
  onInvite: () => void;
}

export function TeamPanel({ session, onInvite }: TeamPanelProps) {
  const { members, queue, me, clockOffset } = session;
  const queuedIds = new Set(queue.map((member) => member.id));
  const listeners = members
    .filter((member) => !queuedIds.has(member.id))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  return (
    <div className="panel team-panel" role="region" aria-label="Speaking queue">
      <div className="columns">
        <section className="column queue-column" aria-label="Up next">
          <div className="section-head">
            <span>Up next</span>
            <span className="section-count">{queue.length}</span>
          </div>
          {queue.length > 0 ? (
            <div className="member-list">
              {queue.map((member, index) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  selfId={me?.id ?? null}
                  queuePosition={index + 1}
                  clockOffset={clockOffset}
                />
              ))}
            </div>
          ) : (
            <div className="queue-empty">No hands raised</div>
          )}
        </section>

        <section className="column listening-column" aria-label="Listening">
          <div className="section-head">
            <span>Listening</span>
            <span className="section-count">{listeners.length}</span>
          </div>
          {listeners.length > 0 ? (
            <div className="member-list">
              {listeners.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  selfId={me?.id ?? null}
                  queuePosition={null}
                  clockOffset={clockOffset}
                />
              ))}
            </div>
          ) : (
            <div className="queue-empty">No one else</div>
          )}
          {members.length === 1 ? (
            <div className="alone-hint">
              <span>Just you</span>
              <button type="button" className="text-link" onClick={onInvite}>
                Invite
              </button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
