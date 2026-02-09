import React from 'react';
import {View, ScrollView, Text, StyleSheet} from 'react-native';
import {Channel} from '../store/signalStore';
import {ChannelItem} from './ChannelItem';
import {colors} from '../theme/colors';

interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ChannelList({channels, selectedId, onSelect}: ChannelListProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Conversations</Text>
      </View>
      <ScrollView style={styles.list}>
        {channels.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No conversations yet</Text>
          </View>
        ) : (
          [...channels].sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)).map(channel => (
            <ChannelItem
              key={channel.id}
              channel={channel}
              isSelected={selectedId === channel.id}
              onSelect={onSelect}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 16,
    paddingTop: 52,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.label,
  },
  list: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 14,
    color: colors.secondaryLabel,
  },
});
