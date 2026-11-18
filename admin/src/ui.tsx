import { useCallback, useState, type ReactNode } from 'react';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { sendBox, sendViaSafe, txUrl, type BoxWrite, type Eip1193 } from './chain';
import type { SafeInfo } from './safe';
import { failureText } from './errors';
import { shortHash } from './format';
import type { EventStatus } from './model';
import type { ChainData } from './useData';

export const Perforation = ({ tone }: { tone?: 'ink' | 'panel' }) => <div className={`perforation ${tone ?? ''}`} aria-hidden="true"><i /><span /><i /></div>;

const BADGE: Record<EventStatus, string> = { live: 'Live', ended: 'Ended', noshow: 'No-show', cancelled: 'Cancelled', settled: 'Settled' };
export const Badge = ({ status }: { status: EventStatus }) => <span className={`badge ${status}`} data-testid="status-badge">{BADGE[status]}</span>;

export function Metric({ label, value, id, sub, big }: { label: string; value: ReactNode; id?: string; sub?: ReactNode; big?: boolean }) {
  return (
    <div className={big ? 'metric big' : 'metric'}>
      <span className="label">{label}</span>
      <span className="value" data-testid={id}>{value}</span>
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}

export function HashLink({ hash }: { hash: string }) {
  const url = txUrl(hash);
  return url ? <a className="mono hash" href={url} target="_blank" rel="noreferrer">{shortHash(hash)}</a> : <span className="mono hash">{shortHash(hash)}</span>;
}

export const Empty = ({ children, id }: { children: ReactNode; id?: string }) => <p className="empty" data-testid={id}>{children}</p>;
export const Skeleton = ({ h = 16, w = '100%' }: { h?: number; w?: number | string }) => <span className="skeleton" style={{ height: h, width: w }} />;

// ---------------------------------------------------------------- transactions

export type TxState =
  | { stage: 'idle' }
  | { stage: 'confirm'; note?: string }
  | { stage: 'pending'; hash: Hex; note?: string }
  | { stage: 'done'; hash?: Hex; text: string }
  | { stage: 'failed'; reason: string };

export interface TxContext {
  provider: Eip1193;
  account: Address;
  onDone: () => void;
  /** Set when the event's organizer is a Safe this wallet co-owns: calls then go through the Safe, 2 owners each. */
  safe?: SafeInfo;
}

/**
 * One transaction flow: confirm in wallet → pending with hash → done or failed with a short reason.
 * Through a Safe the first owner's transaction is an approval; `after` only runs once the call was executed.
 */
export function useTx({ provider, account, onDone, safe }: TxContext) {
  const [state, setState] = useState<TxState>({ stage: 'idle' });
  const run = useCallback(async (call: BoxWrite, doneText: string | ((r: TransactionReceipt) => string), after?: (r: TransactionReceipt) => void) => {
    setState({ stage: 'confirm', note: safe ? `Safe ${safe.threshold} of ${safe.owners.length}` : undefined });
    try {
      const onHash = (hash: Hex) => setState({ stage: 'pending', hash });
      if (safe) {
        const { receipt, outcome } = await sendViaSafe(provider, account, safe, call, onHash);
        if (outcome.kind === 'approved') {
          setState({ stage: 'done', hash: receipt.transactionHash, text: `Approved ${outcome.have} of ${outcome.threshold} · another Safe owner repeats this to execute` });
          onDone();
          return null;
        }
        setState({ stage: 'done', hash: receipt.transactionHash, text: `${typeof doneText === 'string' ? doneText : doneText(receipt)} · executed by the Safe` });
        onDone();
        after?.(receipt);
        return receipt;
      }
      const receipt = await sendBox(provider, account, call, onHash);
      setState({ stage: 'done', hash: receipt.transactionHash, text: typeof doneText === 'string' ? doneText : doneText(receipt) });
      onDone();
      after?.(receipt);
      return receipt;
    } catch (e) {
      setState({ stage: 'failed', reason: failureText(e) });
      return null;
    }
  }, [provider, account, onDone, safe]);
  const busy = state.stage === 'confirm' || state.stage === 'pending';
  return { state, setState, run, busy, reset: () => setState({ stage: 'idle' }) };
}

export function TxLine({ state }: { state: TxState }) {
  if (state.stage === 'idle') return null;
  if (state.stage === 'confirm') return <p className="tx tx-wait" data-testid="tx-confirm" role="status"><span className="spin" />Confirm in wallet{state.note ? ` · ${state.note}` : ''}</p>;
  if (state.stage === 'pending') return <p className="tx tx-wait" data-testid="tx-pending" role="status"><span className="spin" />Pending{state.note ? ` · ${state.note}` : ''}<HashLink hash={state.hash} /></p>;
  if (state.stage === 'done') return <p className="tx tx-done" data-testid="tx-done" role="status"><b>✓</b>{state.text}{state.hash ? <HashLink hash={state.hash} /> : null}</p>;
  return <p className="tx tx-failed" data-testid="tx-failed" role="alert"><b>×</b>{state.reason}</p>;
}

/** A second, explicit step before an action that moves money or cannot be undone. */
export function Confirm({ id, children, yes, onYes, onNo, danger }: { id: string; children: ReactNode; yes: string; onYes: () => void; onNo: () => void; danger?: boolean }) {
  return (
    <div className={danger ? 'confirm danger' : 'confirm'} data-testid={`${id}-confirm`} role="alertdialog">
      <div className="confirm-body">{children}</div>
      <div className="row">
        <button className={danger ? 'btn danger-fill' : 'btn'} data-testid={`${id}-yes`} onClick={onYes}>{yes}</button>
        <button className="btn ghost" data-testid={`${id}-no`} onClick={onNo}>Back</button>
      </div>
    </div>
  );
}

export function StaleBanner({ data }: { data: ChainData }) {
  if (!data.error) return null;
  const at = data.snapshot ? new Date(data.snapshot.readAt).toLocaleTimeString('en-GB', { hour12: false }) : null;
  return (
    <div className="stale" data-testid="stale" role="alert">
      <span>{at ? `Cannot reach the network · last update ${at}` : 'Cannot reach the network'}</span>
      <button className="btn ghost sm" data-testid="refresh" onClick={() => void data.refresh()}>Retry</button>
    </div>
  );
}

export function Field({ label, error, children, narrow }: { label: string; error?: string; children: ReactNode; narrow?: boolean }) {
  return (
    <label className={narrow ? 'field narrow' : 'field'}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
