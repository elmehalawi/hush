import React, {useState, useCallback, useRef, useEffect} from 'react';
import {View, Text, Image, StyleSheet, Dimensions, Pressable, Linking, NativeModules, useColorScheme, ActivityIndicator, Animated} from 'react-native';
import {Message, Attachment, Mention, Reaction, useSignalStore, resolveContactName} from '../store/signalStore';
import {AudioAttachmentView} from './AudioAttachmentView';
import {AlbumView, AlbumViewHandle} from './AlbumView';
import {AttachmentThumbnail} from './AttachmentThumbnail';
import {LinkPreviewCard} from './LinkPreviewCard';
import {AnimatedSwipeGestureView} from './NativeSwipeGestureView';
import {isImageType, isVideoType, isAudioType} from '../utils/attachmentIcon';
import {useColors} from '../theme/colors';

const {PresageModule} = NativeModules;

function openMediaPreview(filePath: string) {
  PresageModule?.previewFile(filePath);
}

interface MessageBubbleProps {
  message: Message;
  isGroup?: boolean;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  onReply?: (message: Message) => void;
  userId?: string | null;
  onRetryDownload?: (channelId: string, messageId: string, attachmentIndex: number) => void;
  showReadReceipt?: boolean;
  crossAlbumAttachments?: Attachment[];
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

const EMPTY_MESSAGES: Message[] = [];

function LinkifiedText({text, isOutgoing, mentions, channelId}: {text: string; isOutgoing: boolean; mentions?: Mention[]; channelId?: string}) {
  const c = useColors();
  const channels = useSignalStore(s => s.channels);
  const userId = useSignalStore(s => s.userId);
  const channelMessages = useSignalStore(s => channelId ? s.messages[channelId] : undefined) || EMPTY_MESSAGES;

  // Build a set of mention ranges, resolving names from current store data
  const mentionRanges = (mentions || []).map(m => ({
    start: m.start,
    end: m.start + m.length,
    name: resolveContactName(m.uuid, userId, channels, channelMessages) || m.name,
  }));

  // Split text into segments: plain text, URLs, and mentions
  type Segment = {type: 'text'; value: string} | {type: 'url'; value: string} | {type: 'mention'; value: string};
  const segments: Segment[] = [];
  let cursor = 0;

  // First, identify mention positions — use resolved name instead of body text
  const mentionPositions: {start: number; end: number; text: string}[] = [];
  for (const m of mentionRanges) {
    if (m.start >= 0 && m.end <= text.length) {
      mentionPositions.push({start: m.start, end: m.end, text: `@${m.name}`});
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
      <Text style={[styles.body, {color: c.incomingBody}, isOutgoing && styles.bodyOutgoing]}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={[styles.body, {color: c.incomingBody}, isOutgoing && styles.bodyOutgoing]}>
      {finalSegments.map((seg, i) => {
        if (seg.type === 'url') {
          return (
            <Text key={i} style={styles.link} onPress={(e: any) => {
              // Only open URL on left-click; let right-clicks propagate to the
              // bubble's context-menu handler instead of swallowing the event.
              if (e.nativeEvent?.button === 2) return;
              Linking.openURL(seg.value);
            }}>
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

function AttachmentView({
  attachment,
  isOutgoing,
  onRetry,
  onRightClick,
}: {
  attachment: Attachment;
  isOutgoing: boolean;
  onRetry?: () => void;
  onRightClick?: (e: any) => void;
}) {
  const c = useColors();
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
      onRightClick?.(e);
      return;
    }
    openMediaPreview(attachment.filePath!);
  };

  if (isImageType(attachment.contentType)) {
    const dims = getImageDimensions(attachment);
    return (
      <Pressable onPressIn={handlePressIn}>
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
      <Pressable onPressIn={handlePressIn}>
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

  // Generic file attachment — render the native OS file-type icon (shared with
  // the compose-bar attachment strip via AttachmentThumbnail).
  return (
    <Pressable onPressIn={handlePressIn}>
      <View style={[styles.fileAttachment, isOutgoing && styles.fileAttachmentOutgoing]}>
        <AttachmentThumbnail
          size={40}
          contentType={attachment.contentType}
          filePath={attachment.filePath}
          thumbnailPath={attachment.thumbnailPath}
          background={false}
          borderRadius={6}
          style={styles.fileIcon}
        />
        <Text
          style={[styles.fileName, {color: c.incomingBody}, isOutgoing && styles.fileNameOutgoing]}
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

function QuoteBanner({quote, isOutgoing, channelId}: {quote: Message['quote']; isOutgoing: boolean; channelId?: string}) {
  const c = useColors();
  const colorScheme = useColorScheme();
  const channels = useSignalStore(s => s.channels);
  const userId = useSignalStore(s => s.userId);
  const channelMessages = useSignalStore(s => channelId ? s.messages[channelId] : undefined) || EMPTY_MESSAGES;
  if (!quote) return null;

  const authorDisplayName = resolveContactName(quote.authorId, userId, channels, channelMessages)
    || quote.authorName
    || quote.authorId;

  const barColor = isOutgoing ? 'rgba(255, 255, 255, 0.5)' : '#2196f3';
  const bgColor = isOutgoing
    ? 'rgba(255, 255, 255, 0.12)'
    : colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)';
  const nameColor = isOutgoing ? 'rgba(255, 255, 255, 0.9)' : '#2196f3';
  const textColor = isOutgoing ? 'rgba(255, 255, 255, 0.7)' : c.secondaryLabel;

  return (
    <View style={[quoteBannerStyles.container, {backgroundColor: bgColor}]}>
      <View style={[quoteBannerStyles.bar, {backgroundColor: barColor}]} />
      <View style={quoteBannerStyles.content}>
        <Text style={[quoteBannerStyles.authorName, {color: nameColor}]} numberOfLines={1}>
          {authorDisplayName}
        </Text>
        {quote.text ? (
          <Text style={[quoteBannerStyles.text, {color: textColor}]} numberOfLines={2}>
            {quote.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const quoteBannerStyles = StyleSheet.create({
  container: {
    borderRadius: 6,
    marginHorizontal: 4,
    marginTop: 4,
    marginBottom: 2,
    overflow: 'hidden',
  },
  bar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 3,
  },
  content: {
    paddingVertical: 4,
    paddingLeft: 11,
    paddingRight: 8,
  },
  authorName: {
    fontSize: 12,
    fontWeight: '600',
  },
  text: {
    fontSize: 12,
    marginTop: 1,
  },
});

const SWIPE_THRESHOLD = 60;

export function MessageBubble({message, isGroup, isFirstInGroup = true, isLastInGroup = true, onReply, userId, onRetryDownload, showReadReceipt, crossAlbumAttachments}: MessageBubbleProps) {
  const colorScheme = useColorScheme();
  const c = useColors();
  const incomingBubbleBg = colorScheme === 'dark' ? '#3A3A3D' : '#E9E9EB';
  const outgoingBubbleBg = colorScheme === 'dark' ? '#2E6FA3' : '#3A9DF5';
  const isOutgoing = message.isOutgoing;
  const showSenderInfo = !!isGroup && !isOutgoing;
  const showSenderName = showSenderInfo && isFirstInGroup;
  const showAvatar = showSenderInfo && isLastInGroup;
  // Swipe-to-reply gesture (driven by native trackpad scroll events)
  const swipeAnim = useRef(new Animated.Value(0)).current;
  const swipeTriggered = useRef(false);
  const swipeEnded = useRef(false);
  const albumRef = useRef<AlbumViewHandle>(null);

  const handleSwipeUpdate = useCallback((e: any) => {
    if (swipeEnded.current) { return; }
    const deltaX = e.nativeEvent.deltaX;
    if (deltaX > 0) {
      // Right swipe: apply with diminishing returns
      swipeAnim.setValue(Math.min(deltaX * 0.5, 50));
      if (deltaX > SWIPE_THRESHOLD && !swipeTriggered.current) {
        swipeTriggered.current = true;
      }
    } else {
      swipeAnim.setValue(0);
    }
  }, [swipeAnim]);

  const handleSwipeEnd = useCallback(() => {
    swipeEnded.current = true;
    if (swipeTriggered.current && onReply) {
      onReply(message);
    }
    swipeTriggered.current = false;
    Animated.spring(swipeAnim, {
      toValue: 0,
      useNativeDriver: false,
      tension: 100,
      friction: 10,
    }).start(() => {
      swipeEnded.current = false;
    });
  }, [swipeAnim, onReply, message]);

  // Album swipe handlers — forward events from the outer gesture view to AlbumView
  const handleAlbumSwipeUpdate = useCallback((e: any) => {
    albumRef.current?.onSwipeUpdate(e.nativeEvent.deltaX);
  }, []);

  const handleAlbumSwipeEnd = useCallback((e: any) => {
    albumRef.current?.onSwipeEnd(e?.nativeEvent?.deltaX ?? 0);
  }, []);

  // Find current user's existing reaction emoji on this message
  const myReaction = userId
    ? message.reactions.find(r => r.senderId === userId)
    : undefined;

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
  const mediaAttachments = crossAlbumAttachments || nonAudioAttachments.filter(
    a => isImageType(a.contentType) || isVideoType(a.contentType),
  );
  const hasMedia = mediaAttachments.length > 0;
  const audioOnly = hasAudio && !hasBody && !hasAttachments;
  const isAlbum = mediaAttachments.length > 1;
  const isSingleMediaOnly = mediaAttachments.length === 1 && !hasBody && nonAudioAttachments.length === 1;

  // Compute border radius based on position within message group.
  // Only the tail side changes: right for outgoing, left for incoming.
  // The tail corner (bottom-right outgoing, bottom-left incoming) always stays small.
  // Non-first messages get a small radius on the top corner of the tail side.
  const groupRadiusStyle = isFirstInGroup
    ? undefined
    : isOutgoing
      ? {borderTopRightRadius: 4}
      : {borderTopLeftRadius: 4};

  // Any message with media attachments renders bubble-free; text gets its own caption bubble
  const useBubbleMediaOnly = crossAlbumAttachments ? true : hasMedia && nonAudioAttachments.length === mediaAttachments.length && !message.quote;
  const bubbleStyle = useBubbleMediaOnly
    ? [
        styles.bubbleMediaOnly,
        isOutgoing ? {borderBottomRightRadius: 4} : {borderBottomLeftRadius: 4},
        showSenderInfo && styles.bubbleInGroup,
        groupRadiusStyle,
      ]
    : [
        styles.bubble,
        isOutgoing ? [styles.bubbleOutgoing, {backgroundColor: outgoingBubbleBg}] : [styles.bubbleIncoming, {backgroundColor: incomingBubbleBg}],
        hasMedia && styles.bubbleWithMedia,
        showSenderInfo && styles.bubbleInGroup,
        groupRadiusStyle,
      ];

  const readReceiptColor = colorScheme === 'dark' ? 'rgba(255,255,255,0.4)' : '#8E8E93';

  // Resolve read-by names for group chats
  const channels = useSignalStore(state => state.channels);
  const readReceiptLabel = (() => {
    if (!showReadReceipt || !isGroup || message.readBy.length === 0) {
      return 'Read';
    }
    const names = message.readBy
      .map(uuid => channels.find(ch => ch.id === uuid)?.name)
      .filter(Boolean);
    if (names.length === 0) {
      return 'Read';
    }
    return `Read by ${names.join(', ')}`;
  })();

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
          <Text style={[styles.readText, {color: readReceiptColor}]}>{readReceiptLabel}</Text>
        </View>
      )}
    </>
  ) : null;

  // First media attachment for context menu file actions
  const firstMediaAttachment = mediaAttachments.length > 0 ? mediaAttachments[0] : null;

  const handleBubblePressIn = useCallback((e: any) => {
    if (e.nativeEvent?.button === 2) {
      const authorName = message.isOutgoing
        ? 'You'
        : message.senderName || message.senderId;
      PresageModule?.showMessageContextMenu(
        message.body || '',
        message.timestamp,
        message.senderId,
        authorName,
        message.channelId,
        myReaction?.emoji || '',
        firstMediaAttachment?.filePath || '',
        firstMediaAttachment?.fileName || '',
      );
    }
  }, [message.body, message.timestamp, message.senderId, message.senderName, message.isOutgoing, message.channelId, myReaction?.emoji, firstMediaAttachment?.filePath, firstMediaAttachment?.fileName]);

  const audioContent = hasAudio ? (
    <View>
      {audioAttachments.filter(a => a.filePath).map((attachment, index) => (
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
      {message.quote && <QuoteBanner quote={message.quote} isOutgoing={isOutgoing} channelId={message.channelId} />}
      {hasAttachments && !isAlbum && (
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
              onRightClick={handleBubblePressIn}
            />
          ))}
        </View>
      )}
      {isAlbum && (
        <AlbumView
          ref={albumRef}
          attachments={mediaAttachments}
          isOutgoing={isOutgoing}
          onPreview={(filePath) => openMediaPreview(filePath)}
          onRightClick={handleBubblePressIn}
        />
      )}
      {hasBody && hasMedia && (
        <View style={[
          styles.captionBubble,
          isOutgoing
            ? [styles.bubbleOutgoing, {backgroundColor: outgoingBubbleBg}]
            : [styles.bubbleIncoming, {backgroundColor: incomingBubbleBg}],
        ]}>
          <LinkifiedText text={message.body!} isOutgoing={isOutgoing} mentions={message.mentions} channelId={message.channelId} />
        </View>
      )}
      {hasBody && !hasMedia && (
        <LinkifiedText text={message.body!} isOutgoing={isOutgoing} mentions={message.mentions} channelId={message.channelId} />
      )}
      {message.linkPreviews.length > 0 && (
        <View style={styles.linkPreviewContainer}>
          <LinkPreviewCard
            url={message.linkPreviews[0].url}
            title={message.linkPreviews[0].title}
            description={message.linkPreviews[0].description}
            image={message.linkPreviews[0].image}
            onPress={() => Linking.openURL(message.linkPreviews[0].url)}
            isOutgoing={isOutgoing}
          />
        </View>
      )}
      {!hasBody && !hasAttachments && !hasAudio && message.linkPreviews.length === 0 && (
        <Text style={[styles.body, {color: c.incomingBody}, isOutgoing && styles.bodyOutgoing]}>
          [No content]
        </Text>
      )}
    </>
  );

  const hasReactions = message.reactions.length > 0;

  const reactionsRow = (
    <ReactionsRow
      reactions={message.reactions}
      isOutgoing={isOutgoing}
    />
  );

  return (
    <AnimatedSwipeGestureView
      onSwipeUpdate={isAlbum ? handleAlbumSwipeUpdate : (onReply ? handleSwipeUpdate : undefined)}
      onSwipeEnd={isAlbum ? handleAlbumSwipeEnd : (onReply ? handleSwipeEnd : undefined)}
      style={[
        styles.container,
        isOutgoing ? styles.outgoing : styles.incoming,
        hasReactions && styles.containerWithReactions,
        !isAlbum && {transform: [{translateX: swipeAnim}]},
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
    </AnimatedSwipeGestureView>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    marginHorizontal: 8,
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
    borderBottomLeftRadius: 4,
  },
  bubbleInGroup: {
    maxWidth: undefined,
  },
  bubbleWithMedia: {
    padding: 3,
    overflow: 'hidden',
  },
  bubbleMediaOnly: {
    maxWidth: '75%',
    backgroundColor: 'transparent',
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
    marginRight: 10,
  },
  fileName: {
    fontSize: 13,
    flex: 1,
  },
  fileNameOutgoing: {
    color: 'white',
  },
  captionBubble: {
    marginTop: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 18,
  },
  linkPreviewContainer: {
    marginTop: 4,
    marginHorizontal: 3,
    marginBottom: 2,
  },
  body: {
    fontSize: 13,
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
