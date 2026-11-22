import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { addressUrl, client, venueClient, type Eip1193 } from './chain';
import { config } from './config';
import { activeGates, deviceKind, readDevices, TX_ALLOW_LIST, type DeviceKind, type L1Device, type L1Role } from './devices';
import { failureText } from './errors';
import { eventDate, short } from './format';
import { OUTCOME_LABEL, readDoorLog, readOutcome, relayAbi, type DoorLog, type OutcomeState } from './l1';
import { Confirm, Empty, HashLink, Metric, Skeleton, TxLine, useTx } from './ui';
import { readVenueDoor, venueProgress, type VenueDoor } from './venue';

/**
 * Where the door PIN lives. The console has no access to it and never shows it: the relayer holds it in its own
 * environment and checks it on every gate request.
 */
export function PinHint() {
  return (
    <section className="panel" data-testid="pin-hint">
      <div className="panel-head"><h2 className="display">Mã PIN ở cửa</h2><span className="tag mono">Không hiển thị ở đây</span></div>
      <p className="panel-note">Nhân viên mở màn soát vé trong ứng dụng khách bằng một mã PIN. Relayer kiểm PIN rồi mới gửi lượt soát vé lên chuỗi, nên không có khoá ví nào nằm trong trình duyệt của nhân viên.</p>
      <dl className="facts">
        <div><dt>Đặt ở đâu</dt><dd>Biến <code>GATE_PIN</code> trong file môi trường của relayer (<code>app/scripts/relayer.ts</code>). Để trống thì relayer tắt hẳn cửa soát vé.</dd></div>
        <div><dt>Đổi mã</dt><dd>Sửa <code>GATE_PIN</code> rồi khởi động lại relayer. Mã cũ hết hiệu lực ngay, nhân viên nhập lại mã mới.</dd></div>
        <div><dt>Nhập sai</dt><dd>Mặc định 5 lần sai trong 15 phút thì địa chỉ IP đó bị khoá tạm, quá 50 lần sai trong một giờ thì cửa ngừng trả lời (<code>GATE_PIN_FAILS_PER_IP</code>, <code>GATE_PIN_FAILS_PER_HOUR</code>).</dd></div>
      </dl>
      <p className="readonly-note">Relayer không trả mã PIN cho bất kỳ trang nào, nên trang này không có gì để hiển thị. Ban tổ chức đưa mã cho nhân viên qua kênh riêng.</p>
    </section>
  );
}

const ROLE_LABEL: Record<L1Role, string> = { none: 'Không được gửi giao dịch', enabled: 'Được gửi giao dịch', admin: 'Quản trị danh sách', manager: 'Quản lý danh sách' };
const KIND_LABEL: Record<DeviceKind, string> = {
  gate: 'Thiết bị soát vé', 'gate-blocked': 'Thiết bị soát vé, L1 đang chặn', venue: 'Ban tổ chức, chủ GateLog', admin: 'Quản trị', sender: 'Không soát vé', removed: 'Đã gỡ',
};

/**
 * Who the venue L1 lets send transactions (its TxAllowList precompile) and which of them GateLog accepts as gate
 * devices. Read from the L1's public RPC; nothing is ever sent there from this console.
 */
