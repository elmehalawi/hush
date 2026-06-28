import React, {useRef, useEffect, useMemo} from 'react';
import {View, ScrollView, Text, StyleSheet, Image, TouchableOpacity} from 'react-native';
import {Message, Attachment, Channel, useSignalStore, channelDisplayName} from '../store/signalStore';
import {MessageBubble} from './MessageBubble';
import {GlassView} from './GlassView';
import {GradientBlurView} from './GradientBlurView';
import {useColors} from '../theme/colors';
import {TypingIndicator} from './TypingIndicator';

function isCallEvent(messageType?: Message['messageType']): boolean {
  return messageType === 'missedAudioCall' || messageType === 'missedVideoCall' ||
    messageType === 'audioCall' || messageType === 'videoCall';
}

function callEventLabel(messageType: Message['messageType']): string {
  switch (messageType) {
    case 'missedVideoCall': return 'Missed video call';
    case 'missedAudioCall': return 'Missed voice call';
    case 'videoCall': return 'Video call';
    case 'audioCall': return 'Voice call';
    default: return '';
  }
}

function CallIcon({color}: {color: string}) {
  // U+1F4DE: telephone receiver
  return (
    <Text style={{fontSize: 10, color, lineHeight: 14}}>{'\uD83D\uDCDE\uFE0E'}</Text>
  );
}

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
  onStartCall?: (channelId: string, isVideo: boolean) => void;
}

const EMPTY_TYPING: {senderId: string; timestamp: number}[] = [];

/**
 * Isolated component that subscribes to typing state independently,
 * so typing events don't trigger a re-render of the entire message list.
 */
function TypingSection({channelId, isGroup, scrollViewRef}: {channelId: string; isGroup: boolean; scrollViewRef: React.RefObject<ScrollView>}) {
  const typingUsers = useSignalStore(state =>
    state.typingUsers[channelId] ?? EMPTY_TYPING,
  );

  // Scroll when typing indicator appears
  useEffect(() => {
    if (typingUsers.length > 0) {
      scrollViewRef.current?.scrollToEnd({animated: true});
    }
  }, [typingUsers.length, scrollViewRef]);

  return (
    <>
      {typingUsers.map(({senderId}) => (
        <TypingIndicator key={senderId} senderId={senderId} isGroup={isGroup} />
      ))}
    </>
  );
}

export function ChatView({channel, messages, onReply, onRetryDownload, onStartCall}: ChatViewProps) {
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

  const displayName = channelDisplayName(channel);
  const initial = channel.isGroup ? '#' : displayName.charAt(0).toUpperCase();

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
                  {isCallEvent(message.messageType) ? (
                    <View style={styles.callEventContainer}>
                      <View style={[styles.callEventPill, {backgroundColor: c.separator}]}>
                        <CallIcon color={c.secondaryLabel} />
                        <Text style={[styles.callEventText, {color: c.secondaryLabel}]}>
                          {callEventLabel(message.messageType)}
                        </Text>
                      </View>
                    </View>
                  ) : (
                    <MessageBubble message={message} isGroup={channel.isGroup} isFirstInGroup={isFirstInGroup} isLastInGroup={isLastInGroup} onReply={onReply} userId={userId} onRetryDownload={onRetryDownload} showReadReceipt={index === lastReadIndex} crossAlbumAttachments={crossAlbumMap.get(message.id)} />
                  )}
                </React.Fragment>
              );
            });
          })()
        )}
        <TypingSection channelId={channel.id} isGroup={channel.isGroup} scrollViewRef={scrollViewRef} />
      </ScrollView>

      {/* Gradient blur overlay at top - mimics Tahoe Messages */}
      <GradientBlurView style={styles.topBlur} />

      {/* Small glass pill header */}
      <View style={styles.headerPillContainer} pointerEvents="box-none">
        <View style={styles.headerPillWrapper} pointerEvents="box-none">
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
          <View style={styles.headerNameRow}>
            {!channel.isGroup && onStartCall ? (
              <TouchableOpacity
                style={styles.callButton}
                onPress={() => onStartCall(channel.id, false)}
                activeOpacity={0.7}
              >
                <GlassView style={StyleSheet.absoluteFill} cornerRadius={14} />
                <Text style={styles.callButtonIcon}>{'\u{1F4DE}\uFE0E'}</Text>
              </TouchableOpacity>
            ) : null}
            <View style={styles.headerPill}>
              <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} />
              <Text style={[styles.pillName, {color: c.label}]} numberOfLines={1}>
                {displayName}
              </Text>
            </View>
            {!channel.isGroup && onStartCall ? (
              <View style={styles.callButtonSpacer} />
            ) : null}
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
  headerNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -6,
    gap: 4,
  },
  callButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  callButtonSpacer: {
    width: 28,
    height: 28,
  },
  callButtonIcon: {
    fontSize: 12,
    lineHeight: 16,
  },
  headerPill: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
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
  callEventContainer: {
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 16,
  },
  callEventPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  callEventText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
