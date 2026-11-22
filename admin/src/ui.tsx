import { createElement, useCallback, useState, type ReactNode } from 'react';
import { iconData, type IconName } from '../../app/src/icon-data';
import type { Address, Hex, TransactionReceipt } from 'viem';
import { isOpenCall, sendBox, sendViaSafe, txUrl, type BoxWrite, type Eip1193, type OpenCall } from './chain';
import type { SafeInfo } from './safe';
import { failureText } from './errors';
import { shortHash } from './format';
import type { EventStatus } from './model';
import type { ChainData } from './useData';

/**
 * One outline icon (Lucide, the family the guest app uses too; data in app/src/icon-data.ts). It takes the colour
 * of the text around it and is hidden from screen readers: the words next to it carry the meaning.
 */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {iconData[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export const Perforation = ({ tone }: { tone?: 'ink' | 'panel' }) => <div className={`perforation ${tone ?? ''}`} aria-hidden="true"><i /><span /><i /></div>;

const BADGE: Record<EventStatus, string> = { live: 'Đang bán', ended: 'Đã kết thúc', noshow: 'Thiếu lượt vào cửa', cancelled: 'Đã huỷ', settled: 'Đã quyết toán' };
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
  const run = useCallback(async (call: BoxWrite | OpenCall, doneText: string | ((r: TransactionReceipt) => string), after?: (r: TransactionReceipt) => void, words?: Record<string, string>) => {
    const viaSafe = safe && !isOpenCall(call) ? safe : undefined;
    setState({ stage: 'confirm', note: viaSafe ? `Safe ${viaSafe.threshold}/${viaSafe.owners.length}` : undefined });
    try {
      const onHash = (hash: Hex) => setState({ stage: 'pending', hash });
      if (viaSafe && !isOpenCall(call)) {
        const { receipt, outcome } = await sendViaSafe(provider, account, viaSafe, call, onHash);
        if (outcome.kind === 'approved') {
          setState({ stage: 'done', hash: receipt.transactionHash, text: `Đã ký ${outcome.have}/${outcome.threshold} · một chủ Safe khác làm lại thao tác này để thực hiện` });
          onDone();
          return null;
        }
        setState({ stage: 'done', hash: receipt.transactionHash, text: `${typeof doneText === 'string' ? doneText : doneText(receipt)} · Safe đã thực hiện` });
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
      setState({ stage: 'failed', reason: failureText(e, words) });
      return null;
    }
  }, [provider, account, onDone, safe]);
  const busy = state.stage === 'confirm' || state.stage === 'pending';
  return { state, setState, run, busy, reset: () => setState({ stage: 'idle' }) };
}

export function TxLine({ state }: { state: TxState }) {
  if (state.stage === 'idle') return null;
  if (state.stage === 'confirm') return <p className="tx tx-wait" data-testid="tx-confirm" role="status"><span className="spin" />Xác nhận trong ví{state.note ? ` · ${state.note}` : ''}</p>;
  if (state.stage === 'pending') return <p className="tx tx-wait" data-testid="tx-pending" role="status"><span className="spin" />Đã gửi, đang chờ mạng xác nhận{state.note ? ` · ${state.note}` : ''}<HashLink hash={state.hash} /></p>;
  if (state.stage === 'done') return <p className="tx tx-done" data-testid="tx-done" role="status"><Icon name="check" size={16} />{state.text}{state.hash ? <HashLink hash={state.hash} /> : null}</p>;
  return <p className="tx tx-failed" data-testid="tx-failed" role="alert"><Icon name="x" size={16} />{state.reason}</p>;
}

/** A second, explicit step before an action that moves money or cannot be undone. */
export function Confirm({ id, children, yes, onYes, onNo, danger }: { id: string; children: ReactNode; yes: string; onYes: () => void; onNo: () => void; danger?: boolean }) {
  return (
    <div className={danger ? 'confirm danger' : 'confirm'} data-testid={`${id}-confirm`} role="alertdialog">
      <div className="confirm-body">{children}</div>
      <div className="row">
        <button className={danger ? 'btn danger-fill' : 'btn'} data-testid={`${id}-yes`} onClick={onYes}>{yes}</button>
        <button className="btn ghost" data-testid={`${id}-no`} onClick={onNo}>Quay lại</button>
      </div>
    </div>
  );
}

export function StaleBanner({ data }: { data: ChainData }) {
  if (!data.error) return null;
  const at = data.snapshot ? new Date(data.snapshot.readAt).toLocaleTimeString('vi-VN', { hour12: false }) : null;
  return (
    <div className="stale" data-testid="stale" role="alert">
      <span>{at ? `Không kết nối được mạng · số liệu lúc ${at}` : 'Không kết nối được mạng'}</span>
      <button className="btn ghost sm" data-testid="refresh" onClick={() => void data.refresh()}>Thử lại</button>
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
