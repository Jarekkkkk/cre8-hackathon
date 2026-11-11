import type { ReactNode } from 'react';
import { AppIcon } from '../../components/AppIcon';
import { Link } from 'react-router-dom';
import { Spinner } from '../../components/ui';

export type TicketAction = 'deposit' | 'withdraw';
export type TicketProgress = {
  title: string;
  detail?: string;
  tone: 'pending' | 'confirmed' | 'notice' | 'error';
  hash?: string;
  amount?: string;
  /** whitelist-only：沒有送出任何東西，所以不給「View portfolio」，只給完成與改金額。 */
  restricted?: boolean;
};

export function TicketFund({ name, image }: {
  name: string;
  image?: { src: string; position: number };
}) {
  return (
    <div className="app-ticket-fund">
      {image ? (
        <img src={image.src} alt="" width={42} height={42} style={{ objectPosition: `50% ${image.position}%` }} />
      ) : (
        <span className="app-icon-tile"><AppIcon name="holdings" size={21} /></span>
      )}
      <strong>{name}</strong>
    </div>
  );
}

export function TicketReview({
  action, amount, destination, network, note, onEdit, onConfirm,
}: {
  action: TicketAction;
  amount: string;
  destination: string;
  network: string;
  note?: string;
  onEdit: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="app-ticket-review">
      <div className="app-ticket-amount">
        <strong>{amount}</strong>
      </div>
      <dl className="app-ticket-details app-ticket-summary">
        <dt>To</dt><dd>{destination}</dd>
        <dt>Network</dt><dd>{network}</dd>
      </dl>
      {note && <p className="app-ticket-note">{note}</p>}
      <div className="app-sheet-actions app-sheet-actions-stacked">
        <button type="button" className="btn primary" onClick={onConfirm}>Confirm {action === 'deposit' ? 'deposit' : 'withdrawal'}</button>
        <button type="button" className="btn ghost" onClick={onEdit}>Edit amount</button>
      </div>
    </div>
  );
}

export function TicketReceipt({
  fund, progress, onDone, onBack, onViewPortfolio, explorerUrl, busy,
}: {
  fund: ReactNode;
  progress: TicketProgress;
  onDone: () => void;
  onBack: () => void;
  onViewPortfolio: () => void;
  explorerUrl?: string;
  busy: boolean;
}) {
  const icon = progress.restricted ? 'info' : progress.tone === 'confirmed' ? 'check' : progress.tone === 'notice' ? 'clock' : 'alert';
  return (
    <div className="app-ticket-receipt">
      <div className="app-ticket-result" data-tone={progress.tone} role="status">
        <span className="app-ticket-result-icon">
          {progress.tone === 'pending' || busy ? <Spinner /> : <AppIcon name={icon} size={22} />}
        </span>
        <strong>{progress.title}</strong>
        {progress.amount && <span className="app-ticket-receipt-amount">{progress.amount}</span>}
        {progress.detail && <p>{progress.detail}</p>}
      </div>
      {fund}
      {progress.hash && explorerUrl && (
        <a className="app-ticket-explorer" href={`${explorerUrl}/tx/${progress.hash}`} target="_blank" rel="noreferrer">
          View transaction <AppIcon name="external" size={16} />
        </a>
      )}
      {!busy && (
        <div className="app-sheet-actions app-sheet-actions-stacked">
          {progress.restricted ? (
            <>
              <button type="button" className="btn primary" onClick={onDone}>Done</button>
              <button type="button" className="btn ghost" onClick={onBack}><AppIcon name="left" size={16} /> Back to amount</button>
            </>
          ) : progress.tone === 'error' && !progress.hash ? (
            <button type="button" className="btn primary" onClick={onBack}><AppIcon name="left" size={16} /> Back to amount</button>
          ) : (
            <>
              <Link to="/portfolios" className="btn primary" onClick={onViewPortfolio}>View portfolio <AppIcon name="right" size={16} /></Link>
              <button type="button" className="btn ghost" onClick={onDone}>Done</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
