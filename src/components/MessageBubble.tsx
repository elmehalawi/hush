import React, {useState, useCallback, useRef, useEffect} from 'react';
import {View, Text, Image, StyleSheet, Dimensions, Pressable, Linking, NativeModules, useColorScheme, ActivityIndicator} from 'react-native';
import {Message, Attachment, Mention, Reaction, useSignalStore} from '../store/signalStore';
import {ReactionBar} from './ReactionBar';
import {AudioAttachmentView} from './AudioAttachmentView';
import {colors} from '../theme/colors';

const {PresageModule} = NativeModules;

function openMediaPreview(filePath: string) {
  PresageModule?.previewFile(filePath);
}

interface MessageBubbleProps {
  message: Message;
  isGroup?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  onReact?: (emoji: string, targetTimestamp: number, remove: boolean) => void;
  userId?: string | null;
  onRetryDownload?: (channelId: string, messageId: string, attachmentIndex: number) => void;
  showReadReceipt?: boolean;
}

const MAX_BUBBLE_WIDTH = Dimensions.get('window').width * 0.75;
const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;

function getImageDimensions(attachment: Attachment) {
  const w = attachment.width || MAX_IMAGE_WIDTH;
  const h = attachment.height || MAX_IMAGE_WIDTH;
  const aspectRatio = w / h;

  let displayWidth = Math.min(w, MAX_IMAGE_WIDTH);
  let displayHeight = displayWidth / aspectRatio;

  if (displayHeight > MAX_IMAGE_HEIGHT) {
    displayHeight = MAX_IMAGE_HEIGHT;
    displayWidth = displayHeight * aspectRatio;
  }

  return {width: displayWidth, height: displayHeight};
}

const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g;

