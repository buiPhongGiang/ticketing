import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { payOn } from '../config';
import { agoVi, CapBadge, Composer, Person, QueueBox, ShareBtn, viMessage, whenVi } from '../exchange-ui';
import { formatVnd } from '../format';
import { useLoad, useMounted } from '../hooks';
import { NOTE_MAX, noteFits, type ListingNote } from '../lib/exchange';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Row, Screen, T } from '../ui';

/** One resale listing: the price against the cap, who sells it and what they say, and the way to buy it or wait for the next. */
export function ListingScreen({ tokenId }: { tokenId: string }) {
  const app = useApp();
  const mounted = useMounted();
  const { data: t, error } = useLoad(() => app.service.getTicket(tokenId), [tokenId]);
  const { data: ev } = useLoad(() => (t ? app.service.getEvent(t.eventId) : Promise.resolve(undefined)), [t?.eventId]);
  const { data: waitlist, reload: reloadQueue } = useLoad(() => (t ? app.service.getWaitlist(t.eventId) : Promise.resolve(undefined)), [t?.eventId]);
  const { data: listings } = useLoad(() => (t ? app.service.getListings(t.eventId) : Promise.resolve(undefined)), [t?.eventId]);
  const { data: notes, reload: reloadNote } = useLoad(() => (app.exchange ? app.exchange.notes([tokenId]) : Promise.resolve({} as Record<string, ListingNote>)), [tokenId]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteFailure, setNoteFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const title = `Vé #${tokenId}`;

  // The note counts only while the chain shows its author holding this ticket at this price.
  const note = t && noteFits(notes?.[tokenId], t.owner, t.listPrice) ? notes![tokenId] : undefined;
  useEffect(() => { if (draft === null && notes) setDraft(note?.text ?? ''); }, [notes, note, draft]);

  if (error && !t) return <Screen title={title} back nav="market"><T testID="listing-error">{viMessage(error)}</T></Screen>;
  if (!t || !ev) return <Screen title={title} back nav="market"><Center /></Screen>;

  const mine = t.owner.toLowerCase() === app.wallet.address.toLowerCase();
  const open = t.listPrice !== '0' && ev.status === 'onsale';
  const waiting = ev.waiting[t.tier] ?? 0;
  const tierOpen = (listings ?? []).filter((l) => l.tier === t.tier).length;

  async function buy() {
    if (payOn) { app.go({ name: 'pay', order: { kind: 'resale', tokenId, eventId: t!.eventId, units: t!.listPrice, title: `Vé bán lại #${tokenId} · ${ev!.name}` } }); return; }
    setBusy(true); setFailure(null);
    try {
      const entry = await app.service.buyListing(tokenId, t!.listPrice);
      if (mounted.current) app.go({ name: 'tx', entryId: entry.id });
    } catch (e) {
      if (mounted.current) setFailure(viMessage(e));
    } finally { if (mounted.current) setBusy(false); }
  }
  async function saveNote() {
    if (!app.exchange || draft === null) return;
    setSaving(true); setNoteFailure(null); setSaved(false);
    try {
      await app.exchange.setNote(tokenId, t!.listPrice, draft);
      if (mounted.current) { setSaved(true); reloadNote(); }
    } catch (e) {
      if (mounted.current) setNoteFailure(viMessage(e));
    } finally { if (mounted.current) setSaving(false); }
  }

  const footer = open && !mine ? <>
    {failure ? <T testID="listing-buy-error" style={{ fontFamily: font.semibold, color: color.orange }}>{failure}</T> : null}
    {waiting > 0
      ? <T testID="listing-queue-first" style={{ fontFamily: font.medium }}>Đang có {waiting} người xếp hàng cho hạng {t.tierName}: vé này về người đứng đầu hàng.</T>
      : <Btn testID="listing-buy" label={`Mua ngay · ${formatVnd(t.listPrice)}`} busy={busy} onPress={buy} />}
  </> : open && mine ? <Btn testID="listing-manage" label="Đổi giá hoặc gỡ bán" kind="secondary" onPress={() => app.go({ name: 'ticket', tokenId })} /> : undefined;

  return (
    <Screen title={title} back nav="market" footer={footer}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, backgroundColor: color.paper }}>
        <Image source={eventPhoto(ev.id)} style={{ width: 64, height: 64 }} />
        <View style={{ flex: 1 }}>
          <T testID="listing-event" lines={1} style={{ fontFamily: font.bold }}>{ev.name}</T>
          <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{whenVi(ev.startsAt, ev.endsAt)} · {ev.venue}</T>
          <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Hạng {t.tierName}</T>
        </View>
      </View>

      {open ? <>
        <View style={{ gap: 6 }}>
          <T style={{ color: color.muted }}>Giá bán</T>
          <Display size={40} testID="listing-price">{formatVnd(t.listPrice)}</Display>
          <CapBadge price={t.listPrice} face={t.face} cap={t.cap} testID="listing-cap" />
        </View>
        <View>
          <Row label="Giá gốc" value={formatVnd(t.face)} testID="listing-face" />
          <Row label="Trần bán lại (giá gốc +10%)" value={formatVnd(t.cap)} testID="listing-ceiling" />
        </View>
        <T testID="listing-rule" style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Trần giá nằm trong sổ vé, người bán không vượt được. Người bán cũng không chọn người mua: ai trả tiền trước thì vé về người đó. Nếu show huỷ, tiền hoàn là giá gốc.</T>
      </> : (
        <View testID="listing-closed" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: color.paper }}>
          <Ic name="ticket" size={22} />
          <View style={{ flex: 1 }}>
            <T style={{ fontFamily: font.bold }}>{ev.status !== 'onsale' ? 'Sự kiện không còn mở bán' : 'Vé này không còn rao bán'}</T>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{ev.status !== 'onsale' ? 'Vé bán lại đóng khi sự kiện kết thúc hoặc bị huỷ.' : 'Đã có người mua, hoặc người bán đã gỡ.'}</T>
          </View>
        </View>
      )}

      <View style={{ gap: 8 }}>
        <T style={{ fontFamily: font.display, fontSize: 18, lineHeight: 22 }}>{open ? 'Người bán' : 'Người giữ vé'}</T>
        <Person account={t.owner} sub={note ? `Đăng ${agoVi(note.posted).toLowerCase()}` : undefined} onPress={() => app.go({ name: 'user', account: t.owner })} />
        {open && note?.text && !mine ? <View style={{ padding: 12, backgroundColor: color.paper }}><T testID="listing-note">{note.text}</T></View> : null}
        {open && !mine && !note?.text ? <T testID="listing-no-note" style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Người bán không để lại ghi chú.</T> : null}
      </View>

      {open && mine && app.exchange && draft !== null ? (
        <View testID="listing-note-editor" style={{ gap: 8 }}>
          <T style={{ fontFamily: font.display, fontSize: 18, lineHeight: 22 }}>Ghi chú cho người mua</T>
          <Composer testID="note" value={draft} onChange={(v) => { setDraft(v); setSaved(false); }} max={NOTE_MAX} placeholder="Ví dụ: bận đột xuất, vé khu A gần sân khấu" label="Lưu" busy={saving} failure={noteFailure} onSend={saveNote} allowEmpty />
          <T testID={saved ? 'note-saved' : undefined} style={{ fontSize: 12, lineHeight: 16, color: saved ? color.green : color.muted }}>{saved ? 'Đã lưu. Ghi chú hiện trên chợ vé.' : 'Ghi chú là lời của bạn, hiện công khai trên chợ vé. Giá và vé thì do sổ vé giữ.'}</T>
        </View>
      ) : null}

      {ev.status === 'onsale' && !mine && (!open || waiting > 0) ? <QueueBox event={ev} tier={t.tier} state={waitlist?.[t.tier]} open={tierOpen} onChanged={reloadQueue} /> : null}

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <ShareBtn target={{ kind: 'listing', id: tokenId }} text={`Vé ${t.tierName} · ${ev.name}${open ? ` · ${formatVnd(t.listPrice)}` : ''}`} />
        <View style={{ flex: 1 }}><Btn testID="listing-event-link" label="Xem sự kiện" kind="secondary" onPress={() => app.go({ name: 'event', eventId: ev.id })} /></View>
      </View>
    </Screen>
  );
}
