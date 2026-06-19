import React, {useMemo, useCallback, useEffect, useRef} from 'react';
import {View, Text, Pressable, StyleSheet, Image, NativeModules, Animated} from 'react-native';
import {Channel, useSignalStore} from '../store/signalStore';
import {GlassView} from './GlassView';
import {useColors} from '../theme/colors';
import {useWindowFocused} from '../hooks/useWindowFocused';

const {PresageModule} = NativeModules;

interface ChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  onSelect: (id: string) => void;
  collapsed?: boolean;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  }
  if (isYesterday) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    return date.toLocaleDateString([], {weekday: 'short'});
  }
  return date.toLocaleDateString([], {month: 'numeric', day: 'numeric'});
}

export function ChannelItem({channel, isSelected, onSelect, collapsed}: ChannelItemProps) {
  const c = useColors();
  const windowFocused = useWindowFocused();
  const activeSelected = isSelected && windowFocused;
  const timeLabel = useMemo(
    () => (channel.lastMessageTimestamp ? formatTimestamp(channel.lastMessageTimestamp) : null),
    [channel.lastMessageTimestamp],
  );

  const isTyping = useSignalStore(state =>
    (state.typingUsers[channel.id]?.length ?? 0) > 0,
  );

  const handlePressIn = useCallback((e: any) => {
    if (e.nativeEvent?.button === 2) {
      PresageModule?.showChannelContextMenu(channel.id, channel.isGroup);
    }
  }, [channel.id, channel.isGroup]);

  if (collapsed) {
    return (
      <Pressable
        style={[styles.collapsedContainer, isSelected && (activeSelected ? styles.selectedFocused : {backgroundColor: c.sidebarSelected})]}
        onPress={() => onSelect(channel.id)}
        onPressIn={handlePressIn}>
        <View style={[styles.avatar, styles.avatarCollapsed]}>
          {channel.avatarPath ? (
            <Image
              source={{uri: `file://${channel.avatarPath}`}}
              style={styles.avatarImage}
            />
          ) : (
            <>
              <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} tintColor="rgba(30, 120, 255, 0.45)" />
              <Text style={styles.avatarText}>
                {channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase()}
              </Text>
            </>
          )}
          {channel.unreadCount > 0 && (
            <View style={styles.collapsedBadge}>
              <Text style={styles.collapsedBadgeText}>{channel.unreadCount}</Text>
            </View>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={[styles.container, isSelected && (activeSelected ? styles.selectedFocused : {backgroundColor: c.sidebarSelected})]}
      onPress={() => onSelect(channel.id)}
      onPressIn={handlePressIn}>
      <View style={styles.avatar}>
        {channel.avatarPath ? (
          <Image
            source={{uri: `file://${channel.avatarPath}`}}
            style={styles.avatarImage}
          />
        ) : (
          <>
            <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} tintColor="rgba(30, 120, 255, 0.45)" />
            <Text style={styles.avatarText}>
              {channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase()}
            </Text>
          </>
        )}
      </View>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={[styles.name, {color: c.label}, activeSelected && styles.nameFocusedSelected]} numberOfLines={1}>
            {channel.name}
          </Text>
          {timeLabel && (
            <Text style={[styles.timestamp, {color: c.tertiaryLabel}, activeSelected && styles.timestampFocusedSelected]}>
              {timeLabel}
            </Text>
          )}
        </View>
        <View style={styles.secondRow}>
          {isTyping ? (
            <ChannelTypingDots color={activeSelected ? 'rgba(255, 255, 255, 0.75)' : c.secondaryLabel} />
          ) : channel.lastMessage ? (
            <Text style={[styles.preview, {color: c.secondaryLabel}, activeSelected && styles.previewFocusedSelected]} numberOfLines={1}>
              {channel.lastMessage}
            </Text>
          ) : (
            <View style={styles.previewSpacer} />
          )}
          {channel.unreadCount > 0 && (
            <View style={[styles.badge, activeSelected && styles.badgeFocusedSelected]}>
              <Text style={styles.badgeText}>{channel.unreadCount}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function ChannelTypingDots({color}: {color: string}) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const makeDot = (dot: Animated.Value, delay: number) =>
      Animated.sequence([
        Animated.delay(delay),
        Animated.loop(
          Animated.sequence([
            Animated.timing(dot, {toValue: 1, duration: 400, useNativeDriver: true}),
            Animated.timing(dot, {toValue: 0, duration: 400, useNativeDriver: true}),
          ]),
        ),
      ]);
    const anim = Animated.parallel([makeDot(dot1, 0), makeDot(dot2, 200), makeDot(dot3, 400)]);
    anim.start();
    return () => anim.stop();
  }, [dot1, dot2, dot3]);

  const dot = (v: Animated.Value) => ({
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: color,
    marginHorizontal: 1.5,
    opacity: v.interpolate({inputRange: [0, 1], outputRange: [0.3, 1]}),
    transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.7, 1]})}],
  });

  return (
    <View style={channelTypingStyles.row}>
      <Animated.View style={dot(dot1)} />
      <Animated.View style={dot(dot2)} />
      <Animated.View style={dot(dot3)} />
    </View>
  );
}

const channelTypingStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 18,
    flex: 1,
  },
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    marginVertical: 1,
  },
  collapsedContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    borderRadius: 8,
    marginVertical: 1,
  },
  selected: {},
  selectedFocused: {
    backgroundColor: '#0058D0',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'visible',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarCollapsed: {
    marginRight: 0,
  },
  avatarText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  timestamp: {
    fontSize: 12,
    marginLeft: 8,
    flexShrink: 0,
  },
  timestampFocusedSelected: {
    color: 'rgba(255, 255, 255, 0.6)',
  },
  secondRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  badge: {
    backgroundColor: '#2196f3',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    marginLeft: 8,
    flexShrink: 0,
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  preview: {
    fontSize: 13,
    flex: 1,
  },
  previewSpacer: {
    flex: 1,
  },
  nameFocusedSelected: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  previewFocusedSelected: {
    color: 'rgba(255, 255, 255, 0.75)',
  },
  badgeFocusedSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
  },
  collapsedBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#2196f3',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  collapsedBadgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: '700',
  },
});
