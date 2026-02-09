import React, {useMemo} from 'react';
import {View, FlatList, Text, StyleSheet} from 'react-native';
import {Channel} from '../store/signalStore';
import {ChannelItem} from './ChannelItem';
import {GradientBlurView} from './GradientBlurView';
import {colors} from '../theme/colors';

interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ChannelList({channels, selectedId, onSelect}: ChannelListProps) {
  const sorted = useMemo(
    () => [...channels].sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)),
    [channels],
  );

  return (
    <View style={styles.container}>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={sorted}
        keyExtractor={item => item.id}
        showsHorizontalScrollIndicator={false}
        renderItem={({item}) => (
          <ChannelItem
            channel={item}
            isSelected={selectedId === item.id}
            onSelect={onSelect}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No conversations yet</Text>
          </View>
        }
      />
      <GradientBlurView style={styles.topBlur} blurRadius={2} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 20,
    paddingHorizontal: 8,
  },
  topBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 32,
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