function LinkifiedText({text, isOutgoing, mentions}: {text: string; isOutgoing: boolean; mentions?: Mention[]}) {
  // Build a set of mention ranges for quick lookup
  const mentionRanges = (mentions || []).map(m => ({
    start: m.start,
    end: m.start + m.length,
    name: m.name,
  }));

  // Split text into segments: plain text, URLs, and mentions
  type Segment = {type: 'text'; value: string} | {type: 'url'; value: string} | {type: 'mention'; value: string};
  const segments: Segment[] = [];
  let cursor = 0;

  // First, identify mention positions
  const mentionPositions: {start: number; end: number; text: string}[] = [];
  for (const m of mentionRanges) {
    if (m.start >= 0 && m.end <= text.length) {
      mentionPositions.push({start: m.start, end: m.end, text: text.slice(m.start, m.end)});
    }
  }
  mentionPositions.sort((a, b) => a.start - b.start);

  // Build segments splitting by mentions first, then URLs within text segments
  for (const mp of mentionPositions) {
    if (mp.start > cursor) {
      segments.push({type: 'text', value: text.slice(cursor, mp.start)});
    }
    segments.push({type: 'mention', value: mp.text});
    cursor = mp.end;
  }
  if (cursor < text.length) {
    segments.push({type: 'text', value: text.slice(cursor)});
  }

  // Now split text segments by URLs
  const finalSegments: Segment[] = [];
  for (const seg of segments) {
    if (seg.type !== 'text') {
      finalSegments.push(seg);
      continue;
    }
    const urlParts = seg.value.split(URL_REGEX);
    for (const part of urlParts) {
      if (URL_REGEX.test(part)) {
        finalSegments.push({type: 'url', value: part});
      } else if (part) {
        finalSegments.push({type: 'text', value: part});
      }
    }
  }

  if (finalSegments.length === 1 && finalSegments[0].type === 'text') {
    return (
      <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
      {finalSegments.map((seg, i) => {
        if (seg.type === 'url') {
          return (
            <Text key={i} style={styles.link} onPress={() => Linking.openURL(seg.value)}>
              {seg.value}
            </Text>
          );
        }
        if (seg.type === 'mention') {
          return (
            <Text key={i} style={[styles.mentionText, isOutgoing && styles.mentionTextOutgoing]}>
              {seg.value}
            </Text>
          );
        }
        return seg.value;
      })}
    </Text>
  );
}

function isImageType(contentType: string) {
  return contentType.startsWith('image/');
}

function isVideoType(contentType: string) {
  return contentType.startsWith('video/');
}

function isAudioType(contentType: string) {
  return contentType.startsWith('audio/');
}

function AttachmentView({
  attachment,
  isOutgoing,
  onRetry,
}: {
  attachment: Attachment;
  isOutgoing: boolean;
  onRetry?: () => void;
}) {
  const rightClickedRef = useRef(false);
  const [showRetry, setShowRetry] = useState(false);

  // Show retry button after 15s if still no filePath
  useEffect(() => {
    if (attachment.filePath) {
      setShowRetry(false);
      return;
    }
    const timer = setTimeout(() => setShowRetry(true), 15000);
    return () => clearTimeout(timer);
  }, [attachment.filePath]);

  if (!attachment.filePath) {
    return (
      <View style={styles.failedAttachment}>
        {showRetry ? (
          <>
            <Text style={styles.failedAttachmentText}>Download failed</Text>
            {onRetry && (
              <Pressable onPress={onRetry} style={styles.retryButton}>
                <Text style={styles.retryButtonText}>Retry</Text>
              </Pressable>
            )}
          </>
        ) : (
          <>
            <ActivityIndicator size="small" color="#999" />
            <Text style={[styles.failedAttachmentText, {marginTop: 4}]}>Downloading...</Text>
          </>
        )}
      </View>
    );
  }

  const handlePressIn = (e: any) => {
    if (e.nativeEvent?.button === 2) {
      rightClickedRef.current = true;
      PresageModule?.showFileContextMenu(
        attachment.filePath!,
        attachment.fileName || 'File',
      );
    } else {
      rightClickedRef.current = false;
    }
  };

  const handlePress = () => {
    if (rightClickedRef.current) {
      rightClickedRef.current = false;
      return;
    }
    openMediaPreview(attachment.filePath!);
  };

  if (isImageType(attachment.contentType)) {
    const dims = getImageDimensions(attachment);
    return (
      <Pressable onPress={handlePress} onPressIn={handlePressIn}>
        <Image
          source={{uri: `file://${attachment.filePath}`}}
          style={[styles.attachmentImage, {width: dims.width, height: dims.height}]}
          resizeMode="cover"
        />
      </Pressable>
    );
  }

  if (isVideoType(attachment.contentType)) {
    const dims = getImageDimensions(attachment);
    const thumbUri = attachment.thumbnailPath
      ? `file://${attachment.thumbnailPath}`
      : undefined;
    return (
      <Pressable onPress={handlePress} onPressIn={handlePressIn}>
        <View style={[styles.videoContainer, {width: dims.width, height: dims.height}]}>
          {thumbUri ? (
            <Image
              source={{uri: thumbUri}}
              style={[styles.attachmentImage, {width: dims.width, height: dims.height}]}
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.videoPlaceholder, {width: dims.width, height: dims.height}]} />
          )}
          <View style={styles.playButtonOverlay}>
            <View style={styles.playButton}>
              <Text style={styles.playIcon}>{'\u25B6'}</Text>
            </View>
          </View>
        </View>
      </Pressable>
    );
  }

  // Generic file attachment
  return (
    <Pressable onPress={handlePress} onPressIn={handlePressIn}>
      <View style={[styles.fileAttachment, isOutgoing && styles.fileAttachmentOutgoing]}>
        <Text style={[styles.fileIcon]}>{'📎'}</Text>
        <Text
          style={[styles.fileName, isOutgoing && styles.fileNameOutgoing]}
          numberOfLines={2}>
          {attachment.fileName || 'File'}
        </Text>
      </View>
    </Pressable>
  );
}

