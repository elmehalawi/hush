import React from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  Linking,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import {Attachment} from '../store/signalStore';
import {extractDomain} from '../utils/linkPreview';

interface LinkPreviewCardProps {
  url: string;
  title?: string;
  description?: string;
  image?: Attachment | {uri: string};
  date?: number;
  onPress?: () => void;
  onDismiss?: () => void;
  loading?: boolean;
  isOutgoing?: boolean;
}

function getImageUri(
  image: Attachment | {uri: string} | undefined,
): string | undefined {
  if (!image) return undefined;
  if ('uri' in image) return image.uri;
  if ('filePath' in image && image.filePath)
    return `file://${image.filePath}`;
  return undefined;
}

export function LinkPreviewCard({
  url,
  title,
  description,
  image,
  onPress,
  onDismiss,
  loading,
  isOutgoing,
}: LinkPreviewCardProps) {
  const isDark = useColorScheme() === 'dark';
  const domain = extractDomain(url);
  const imageUri = getImageUri(image);

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else {
      Linking.openURL(url);
    }
  };

  if (loading) {
    return (
      <View
        style={[
          styles.container,
          isDark ? styles.containerDark : styles.containerLight,
        ]}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color="#999" />
          <Text style={[styles.domain, isDark && styles.textDark]}>
            {domain}
          </Text>
        </View>
        {onDismiss && (
          <Pressable style={styles.dismissButton} onPress={onDismiss}>
            <Text style={styles.dismissText}>{'\u2715'}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Pressable onPress={handlePress}>
      <View
        style={[
          styles.container,
          isDark ? styles.containerDark : styles.containerLight,
          isOutgoing && styles.containerOutgoing,
        ]}>
        {imageUri && (
          <Image
            source={{uri: imageUri}}
            style={styles.image}
            resizeMode="cover"
          />
        )}
        <View style={styles.textContent}>
          <Text
            style={[styles.domain, isDark && styles.textDark]}
            numberOfLines={1}>
            {domain}
          </Text>
          {title ? (
            <Text
              style={[
                styles.title,
                isDark && styles.textDark,
                isOutgoing && styles.textOutgoing,
              ]}
              numberOfLines={2}>
              {title}
            </Text>
          ) : null}
          {description ? (
            <Text
              style={[
                styles.description,
                isDark && styles.descriptionDark,
                isOutgoing && styles.descriptionOutgoing,
              ]}
              numberOfLines={2}>
              {description}
            </Text>
          ) : null}
        </View>
        {onDismiss && (
          <Pressable style={styles.dismissButton} onPress={onDismiss}>
            <Text style={styles.dismissText}>{'\u2715'}</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 12,
    overflow: 'hidden',
    maxWidth: 280,
  },
  containerLight: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  containerDark: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  containerOutgoing: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  image: {
    width: '100%',
    height: 140,
  },
  textContent: {
    padding: 8,
  },
  domain: {
    fontSize: 11,
    color: '#8E8E93',
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000',
    marginBottom: 2,
  },
  description: {
    fontSize: 12,
    color: '#666',
    lineHeight: 16,
  },
  descriptionDark: {
    color: '#aaa',
  },
  descriptionOutgoing: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  textDark: {
    color: '#ddd',
  },
  textOutgoing: {
    color: '#fff',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 8,
  },
  dismissButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(128, 128, 128, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dismissText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
