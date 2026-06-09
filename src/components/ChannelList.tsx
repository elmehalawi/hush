import React, {useMemo, useState} from 'react';
import {View, FlatList, Text, TextInput, StyleSheet, useColorScheme} from 'react-native';
import {Channel} from '../store/signalStore';
import {ChannelItem} from './ChannelItem';
import {colors} from '../theme/colors';

interface ChannelListProps {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
}

export function ChannelList({channels, selectedId, onSelect, collapsed}: ChannelListProps) {
  const isDark = useColorScheme() === 'dark';
  const [searchText, setSearchText] = useState('');

  const sorted = useMemo(
    () => [...channels].sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0)),
    [channels],
  );

  const filtered = useMemo(() => {
    if (!searchText.trim()) return sorted;
    const query = searchText.toLowerCase();
    return sorted.filter(c => c.name.toLowerCase().includes(query));
  }, [sorted, searchText]);

  return (
    <View style={styles.container}>
      {!collapsed && (
        <View style={styles.searchContainer}>
          <View style={styles.searchField}>
            <Text style={styles.searchIcon}>⌕</Text>
            <TextInput
              style={[styles.searchInput, isDark && {color: '#EBEBF0'}]}
              value={searchText}
              onChangeText={setSearchText}
              placeholder="Search"
              placeholderTextColor={isDark ? '#EBEBF04D' : '#9e9e9e'}
            />
          </View>
        </View>
      )}
      <FlatList
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          collapsed && styles.listContentCollapsed,
        ]}
        data={filtered}
        keyExtractor={item => item.id}
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
              <Text style={styles.emptyText}>
                {searchText.trim() ? 'No results' : 'No conversations yet'}
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    paddingTop: 52,
    paddingHorizontal: 10,
    paddingBottom: 4,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.searchFieldBackground,
    borderRadius: 8,
    paddingHorizontal: 8,
    height: 28,
  },
  searchIcon: {
    fontSize: 14,
    color: colors.tertiaryLabel,
    marginRight: 4,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.label,
    padding: 0,
    backgroundColor: 'transparent',
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 4,
    paddingHorizontal: 10,
  },
  listContentCollapsed: {
    paddingTop: 52,
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
    color: colors.secondaryLabel,
  },
});
