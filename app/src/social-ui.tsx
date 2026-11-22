import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useApp } from './app-context';
import { timeAgo } from './format';
import { useMounted } from './hooks';
import { COMMENT_MAX, guestName, type Comment, type EventSocial } from './lib/social';
import { codeOf, messageFor } from './messages';
import { color, font } from './theme';
import { Btn, Ic, T } from './ui';

const NONE: EventSocial = { likes: 0, comments: 0, liked: false };

/** Likes and comment counts for the events on screen. Empty (and nothing is drawn) when this build has no social backend. */
export function useSocialFeed(eventIds: string[]) {
  const app = useApp();
  const [feed, setFeed] = useState<Record<string, EventSocial>>({});
  const key = eventIds.join(',');
  useEffect(() => {
    if (!app.social || !key) return;
    let live = true;
    app.social.feed(key.split(',')).then((f) => { if (live) setFeed(f); }).catch(() => { /* counts are decoration: the feed works without them */ });
    return () => { live = false; };
  }, [app.social, key, app.refreshKey]);
  const set = useCallback((eventId: string, s: EventSocial) => setFeed((f) => ({ ...f, [eventId]: s })), []);
  return { on: !!app.social, of: (eventId: string) => feed[eventId] ?? NONE, set };
}

/** Heart with a count. The like is signed on the device and sent to the relayer; it is not on any chain. */
export function LikeButton({ eventId, state, onChange }: { eventId: string; state: EventSocial; onChange: (s: EventSocial) => void }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  async function toggle() {
    if (!app.social || busy) return;
    const next = !state.liked;
    setBusy(true);
    onChange({ ...state, liked: next, likes: Math.max(0, state.likes + (next ? 1 : -1)) });
    try {
      const s = await app.social.like(eventId, next);
      if (mounted.current) onChange(s);
    } catch {
      if (mounted.current) onChange(state);
    } finally { if (mounted.current) setBusy(false); }
  }
  return (
    <Pressable testID={`like-${eventId}`} accessibilityRole="button" accessibilityLabel={state.liked ? 'Bỏ thích' : 'Thích'} accessibilityState={{ selected: state.liked }} onPress={toggle}
      style={{ minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {/* Liked: the same heart, filled. */}
      <Ic name="heart" size={20} tint={state.liked ? color.orange : color.muted} fill={state.liked ? color.orange : undefined} />
      <T testID={`likes-${eventId}`} style={{ fontFamily: font.bold, fontSize: 14, color: state.liked ? color.ink : color.muted }}>{state.likes}</T>
    </Pressable>
  );
}

export function CommentCount({ eventId, count, onPress }: { eventId: string; count: number; onPress: () => void }) {
  return (
    <Pressable testID={`comments-${eventId}`} accessibilityRole="button" accessibilityLabel={`${count} bình luận`} onPress={onPress} style={{ minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Ic name="speech" size={18} />
      <T style={{ fontFamily: font.bold, fontSize: 14, color: color.muted }}>{count}</T>
    </Pressable>
  );
}


/** The comment thread of one event: a box to write in, then the newest comments first. */
export function Comments({ eventId, onCount }: { eventId: string; onCount?: (n: number) => void }) {
  const app = useApp();
  const mounted = useMounted();
  const [list, setList] = useState<Comment[] | null>(null);
  const [canComment, setCanComment] = useState(false);
  const [down, setDown] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!app.social) return;
    app.social.comments(eventId).then((r) => { if (mounted.current) { setList(r.comments); setCanComment(r.canComment); setDown(false); } }).catch(() => { if (mounted.current) setDown(true); });
  }, [app.social, eventId, mounted, app.refreshKey]);
  useEffect(load, [load]);
  if (!app.social) return null;

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true); setFailure(null);
    try {
      const c = await app.social!.comment(eventId, text);
      if (!mounted.current) return;
      const next = [c, ...(list ?? []).filter((x) => x.id !== c.id)];
      setList(next); setText(''); onCount?.(next.length);
    } catch (e) {
      if (mounted.current) setFailure(messageFor(codeOf(e)));
    } finally { if (mounted.current) setBusy(false); }
  }

  const now = Math.floor(Date.now() / 1000);
  return (
    <View testID="comments" style={{ gap: 12, marginTop: 4 }}>
      <T style={{ fontFamily: font.display, fontSize: 20, lineHeight: 24, letterSpacing: -0.5 }}>Bình luận{list?.length ? ` · ${list.length}` : ''}</T>
      {list && !canComment ? (
        <View testID="comment-rule" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: color.paper }}>
          <Ic name="ticket" size={18} />
          <T style={{ flex: 1, fontFamily: font.semibold, fontSize: 14 }}>Chỉ người có vé mới bình luận được</T>
        </View>
      ) : null}
      {canComment ? <View style={{ gap: 8 }}>
        <TextInput testID="comment-input" accessibilityLabel="Viết bình luận" value={text} onChangeText={(v) => setText(v.slice(0, COMMENT_MAX))} placeholder="Viết bình luận…" placeholderTextColor={color.muted} multiline maxLength={COMMENT_MAX}
          style={{ minHeight: 52, maxHeight: 120, paddingHorizontal: 12, paddingVertical: 12, fontFamily: font.body, fontSize: 15, lineHeight: 22, color: color.ink, backgroundColor: color.paper }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <T style={{ flex: 1, fontSize: 12, lineHeight: 16, color: failure ? color.orange : color.muted }} testID={failure ? 'comment-error' : undefined}>{failure ?? `${text.length}/${COMMENT_MAX}`}</T>
          <View style={{ width: 96 }}><Btn testID="comment-send" label="Gửi" kind="dark" busy={busy} disabled={!text.trim()} onPress={send} /></View>
        </View>
      </View> : null}
      {down && !list ? <View style={{ gap: 8 }}><T testID="comments-down" style={{ color: color.muted }}>Không tải được bình luận.</T><Btn label="Thử lại" kind="secondary" onPress={load} /></View> : null}
      {list && list.length === 0 ? <T testID="comments-empty" style={{ color: color.muted }}>Chưa có bình luận</T> : null}
      {list?.map((c) => (
        <View key={c.id} testID={`comment-${c.id}`} style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper }}><Ic name="user" size={18} tint={color.muted} /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <T style={{ fontSize: 13, lineHeight: 18 }}><T style={{ fontFamily: font.bold, fontSize: 13 }}>{c.author.toLowerCase() === app.wallet.address.toLowerCase() ? 'Bạn' : guestName(c.author)}</T><T style={{ fontSize: 13, color: color.muted }}> · {timeAgo(c.at, now)}</T></T>
            <T>{c.text}</T>
          </View>
        </View>
      ))}
    </View>
  );
}
