import React from 'react';
import {View, Text, Pressable, StyleSheet} from 'react-native';
import {Channel} from '../store/signalStore';
import {colors} from '../theme/colors';

interface ChannelItemProps {
  channel: Channel;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

export function ChannelItem({channel, isSelected, onSelect}: ChannelItemProps) {
  return (
    <Pressable
      style={[styles.container, isSelected && styles.selected]}
      onPress={() => onSelect(channel.id)}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>
            {channel.name}
          </Text>
          {channel.unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{channel.unreadCount}</Text>
            </View>
          )}
        </View>
        {channel.lastMessage && (
          <Text style={styles.preview} numberOfLines={1}>
            {channel.lastMessage}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  selected: {
    backgroundColor: '#0058D0',
    borderRadius: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2196f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.label,
    flex: 1,
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
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  preview: {
    fontSize: 13,
    color: colors.secondaryLabel,
    marginTop: 2,
  },
});