export function GateDevicesPanel({ refreshKey }: { refreshKey?: unknown }) {
  const gateLog = config.gateLog;
  const [devices, setDevices] = useState<L1Device[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!venueClient || !gateLog) return;
    let live = true;
    readDevices(venueClient, gateLog, config.venueAllowSeed)
      .then((d) => { if (live) { setDevices(d); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [gateLog, refreshKey]);
  if (!venueClient || !gateLog) return null;
  return (
    <section className="panel" data-testid="gate-devices">
      <div className="panel-head">
        <h2 className="display">Thiết bị được phép trên L1 {config.venueChain}</h2>
        <span className="tag mono" title={`TxAllowList ${TX_ALLOW_LIST}`}>TxAllowList</span>
      </div>
      <p className="panel-note">Chuỗi {config.venueChain} chỉ nhận giao dịch từ các ví trong danh sách này; ví lạ bị nút mạng từ chối trước khi tới hợp đồng. Trong số đó, GateLog chỉ nhận lượt soát vé từ thiết bị soát vé.</p>
      {error && !devices ? <p className="alert" role="alert" data-testid="devices-error">Không đọc được RPC của {config.venueChain}.</p> : !devices ? <><Skeleton h={44} /><Skeleton h={44} /></> : (
        <>
          <p className="mono small muted" data-testid="devices-count">{activeGates(devices)} thiết bị soát vé đang được phép · {devices.filter((d) => d.role !== 'none').length} ví gửi được giao dịch</p>
          <ul className="staff devices">{devices.map((d) => {
            const kind = deviceKind(d);
            return (
              <li key={d.address} data-testid={`device-${d.address.toLowerCase()}`} className={kind === 'removed' || kind === 'gate-blocked' ? 'off' : ''}>
                <span className="device-who">
                  <span className="mono" title={d.address}>{d.address}</span>
                  <span className="small muted">{ROLE_LABEL[d.role]}{d.gate ? ' · GateLog nhận lượt soát vé' : ''}</span>
                </span>
                <span className={`pill ${kind === 'gate' ? 'p-checked' : kind === 'removed' || kind === 'gate-blocked' ? 'p-refunded' : 'p-listed'}`}>{KIND_LABEL[kind]}</span>
              </li>
            );
          })}</ul>
          <p className="readonly-note">Thêm hoặc gỡ thiết bị là giao dịch của ví quản trị ngay trên {config.venueChain} (<code>setEnabled</code>, <code>setNone</code> trên TxAllowList và <code>setGate</code> trên GateLog), chạy bằng <code>scripts/vegoc-allowlist.mjs</code>. Trang này chỉ đọc.</p>
        </>
      )}
    </section>
  );
}

/** Door scans recorded on the venue's own L1 and counted on this chain by VenueCheckIns (ICM). */
export function VenueDoorPanel({ eventId, refreshKey }: { eventId: number; refreshKey?: unknown }) {
  const address = config.venueCheckIns;
  const [door, setDoor] = useState<VenueDoor | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    readVenueDoor(client, address, eventId, config.venueFromBlock, config.logChunk)
      .then((d) => { if (live) { setDoor(d); setError(null); } })
      .catch((e) => { if (live) setError(failureText(e)); });
    return () => { live = false; };
  }, [address, eventId, refreshKey]);
  if (!address) return null;

  const progress = door ? venueProgress(door) : null;
  const url = addressUrl(address);
  return (
    <section className="panel venue-door" data-testid="venue-door">
      <div className="panel-head">
        <h2 className="display">Lượt soát vé từ L1 gửi về</h2>
        <span className="tag mono" title="Thiết bị ở cửa ghi lượt soát vé trên L1 riêng của địa điểm, rồi gửi sang chuỗi này qua ICM (Teleporter)">L1 {config.venueChain} → ICM</span>
      </div>
      {error && !door ? <p className="alert" role="alert">{error}</p> : !door ? <><Skeleton h={44} /><Skeleton /></> : (
        <>
          <div className="metrics four">
            <Metric label="Được tính" id="venue-accepted" value={door.accepted} sub={`${door.paidAccepted} vé trả tiền`} />
            <Metric label="Bị loại" id="venue-rejected" value={door.rejected} sub="Không khớp với VeGoc" />
            <Metric label="So với một nửa" id="venue-quorum" value={`${door.venuePaid}/${door.paidSold}`} sub={door.met ? 'Đã đủ' : door.paidSold ? `Thiếu ${progress!.missing} lượt` : 'Chưa bán vé trả tiền'} />
            <Metric label={`Soát trên ${config.network}`} id="venue-own" value={door.veGocPaid} sub="Vé trả tiền, soát thẳng trên VeGoc" />
          </div>
          <div className={`meter venue-meter ${door.met ? 'met' : ''}`} aria-hidden="true"><i style={{ width: `${progress!.pct}%` }} /></div>
          {door.batches.length === 0 ? <Empty id="venue-none">Chưa có đợt nào từ L1 gửi về</Empty> : (
            <ul className="staff venue-batches">{door.batches.map((b) => (
              <li key={b.tx} data-testid={`venue-batch-${b.batch}`}>
                <span className="mono">Đợt {b.batch} · {b.accepted} lượt được tính{b.rejected ? ` · ${b.rejected} bị loại` : ''}</span>
                <HashLink hash={b.tx} />
              </li>
            ))}</ul>
          )}
          {url ? <a className="mono small muted venue-contract" href={url} target="_blank" rel="noreferrer">VenueCheckIns {address.slice(0, 10)}…</a> : null}
        </>
      )}
      <DoorLogBlock eventId={eventId} refreshKey={refreshKey} />
    </section>
  );
}

const SCANS_SHOWN = 8;

