import React from 'react';
import {View, Text, Image, StyleSheet, Dimensions, Pressable, NativeModules} from 'react-native';
import {Message, Attachment} from '../store/signalStore';
import {colors} from '../theme/colors';

const {PresageModule} = NativeModules;

function openQuickLook(filePath: string) {
  PresageModule?.previewFile(filePath);
}

interface MessageBubbleProps {
  message: Message;
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

function isImageType(contentType: string) {
  return contentType.startsWith('image/');
}

function isVideoType(contentType: string) {
  return contentType.startsWith('video/');
}

function AttachmentView({
  attachment,
  isOutgoing,
}: {
  attachment: Attachment;
  isOutgoing: boolean;
}) {
  if (!attachment.filePath) {
    return (
      <View style={styles.failedAttachment}>
        <Text style={styles.failedAttachmentText}>Failed to load media</Text>
      </View>
    );
  }

  if (isImageType(attachment.contentType)) {
    const dims = getImageDimensions(attachment);
    return (
      <Pressable onPress={() => openQuickLook(attachment.filePath!)}>
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
      <Pressable onPress={() => openQuickLook(attachment.filePath!)}>
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
    <View style={[styles.fileAttachment, isOutgoing && styles.fileAttachmentOutgoing]}>
      <Text style={[styles.fileIcon]}>{'📎'}</Text>
      <Text
        style={[styles.fileName, isOutgoing && styles.fileNameOutgoing]}
        numberOfLines={1}>
        {attachment.fileName || 'File'}
      </Text>
    </View>
  );
}

export function MessageBubble({message}: MessageBubbleProps) {
  const isOutgoing = message.isOutgoing;
  const hasAttachments = message.attachments.length > 0;
  const hasBody = !!message.body;
  const mediaAttachments = message.attachments.filter(
    a => isImageType(a.contentType) || isVideoType(a.contentType),
  );
  const hasMedia = mediaAttachments.length > 0;

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  };

  const getStatusIcon = () => {
    switch (message.status) {
      case 'sending':
        return '\u23F3';
      case 'sent':
        return '\u2713';
      case 'delivered':
        return '\u2713\u2713';
      case 'read':
        return '\u2713\u2713';
      case 'failed':
        return '\u26A0';
      default:
        return '';
    }
  };

  return (
    <View
      style={[
        styles.container,
        isOutgoing ? styles.outgoing : styles.incoming,
      ]}>
      {!isOutgoing && message.senderName && (
        <Text style={styles.senderName}>{message.senderName}</Text>
      )}
      <View
        style={[
          styles.bubble,
          isOutgoing ? styles.bubbleOutgoing : styles.bubbleIncoming,
          hasMedia && styles.bubbleWithMedia,
        ]}>
        {/* Render attachments */}
        {hasAttachments && (
          <View style={styles.attachmentsContainer}>
            {message.attachments.map((attachment, index) => (
              <AttachmentView
                key={index}
                attachment={attachment}
                isOutgoing={isOutgoing}
              />
            ))}
          </View>
        )}

        {/* Render body text if present */}
        {hasBody && (
          <View style={hasMedia ? styles.bodyBelowMedia : undefined}>
            <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
              {message.body}
            </Text>
          </View>
        )}

        {/* Show fallback only if no body AND no attachments */}
        {!hasBody && !hasAttachments && (
          <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
            [No content]
          </Text>
        )}

        {/* Timestamp and status */}
        <View style={[styles.meta, hasMedia && !hasBody && styles.metaOverMedia]}>
          <Text
            style={[
              styles.time,
              isOutgoing && styles.timeOutgoing,
              hasMedia && !hasBody && styles.timeOverMedia,
            ]}>
            {formatTime(message.timestamp)}
          </Text>
          {isOutgoing && (
            <Text
              style={[
                styles.status,
                message.status === 'read' && styles.statusRead,
                hasMedia && !hasBody && styles.statusOverMedia,
              ]}>
              {getStatusIcon()}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    paddingHorizontal: 8,
  },
  outgoing: {
    alignItems: 'flex-end',
  },
  incoming: {
    alignItems: 'flex-start',
  },
  senderName: {
    fontSize: 12,
    color: '#2196f3',
    fontWeight: '500',
    marginBottom: 2,
    marginLeft: 12,
  },
  bubble: {
    maxWidth: '75%',
    padding: 10,
    borderRadius: 16,
  },
  bubbleOutgoing: {
    backgroundColor: '#2196f3',
    borderBottomRightRadius: 4,
  },
  bubbleIncoming: {
    backgroundColor: colors.incomingBubble,
    borderBottomLeftRadius: 4,
  },
  bubbleWithMedia: {
    padding: 3,
    overflow: 'hidden',
  },
  attachmentsContainer: {
    borderRadius: 13,
    overflow: 'hidden',
  },
  attachmentImage: {
    borderRadius: 13,
  },
  videoContainer: {
    borderRadius: 13,
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
    borderRadius: 13,
    backgroundColor: 'rgba(0, 0, 0, 0.15)',
  },
  failedAttachment: {
    width: MAX_IMAGE_WIDTH,
    height: 80,
    borderRadius: 13,
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  failedAttachmentText: {
    fontSize: 12,
    color: '#999',
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    margin: 4,
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
    paddingTop: 6,
  },
  body: {
    fontSize: 15,
    color: colors.incomingBody,
  },
  bodyOutgoing: {
    color: 'white',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
    paddingHorizontal: 4,
  },
  metaOverMedia: {
    position: 'absolute',
    bottom: 6,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 0,
  },
  time: {
    fontSize: 11,
    color: '#757575',
  },
  timeOutgoing: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  timeOverMedia: {
    color: 'rgba(255, 255, 255, 0.9)',
  },
  status: {
    fontSize: 12,
    marginLeft: 4,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  statusRead: {
    color: '#4fc3f7',
  },
  statusOverMedia: {
    color: 'rgba(255, 255, 255, 0.9)',
  },
});
