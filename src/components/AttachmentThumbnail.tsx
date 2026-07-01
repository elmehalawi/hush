import React from 'react';
import {View, Image, Text, StyleSheet, StyleProp, ViewStyle} from 'react-native';
import {AttachmentKind, attachmentKind, useFileIcon} from '../utils/attachmentIcon';

interface AttachmentThumbnailProps {
  // Square edge length in points.
  size: number;
  // MIME type (message attachments). Optional when `kind` is provided.
  contentType?: string;
  // Explicit visual kind override (compose bar derives this from extension).
  kind?: AttachmentKind;
  // Local file path of the attachment itself.
  filePath?: string;
  // A pre-generated preview/native-icon path, if the caller already has one.
  thumbnailPath?: string;
  borderRadius?: number;
  // Whether to draw the play triangle over video previews.
  showPlayIcon?: boolean;
  // Draw the subtle placeholder background behind file icons / placeholders.
  background?: boolean;
  style?: StyleProp<ViewStyle>;
}

// Central renderer for an attachment's visual: an image thumbnail, a video
// thumbnail with a play overlay, or a native OS file-type icon (with an emoji
// fallback). Shared by the message bubble and the compose-bar attachment strip
// so both stay in sync — tweak the look here.
export function AttachmentThumbnail({
  size,
  contentType,
  kind,
  filePath,
  thumbnailPath,
  borderRadius = 8,
  showPlayIcon = true,
  background = true,
  style,
}: AttachmentThumbnailProps) {
  const resolved = attachmentKind(contentType, kind);

  // Only fetch a native icon for generic files that don't already have one.
  const needsIcon = resolved === 'file' && !thumbnailPath;
  const fetchedIcon = useFileIcon(needsIcon ? filePath : undefined);

  const box: ViewStyle = {width: size, height: size, borderRadius, overflow: 'hidden'};
  const bg = background ? styles.placeholder : null;

  if (resolved === 'image') {
    const uri = thumbnailPath || filePath;
    if (uri) {
      return (
        <Image
          source={{uri: `file://${uri}`}}
          style={[box, style]}
          resizeMode="cover"
        />
      );
    }
    return (
      <View style={[box, styles.center, styles.placeholder, style]}>
        <Text style={{fontSize: size * 0.4}}>🖼</Text>
      </View>
    );
  }

  if (resolved === 'video') {
    // A video's own file can't render as an <Image>; only its generated
    // thumbnail can, so fall back to the emoji until one exists.
    return (
      <View style={[box, styles.center, styles.placeholder, style]}>
        {thumbnailPath ? (
          <Image
            source={{uri: `file://${thumbnailPath}`}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        ) : (
          <Text style={{fontSize: size * 0.4}}>🎥</Text>
        )}
        {showPlayIcon && (
          <View style={styles.playOverlay}>
            <Text style={[styles.playIcon, {fontSize: size * 0.33}]}>▶</Text>
          </View>
        )}
      </View>
    );
  }

  // Generic file: native OS icon, or 📄 fallback while it loads / on failure.
  const iconUri = thumbnailPath || fetchedIcon;
  return (
    <View style={[box, styles.center, bg, style]}>
      {iconUri ? (
        <Image
          source={{uri: `file://${iconUri}`}}
          style={{width: size * 0.72, height: size * 0.72}}
          resizeMode="contain"
        />
      ) : (
        <Text style={{fontSize: size * 0.4}}>📄</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    backgroundColor: 'rgba(128, 128, 128, 0.12)',
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  playIcon: {
    color: '#FFFFFF',
  },
});