function ReactionsRow({
  reactions,
  isOutgoing,
}: {
  reactions: Reaction[];
  isOutgoing: boolean;
}) {
  const colorScheme = useColorScheme();

  // Group reactions by emoji and count them
  const grouped = new Map<string, number>();
  for (const r of reactions) {
    grouped.set(r.emoji, (grouped.get(r.emoji) || 0) + 1);
  }

  if (reactions.length === 0) return null;

  const pillBg = colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)';
  const pillBorder = colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';
  const countColor = colorScheme === 'dark' ? '#aaa' : '#666';

  return (
    <View style={[styles.reactionsContainer, isOutgoing ? styles.reactionsOutgoing : styles.reactionsIncoming]}>
      {Array.from(grouped.entries()).map(([emoji, count]) => (
        <View key={emoji} style={[styles.reactionPill, {backgroundColor: pillBg, borderColor: pillBorder}]}>
          <Text style={styles.reactionEmoji}>{emoji}</Text>
          {count > 1 && <Text style={[styles.reactionCount, {color: countColor}]}>{count}</Text>}
        </View>
      ))}
    </View>
  );
}

function DoubleCheckIcon({color}: {color: string}) {
  return (
    <View style={{flexDirection: 'row', alignItems: 'center'}}>
      <Text style={{fontSize: 12, color}}>{'\u2713'}</Text>
      <Text style={{fontSize: 12, color, marginLeft: -4}}>{'\u2713'}</Text>
    </View>
  );
}