/** The same door, read on the L1 itself: what the gate devices wrote to GateLog and how much of it was sent on. */
function DoorLogBlock({ eventId, refreshKey }: { eventId: number; refreshKey?: unknown }) {
  const gateLog = config.gateLog;
  const [log, setLog] = useState<DoorLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!venueClient || !gateLog) return;
    let live = true;
    readDoorLog(venueClient, gateLog, eventId)
      .then((d) => { if (live) { setLog(d); setError(null); } })
      .catch(() => { if (live) setError(`Không đọc được RPC của ${config.venueChain}.`); });
    return () => { live = false; };
  }, [gateLog, eventId, refreshKey]);
  if (!venueClient || !gateLog) return null;
  const shown = log ? (all ? log.scans : log.scans.slice(0, SCANS_SHOWN)) : [];
  return (
    <div className="l1-block" data-testid="door-log">
      <div className="panel-head">
        <h3 className="display l1-title">Ghi ngay trên {config.venueChain}</h3>
        <span className="mono small muted" title={`GateLog ${gateLog}`}>GateLog {short(gateLog)}</span>
      </div>
      {error && !log ? <p className="alert" role="alert" data-testid="door-log-error">{error}</p> : !log ? <Skeleton h={44} /> : (
        <>
          <div className="metrics three">
            <Metric label="Lượt đã ghi" id="l1-scans" value={log.scans.length} />
            <Metric label={`Đã gửi sang ${config.network}`} id="l1-sent" value={log.sent} sub={`${log.batches} đợt`} />
            <Metric label="Chưa gửi" id="l1-waiting" value={log.waiting} sub={log.waiting ? 'Thiết bị gửi kèm ở đợt kế tiếp' : undefined} />
          </div>
          {log.scans.length === 0 ? <Empty id="l1-none">Chưa có lượt soát vé nào của sự kiện này trên {config.venueChain}</Empty> : (
            <ul className="staff l1-scans">{shown.map((s) => (
              <li key={s.tokenId} data-testid={`l1-scan-${s.tokenId}`}>
                <span className="mono"><b>#{s.tokenId}</b> · {short(s.holder)}</span>
                <span className="mono small muted">{eventDate(s.at)}</span>
              </li>
            ))}</ul>
          )}
          {log.scans.length > SCANS_SHOWN && !all ? <button className="btn ghost sm" onClick={() => setAll(true)}>Xem thêm {log.scans.length - SCANS_SHOWN} lượt</button> : null}
        </>
      )}
    </div>
  );
}

const STAGE_LABEL: Record<OutcomeState['stage'], string> = { running: 'Chưa tới lúc', ready: 'Chưa gửi', sent: 'Đang trên đường', delivered: 'Đã tới nơi' };

/**
 * How the event ended, as a contract on the venue L1 can read it: AttendanceRelay sends the outcome from this chain
 * over ICM, AttendanceMirror on the L1 stores it. Anyone may send it once the outcome is final.
 */
export function OutcomePanel({ eventId, refreshKey, provider, account, readOnly, onDone }: { eventId: number; refreshKey?: unknown; provider: Eip1193; account: Address; readOnly: boolean; onDone: () => void }) {
  const { attendanceRelay: relay, mirror } = config;
  const [state, setState] = useState<OutcomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const tx = useTx({ provider, account, onDone });
  const txStage = tx.state.stage;
  useEffect(() => {
    if (!venueClient || !relay || !mirror) return;
    let live = true;
    readOutcome(client, relay, venueClient, mirror, eventId)
      .then((s) => { if (live) { setState(s); setError(null); } })
      .catch(() => { if (live) setError('Không đọc được kết quả từ cả hai chuỗi.'); });
    return () => { live = false; };
  }, [relay, mirror, eventId, refreshKey, txStage]);
  if (!venueClient || !relay || !mirror) return null;

  const numbers = state ? `${state.paidCheckedIn}/${state.paidSold} vé trả tiền đã vào cửa` : '';
  return (
    <section className="panel" data-testid="outcome-panel">
      <div className="panel-head">
        <h2 className="display">Kết quả gửi sang {config.venueChain}</h2>
        <span className="tag mono" title="AttendanceRelay trên chuỗi này gửi kết quả sự kiện sang AttendanceMirror trên L1 của địa điểm qua ICM (Teleporter)">{config.network} → ICM → L1</span>
      </div>
      {error && !state ? <p className="alert" role="alert">{error}</p> : !state ? <Skeleton h={44} /> : (
        <>
          <div className="metrics two">
            <Metric label={state.stage === 'delivered' ? `Đã lưu trên ${config.venueChain}` : 'Kết quả'} id="outcome" value={OUTCOME_LABEL[state.outcome]} sub={state.stage === 'running' ? 'Chốt sau khi kết thúc hoặc huỷ' : numbers} />
            <Metric label="Gửi sang L1" id="outcome-stage" value={STAGE_LABEL[state.stage]}
              sub={state.stage === 'ready' ? 'Ai cũng gửi được, chỉ một lần' : state.stage === 'sent' ? 'Relayer ICM đang chuyển' : state.stage === 'delivered' ? `AttendanceMirror ${short(mirror)}` : undefined} />
          </div>
          {state.messageId ? <p className="mono small muted l1-message" data-testid="outcome-message" title={state.messageId}>Mã tin Teleporter {short(state.messageId)}</p> : null}
          {state.stage === 'ready' && !readOnly ? (
            asking ? (
              <Confirm id="relay" yes="Gửi kết quả" onNo={() => setAsking(false)} onYes={() => { setAsking(false); void tx.run({ address: relay, abi: relayAbi, functionName: 'relay', args: [BigInt(eventId)] }, `Đã gửi kết quả sang ${config.venueChain}`); }}>
                Gửi kết quả <b>{OUTCOME_LABEL[state.outcome]}</b> ({numbers}) sang {config.venueChain}. Chỉ gửi được một lần và không sửa lại được.
              </Confirm>
            ) : <button className="btn" data-testid="relay" disabled={tx.busy} onClick={() => setAsking(true)}>Gửi sang {config.venueChain}</button>
          ) : null}
          <TxLine state={tx.state} />
        </>
      )}
    </section>
  );
}
