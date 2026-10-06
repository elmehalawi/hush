import React from 'react';
import {View, Text, StyleSheet} from 'react-native';

/** Small corner label naming the site media fetched from a link came from. */
export function SourceBadge({source}: {source: string}) {
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{source}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  text: {
    color: 'white',
    fontSize: 10,
    fontWeight: '600',
  },
});