export function MessageBubble({message, isGroup, isFirstInGroup = true, isLastInGroup = true, onReact, userId, onRetryDownload, showReadReceipt}: MessageBubbleProps) {
  const colorScheme = useColorScheme();
  const incomingBubbleBg = colorScheme === 'dark' ? '#3A3A3D' : '#E9E9EB';
  const outgoingBubbleBg = colorScheme === 'dark' ? '#2E6FA3' : '#3A9DF5';
  const isOutgoing = message.isOutgoing;
  const showSenderInfo = !!isGroup && !isOutgoing;
  const showSenderName = showSenderInfo && isFirstInGroup;
  const showAvatar = showSenderInfo && isLastInGroup;
  const [hovered, setHovered] = useState(false);

  // Find current user's existing reaction emoji on this message
  const myReaction = userId
    ? message.reactions.find(r => r.senderId === userId)
    : undefined;

  const handleReact = useCallback(
    (emoji: string) => {
      if (!onReact) return;
      const isRemove = myReaction?.emoji === emoji;
      onReact(emoji, message.timestamp, isRemove);
      setHovered(false);
    },
    [onReact, myReaction, message.timestamp],
  );

  // Look up sender's avatar from their DM channel
  const senderChannel = useSignalStore(state =>
    showSenderInfo ? state.channels.find(c => c.id === message.senderId) : undefined,
  );
  const senderAvatar = senderChannel?.avatarPath;
  const senderInitial = message.senderName?.charAt(0).toUpperCase() || '?';
  const audioAttachments = message.attachments.filter(a => isAudioType(a.contentType));
  const nonAudioAttachments = message.attachments.filter(a => !isAudioType(a.contentType));
  const hasAttachments = nonAudioAttachments.length > 0;
  const hasAudio = audioAttachments.length > 0;
  const hasBody = !!message.body;
  const mediaAttachments = nonAudioAttachments.filter(
    a => isImageType(a.contentType) || isVideoType(a.contentType),
  );
  const hasMedia = mediaAttachments.length > 0;
  const audioOnly = hasAudio && !hasBody && !hasAttachments;

  const bubbleStyle = [
    styles.bubble,
    isOutgoing ? [styles.bubbleOutgoing, {backgroundColor: outgoingBubbleBg}] : [styles.bubbleIncoming, {backgroundColor: incomingBubbleBg}],
    hasMedia && styles.bubbleWithMedia,
    showSenderInfo && styles.bubbleInGroup,
  ];

  const readReceiptColor = colorScheme === 'dark' ? 'rgba(255,255,255,0.4)' : '#8E8E93';

  const statusBelow = isOutgoing ? (
    <>
      {message.status === 'sending' && (
        <View style={[styles.belowBubbleStatus, styles.belowBubbleStatusOutgoing]}>
          <Text style={styles.sendingText}>{'\u23F3'}</Text>
        </View>
      )}
      {message.status === 'failed' && (
        <View style={[styles.belowBubbleStatus, styles.belowBubbleStatusOutgoing]}>
          <Text style={styles.failedText}>{'\u26A0'} Failed</Text>
        </View>
      )}
      {showReadReceipt && (
        <View style={[styles.belowBubbleStatus, styles.belowBubbleStatusOutgoing]}>
          <Text style={[styles.readText, {color: readReceiptColor}]}>Read</Text>
        </View>
      )}
    </>
  ) : null;

  const audioContent = hasAudio ? (
    <View>
      {audioAttachments.map((attachment, index) => (
        <AudioAttachmentView
          key={`audio-${index}`}
          filePath={attachment.filePath!}
          isOutgoing={isOutgoing}
        />
      ))}
    </View>
  ) : null;

  const bubbleContent = (
    <>
      {hasAttachments && (
        <View style={styles.attachmentsContainer}>
          {nonAudioAttachments.map((attachment, index) => (
            <AttachmentView
              key={index}
              attachment={attachment}
              isOutgoing={isOutgoing}
              onRetry={
                onRetryDownload && !attachment.filePath
                  ? () => onRetryDownload(message.channelId, message.id, message.attachments.indexOf(attachment))
                  : undefined
              }
            />
          ))}
        </View>
      )}
      {hasBody && (
        <View style={hasMedia ? styles.bodyBelowMedia : undefined}>
          <LinkifiedText text={message.body!} isOutgoing={isOutgoing} mentions={message.mentions} />
        </View>
      )}
      {!hasBody && !hasAttachments && !hasAudio && (
        <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
          [No content]
        </Text>
      )}
    </>
  );

  const handleBubblePressIn = useCallback((e: any) => {
    if (e.nativeEvent?.button === 2 && message.body) {
      PresageModule?.showMessageContextMenu(message.body);
    }
  }, [message.body]);

  const hasReactions = message.reactions.length > 0;

  const reactionsRow = (
    <ReactionsRow
      reactions={message.reactions}
      isOutgoing={isOutgoing}
    />
  );

  return (
    <View
      // @ts-ignore - onMouseEnter/onMouseLeave work on macOS
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={[
        styles.container,
        isOutgoing ? styles.outgoing : styles.incoming,
        hasReactions && styles.containerWithReactions,
      ]}>
      {showSenderInfo ? (
        <View style={styles.groupRow}>
          {showAvatar ? (
            <View style={styles.senderAvatarContainer}>
              {senderAvatar ? (
                <Image
                  source={{uri: `file://${senderAvatar}`}}
                  style={styles.senderAvatarImage}
                />
              ) : (
                <View style={styles.senderAvatarFallback}>
                  <Text style={styles.senderAvatarText}>{senderInitial}</Text>
                </View>
              )}
            </View>
          ) : (
            <View style={styles.senderAvatarSpacer} />
          )}
          <View style={styles.groupBubbleColumn}>
            {showSenderName && message.senderName && (
              <Text style={styles.senderName}>{message.senderName}</Text>
            )}
            {audioContent}
            {!audioOnly && <Pressable onPressIn={handleBubblePressIn}><View style={bubbleStyle}>{bubbleContent}</View></Pressable>}
            {reactionsRow}
            {statusBelow}
          </View>
        </View>
      ) : (
        <>
          {audioContent}
          {!audioOnly && <Pressable onPressIn={handleBubblePressIn}><View style={bubbleStyle}>{bubbleContent}</View></Pressable>}
          {reactionsRow}
          {statusBelow}
        </>
      )}
      {hovered && onReact && !isOutgoing && (
        <View style={[
          styles.reactionBarOverlay,
          isOutgoing
            ? styles.reactionBarOverlayOutgoing
            : showSenderInfo
              ? styles.reactionBarOverlayIncomingGroup
              : styles.reactionBarOverlayIncoming,
        ]}>
          <ReactionBar onReact={handleReact} existingReactionEmoji={myReaction?.emoji} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    paddingHorizontal: 8,
  },
  containerWithReactions: {
    marginBottom: 4,
  },
  outgoing: {
    alignItems: 'flex-end',
  },
  incoming: {
    alignItems: 'flex-start',
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    maxWidth: '80%',
  },
  senderAvatarContainer: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 6,
    marginBottom: 2,
    overflow: 'hidden',
  },
  senderAvatarImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  senderAvatarFallback: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#7B8794',
    alignItems: 'center',
    justifyContent: 'center',
  },
  senderAvatarText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  senderAvatarSpacer: {
    width: 28,
    marginRight: 6,
  },
  groupBubbleColumn: {
    flexShrink: 1,
  },
  senderName: {
    fontSize: 12,
    color: '#2196f3',
    fontWeight: '500',
    marginBottom: 2,
    marginLeft: 4,
  },
  bubble: {
    maxWidth: '75%',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 18,
  },
  bubbleOutgoing: {
    backgroundColor: '#2196f3',
    borderBottomRightRadius: 4,
  },
  bubbleIncoming: {
    backgroundColor: colors.incomingBubble,
    borderBottomLeftRadius: 4,
  },
  bubbleInGroup: {
    maxWidth: undefined,
  },
  bubbleWithMedia: {
    padding: 3,
    overflow: 'hidden',
  },
  attachmentsContainer: {
    borderRadius: 17,
    overflow: 'hidden',
  },
  attachmentImage: {
    borderRadius: 17,
  },
  videoContainer: {
    borderRadius: 17,
    overflow: 'hidden',
  },
  playButtonOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    color: 'white',
    fontSize: 18,
    marginLeft: 3,
  },
  videoPlaceholder: {
    borderRadius: 17,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  failedAttachment: {
    width: MAX_IMAGE_WIDTH,
    height: 80,
    borderRadius: 17,
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  failedAttachmentText: {
    fontSize: 12,
    color: '#999',
  },
  retryButton: {
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  retryButtonText: {
    fontSize: 12,
    color: '#2196f3',
    fontWeight: '500',
  },
  belowBubbleStatus: {
    marginTop: 2,
    paddingHorizontal: 4,
  },
  belowBubbleStatusOutgoing: {
    alignItems: 'flex-end',
  },
  sendingText: {
    fontSize: 11,
    color: '#8E8E93',
  },
  failedText: {
    fontSize: 11,
    color: '#FF3B30',
  },
  readText: {
    fontSize: 10,
    fontWeight: '600',
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    margin: 4,
    minWidth: 200,
  },
  fileAttachmentOutgoing: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  fileIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  fileName: {
    fontSize: 13,
    color: colors.incomingBody,
    flex: 1,
  },
  fileNameOutgoing: {
    color: 'white',
  },
  bodyBelowMedia: {
    paddingHorizontal: 7,
    paddingTop: 4,
  },
  body: {
    fontSize: 13,
    color: colors.incomingBody,
  },
  bodyOutgoing: {
    color: 'white',
  },
  link: {
    textDecorationLine: 'underline',
  },
  mentionText: {
    fontWeight: '600',
    color: '#2196f3',
  },
  mentionTextOutgoing: {
    color: 'rgba(255, 255, 255, 0.9)',
  },
  reactionBarOverlay: {
    position: 'absolute',
    bottom: 0,
    zIndex: 10,
  },
  reactionBarOverlayOutgoing: {
    right: 12,
  },
  reactionBarOverlayIncoming: {
    left: 12,
  },
  reactionBarOverlayIncomingGroup: {
    left: 46,
  },
  reactionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: -8,
    gap: 4,
  },
  reactionsOutgoing: {
    justifyContent: 'flex-end',
    paddingRight: 4,
  },
  reactionsIncoming: {
    justifyContent: 'flex-start',
    paddingLeft: 4,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactionEmoji: {
    fontSize: 16,
  },
  reactionCount: {
    fontSize: 12,
    marginLeft: 2,
  },
});
