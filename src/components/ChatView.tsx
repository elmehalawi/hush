import React, {useRef, useEffect, useMemo} from 'react';
import {View, ScrollView, Text, StyleSheet, Image} from 'react-native';
import {Message, Attachment, Channel, useSignalStore} from '../store/signalStore';
import {MessageBubble} from './MessageBubble';
import {GlassView} from './GlassView';
import {GradientBlurView} from './GradientBlurView';
import {useColors} from '../theme/colors';

function formatTimeSeparator(timestamp: number, previousTimestamp: number | null): {datePart: string | null; time: string} {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const time = date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});

  const previousDate = previousTimestamp ? new Date(previousTimestamp) : null;
  const previousDay = previousDate
    ? new Date(previousDate.getFullYear(), previousDate.getMonth(), previousDate.getDate())
    : null;
  const sameDay = previousDay && messageDay.getTime() === previousDay.getTime();

  if (sameDay) {
    return {datePart: null, time};
  }

  if (messageDay.getTime() === today.getTime()) {
    return {datePart: 'Today', time};
  } else if (messageDay.getTime() === yesterday.getTime()) {
    return {datePart: 'Yesterday', time};
  } else {
    const diffDays = Math.floor((today.getTime() - messageDay.getTime()) / 86400000);
    if (diffDays < 7) {
      return {datePart: date.toLocaleDateString([], {weekday: 'long'}), time};
    }
    return {datePart: date.toLocaleDateString([], {month: 'short', day: 'numeric'}), time};
  }
}

interface ChatViewProps {
  channel: Channel | null;
  messages: Message[];
  onReply?: (message: Message) => void;
  onRetryDownload?: (channelId: string, messageId: string, attachmentIndex: number) => void;
}

