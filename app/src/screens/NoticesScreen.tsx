import React, { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { useApp, type Route } from '../app-context';
import type { IconKey } from '../art';
import { config } from '../config';
import { agoVi } from '../exchange-ui';
import { formatVnd } from '../format';
import { useLoad } from '../hooks';
import { loadNotices, noticeKey, saveNotices, type NoticeItem } from '../lib/notices';
import { setUnread } from '../notice-store';
import { color, font } from '../theme';
import { Center, Display, Ic, Screen, T } from '../ui';

const icon: Record<NoticeItem['kind'], IconKey> = { sold: 'money', arrived: 'ticket', refund: 'shield' };

/** What a notice says, and where tapping it goes. */
export function noticeText(n: NoticeItem, eventName?: string): { title: string; body: string; route: Route } {
  const at = eventName ? ` · ${eventName}` : '';
  const route: Route = { name: 'ticket', tokenId: n.tokenId ?? '0' };
  if (n.kind === 'sold') return { title: `Vé #${n.tokenId} đã bán${n.amount ? ` · ${formatVnd(n.amount)}` : ''}`, body: `Vé đã chuyển sang người mua${at}.`, route };
  if (n.kind === 'arrived') return { title: `Đến lượt bạn: vé #${n.tokenId} đã về`, body: `Bạn đứng đầu hàng chờ nên vé vừa được rao đã thuộc về bạn${at}.`, route };
  return { title: `Vé #${n.tokenId} được hoàn tiền${n.amount ? ` · ${formatVnd(n.amount)}` : ''}`, body: `Sự kiện bị huỷ hoặc không đủ người vào cổng${at}. Mở vé để nhận lại tiền.`, route };
}

/** The list the watcher fills from changes on chain. Opening it marks everything read. */
export function NoticesScreen() {
  const app = useApp();
  const key = noticeKey(config.chainId, config.contract, app.wallet.address);
  const { data: state } = useLoad(() => loadNotices(app.store, key), [key]);
  const { data: events } = useLoad(() => app.service.getEvents(), []);
  useEffect(() => {
    if (!state?.items.some((i) => !i.read)) return;
    // Read once they have been on screen; the rows keep their highlight until the screen is opened again.
    saveNotices(app.store, key, { ...state, items: state.items.map((i) => ({ ...i, read: true })) }).then(() => setUnread(0)).catch(() => {});
  }, [state, app.store, key]);
  return (
    <Screen title="Thông báo" back nav="me">
      {!state ? <Center /> : null}
      {state?.items.map((n) => {
        const text = noticeText(n, events?.find((e) => e.id === n.eventId)?.name);
        return (
          <Pressable key={n.id} testID={`notice-${n.kind}-${n.tokenId}`} accessibilityRole="button" onPress={() => app.go(text.route)}
            style={{ flexDirection: 'row', gap: 12, padding: 14, backgroundColor: n.read ? color.paper : color.amberSoft }}>
            <Ic name={icon[n.kind]} size={22} />
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontFamily: font.bold }}>{text.title}</T>
              <T style={{ fontSize: 14, lineHeight: 20 }}>{text.body}</T>
              <T style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{agoVi(Math.floor(n.at / 1000))}</T>
            </View>
          </Pressable>
        );
      })}
      {state && state.items.length === 0 ? (
        <Center>
          <Ic name="bell" size={40} tint={color.muted} />
          <Display testID="notices-empty" size={22} style={{ textAlign: 'center' }}>Chưa có thông báo</Display>
          <T style={{ textAlign: 'center', color: color.muted }}>Bạn sẽ thấy ở đây khi vé bạn rao được mua, khi đến lượt bạn trong hàng chờ, hoặc khi một show bị huỷ và có tiền hoàn.</T>
        </Center>
      ) : null}
    </Screen>
  );
}
