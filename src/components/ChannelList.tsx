import React, {useMemo} from 'react';
import {View, FlatList, Text, StyleSheet} from 'react-native';
import {Channel} from '../store/signalStore';
import {ChannelItem} from './ChannelItem';
import {GradientBlurView} from './GradientBlurView';
import {useColors} from '../theme/colors';

interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
}

const BLUR_HEIGHT = 42;

export function ChannelList({channels, selectedId, onSelect, collapsed}: ChannelListProps) {
  const c = useColors();
  const sorted = useMemo(
    () => [...channels].sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)),
    [channels],
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
        keyExtractor={item => item.id}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        renderItem={({item}) => (
          <ChannelItem
            channel={item}
            isSelected={selectedId === item.id}
            onSelect={onSelect}
            collapsed={collapsed}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            {!collapsed && (
              <Text style={[styles.emptyText, {color: c.secondaryLabel}]}>No conversations yet</Text>
            )}
          </View>
        }
      />
      <GradientBlurView style={styles.topBlur} />
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
    paddingTop: 0,
    paddingHorizontal: 10,
  },
  listContentCollapsed: {
    paddingTop: 0,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  emptyText: {
    fontSize: 14,
  },
  topBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: BLUR_HEIGHT,
  },
});