export function ChatView({channel, messages, onReply, onRetryDownload}: ChatViewProps) {
  const c = useColors();
  const scrollViewRef = useRef<ScrollView>(null);
  const userId = useSignalStore(state => state.userId);

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({animated: false});
  }, [channel?.id, messages.length]);

  // Pre-compute cross-message album groups: consecutive media-only messages
  // from the same sender within 15 minutes are merged into a single album.
  const {crossAlbumMap, hiddenMessages} = useMemo(() => {
    const albumMap = new Map<string, Attachment[]>();
    const hidden = new Set<string>();

    function isMediaOnlyMessage(msg: Message): boolean {
      if (msg.body) return false;
      const hasAudio = msg.attachments.some(a => a.contentType.startsWith('audio/'));
      if (hasAudio) return false;
      const mediaCount = msg.attachments.filter(
        a => a.contentType.startsWith('image/') || a.contentType.startsWith('video/'),
      ).length;
      if (mediaCount === 0) return false;
      // All non-audio attachments must be media (no generic file attachments)
      const nonAudioCount = msg.attachments.filter(a => !a.contentType.startsWith('audio/')).length;
      return mediaCount === nonAudioCount;
    }

    let i = 0;
    while (i < messages.length) {
      const leader = messages[i];
      if (!isMediaOnlyMessage(leader)) {
        i++;
        continue;
      }

      // Try to extend the group from i
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!isMediaOnlyMessage(candidate)) break;
        if (candidate.senderId !== leader.senderId) break;
        if (candidate.isOutgoing !== leader.isOutgoing) break;
        if (candidate.timestamp - messages[j - 1].timestamp > 15 * 60 * 1000) break;
        j++;
      }

      const groupSize = j - i;
      if (groupSize >= 2) {
        // Merge all media attachments into the leader
        const merged: Attachment[] = [];
        for (let k = i; k < j; k++) {
          const msg = messages[k];
          for (const a of msg.attachments) {
            if (a.contentType.startsWith('image/') || a.contentType.startsWith('video/')) {
              merged.push(a);
            }
          }
          if (k > i) {
            hidden.add(msg.id);
          }
        }
        albumMap.set(leader.id, merged);
      }

      i = j;
    }

    return {crossAlbumMap: albumMap, hiddenMessages: hidden};
  }, [messages]);

  if (!channel) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, {color: c.secondaryLabel}]}>Select a conversation to start messaging</Text>
      </View>
    );
  }

  const initial = channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase();

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 ? (
          <View style={styles.noMessages}>
            <Text style={[styles.noMessagesText, {color: c.secondaryLabel}]}>No messages yet</Text>
            <Text style={[styles.noMessagesHint, {color: c.tertiaryLabel}]}>Send a message to start the conversation</Text>
          </View>
        ) : (
          (() => {
            let lastReadIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].isOutgoing && messages[i].status === 'read') {
                lastReadIndex = i;
                break;
              }
            }
            return messages.map((message, index) => {
              if (hiddenMessages.has(message.id)) return null;

              // Find effective prev/next by skipping hidden messages
              let prevMessage: Message | null = null;
              for (let pi = index - 1; pi >= 0; pi--) {
                if (!hiddenMessages.has(messages[pi].id)) {
                  prevMessage = messages[pi];
                  break;
                }
              }
              let nextMessage: Message | null = null;
              for (let ni = index + 1; ni < messages.length; ni++) {
                if (!hiddenMessages.has(messages[ni].id)) {
                  nextMessage = messages[ni];
                  break;
                }
              }

              const showTimeSeparator = !prevMessage ||
                (message.timestamp - prevMessage.timestamp) > 15 * 60 * 1000;
              const nextShowsTimeSeparator = nextMessage &&
                (nextMessage.timestamp - message.timestamp) > 15 * 60 * 1000;

              const isFirstInGroup = !prevMessage || prevMessage.senderId !== message.senderId || prevMessage.isOutgoing !== message.isOutgoing || showTimeSeparator;
              const isLastInGroup = !nextMessage || nextMessage.senderId !== message.senderId || nextMessage.isOutgoing !== message.isOutgoing || !!nextShowsTimeSeparator;

              return (
                <React.Fragment key={message.id}>
                  {showTimeSeparator && (() => {
                    const {datePart, time} = formatTimeSeparator(message.timestamp, prevMessage?.timestamp ?? null);
                    return (
                      <View style={styles.timeSeparator}>
                        <Text style={[styles.timeSeparatorText, {color: c.secondaryLabel}]}>
                          {datePart && <Text style={styles.timeSeparatorDate}>{datePart}</Text>}
                          {datePart && ` at `}
                          {time}
                        </Text>
                      </View>
                    );
                  })()}
                  <MessageBubble message={message} isGroup={channel.isGroup} isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} onReply={onReply} userId={userId} onRetryDownload={onRetryDownload} showReadReceipt={index === lastReadIndex} crossAlbumAttachments={crossAlbumMap.get(message.id)} />
                </React.Fragment>
              );
            });
          })()
        )}
      </ScrollView>

      {/* Gradient blur overlay at top - mimics Tahoe Messages */}
      <GradientBlurView style={styles.topBlur} />

      {/* Small glass pill header */}
      <View style={styles.headerPillContainer} pointerEvents="none">
        <View style={styles.headerPillWrapper}>
          <View style={styles.pillAvatar}>
            {channel.avatarPath ? (
              <Image
                source={{uri: `file://${channel.avatarPath}`}}
                style={styles.pillAvatarImage}
              />
            ) : (
              <>
                <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} tintColor="rgba(30, 120, 255, 0.45)" />
                <Text style={styles.pillAvatarText}>{initial}</Text>
              </>
            )}
          </View>
          <View style={styles.headerPill}>
            <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} />
            <Text style={[styles.pillName, {color: c.label}]} numberOfLines={1}>
              {channel.name}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  emptyText: {
    fontSize: 16,
  },
  messages: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  messagesContent: {
    paddingTop: 80,
    paddingBottom: 80,
  },
  topBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 80,
  },
  headerPillContainer: {
    position: 'absolute',
    top: 12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  headerPillWrapper: {
    alignItems: 'center',
  },
  headerPill: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
    marginTop: -6,
  },
  pillAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  pillAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  pillAvatarText: {
    color: 'white',
    fontSize: 17,
    fontWeight: '600',
  },
  pillName: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
  timeSeparator: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  timeSeparatorText: {
    fontSize: 10,
    fontWeight: '400',
  },
  timeSeparatorDate: {
    fontWeight: '600',
  },
  noMessages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  noMessagesText: {
    fontSize: 15,
  },
  noMessagesHint: {
    fontSize: 13,
    marginTop: 4,
  },
});
