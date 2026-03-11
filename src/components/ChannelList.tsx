import React, {useMemo, useCallback} from 'react';
import {View, FlatList, Text, StyleSheet, useColorScheme} from 'react-native';
import {Channel} from '../store/signalStore';
import {ChannelItem} from './ChannelItem';
import {GradientBlurView} from './GradientBlurView';
import {colors} from '../theme/colors';

interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
}

const channelKeyExtractor = (item: Channel) => item.id;

export function ChannelList({channels, selectedId, onSelect, collapsed}: ChannelListProps) {
  useColorScheme(); // subscribe to appearance changes so DynamicColorMacOS values update
  const sorted = useMemo(
    () => [...channels].sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)),
    [channels],
  );

  const renderItem = useCallback(
    ({item}: {item: Channel}) => (
      <ChannelItem
        channel={item}
        isSelected={selectedId === item.id}
        onSelect={onSelect}
        collapsed={collapsed}
      />
    ),
    [selectedId, onSelect, collapsed],
  );

  return (
    <View style={styles.container}>
      <FlatList
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          collapsed && styles.listContentCollapsed,
        ]}
        data={sorted}
        keyExtractor={channelKeyExtractor}
        showsHorizontalScrollIndicator={false}
        renderItem={renderItem}
        maxToRenderPerBatch={15}
        windowSize={5}
        ListEmptyComponent={
          <View style={styles.empty}>
            {!collapsed && (
              <Text style={styles.emptyText}>No conversations yet</Text>
            )}
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
    borderRadius: 20,
    overflow: 'hidden',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 20,
    paddingHorizontal: 8,
  },
  listContentCollapsed: {
    paddingHorizontal: 4,
    alignItems: 'center',
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
