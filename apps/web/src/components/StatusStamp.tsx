import type { EngineSnapshot } from '@inkmesh/sync';

/** Connection state as a rubber stamp in the corner of the page. */
export function StatusStamp({ snapshot }: { snapshot: EngineSnapshot }) {
  const { status, unsent } = snapshot;
  const pending = unsent === 1 ? '1 change waiting' : `${unsent} changes waiting`;
  const [headline, detail] =
    status === 'online'
      ? ['Synced', unsent > 0 ? pending : 'all pages match']
      : status === 'connecting'
        ? ['Reaching out', unsent > 0 ? pending : 'saved on this device']
        : ['Offline', unsent > 0 ? pending : 'saved on this device'];

  return (
    <div
      className="stamp"
      data-status={status}
      data-testid="status"
      data-unsent={unsent}
      role="status"
      aria-live="polite"
    >
      <strong>{headline}</strong>
      <span data-testid="status-detail">{detail}</span>
    </div>
  );
}
