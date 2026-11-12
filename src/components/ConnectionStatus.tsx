import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, ActivityIndicator} from 'react-native';
import {ConnectionState, useSignalStore} from '../store/signalStore';
import {useColors} from '../theme/colors';

// A healthy connect/catch-up takes well under a second; only say something if
// it's dragging, so a good connection never flickers a status line.
const SHOW_DELAY_MS = 1000;

const LABELS: Record<Exclude<ConnectionState, 'connected'>, string> = {
  connecting: 'Connecting…',
  syncing: 'Checking for messages…',
  offline: 'Offline · reconnecting…',
};

/**
 * Footer for the sidebar saying what the connection to Signal is doing, the
 * way Mail shows "Checking for mail…". Without it, a slow or dead connection
 * looks exactly like having no new messages.
 */
export function ConnectionStatus({collapsed}: {collapsed?: boolean}) {
  const c = useColors();
  const state = useSignalStore(s => s.connectionState);
  const [visible, setVisible] = useState(false);
  // While offline, the receive loop keeps cycling through reconnect attempts.
  // Those are still "offline" to the user until one actually gets through.
  const offlineRef = useRef(false);
  if (state === 'offline') offlineRef.current = true;
  if (state === 'syncing' || state === 'connected') offlineRef.current = false;
  const offline = offlineRef.current;

  useEffect(() => {
    if (state === 'connected') {
      setVisible(false);
      return;
    }
    if (offline) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, offline]);

  if (!visible || state === 'connected') return null;

  return (
    <View style={[styles.container, collapsed && styles.containerCollapsed]}>
      {state === 'offline' ? (
        <View style={styles.offlineDot} />
      ) : (
        <ActivityIndicator size="small" color={c.secondaryLabel} style={styles.spinner} />
      )}
      {!collapsed && (
        <Text style={[styles.label, {color: c.secondaryLabel}]} numberOfLines={1}>
          {offline ? LABELS.offline : LABELS[state]}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  containerCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  spinner: {
    transform: [{scale: 0.7}],
    width: 16,
    height: 16,
  },
  offlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
    backgroundColor: '#FF9F0A',
  },
  label: {
    fontSize: 12,
    marginLeft: 6,
  },
});
