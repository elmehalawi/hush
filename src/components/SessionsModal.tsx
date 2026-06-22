import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  NativeModules,
  ActivityIndicator,
} from 'react-native';
import {GlassView} from './GlassView';
import {useColors} from '../theme/colors';

const {PresageModule} = NativeModules;

interface SessionEntry {
  address: string;
  deviceCount: number;
  contactName: string | null;
}

interface SessionsModalProps {
  visible: boolean;
  onClose: () => void;
  onUnlink?: () => void;
}

export function SessionsModal({visible, onClose, onUnlink}: SessionsModalProps) {
  const c = useColors();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!PresageModule) return;
    setLoading(true);
    try {
      const result = await PresageModule.getAllSessions();
      setSessions(result);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      loadSessions();
    }
  }, [visible, loadSessions]);

  const handleUnlink = useCallback(async () => {
    if (!onUnlink) return;
    setUnlinking(true);
    try {
      onUnlink();
      onClose();
    } finally {
      setUnlinking(false);
    }
  }, [onUnlink, onClose]);

  const handleReset = useCallback(async (address: string) => {
    if (!PresageModule) return;
    setResettingId(address);
    try {
      await PresageModule.resetSession(address);
      // Reload sessions to reflect the change
      await loadSessions();
    } catch (error) {
      console.error('Failed to reset session:', error);
    } finally {
      setResettingId(null);
    }
  }, [loadSessions]);

  if (!visible) return null;

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.modalContainer} onPress={e => e.stopPropagation()}>
        <GlassView style={StyleSheet.absoluteFill} cornerRadius={16} />
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={[styles.title, {color: c.label}]}>Sessions</Text>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>
          <Text style={[styles.description, {color: c.secondaryLabel}]}>
            Encryption sessions with your contacts. Reset a session if messages
            aren't decrypting correctly.
          </Text>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {loading ? (
              <ActivityIndicator style={styles.loader} color="rgba(255,255,255,0.5)" />
            ) : sessions.length === 0 ? (
              <Text style={[styles.emptyText, {color: c.tertiaryLabel}]}>No sessions found</Text>
            ) : (
              sessions.map(session => (
                <View key={session.address} style={styles.sessionRow}>
                  <View style={styles.sessionInfo}>
                    <Text style={[styles.sessionName, {color: c.label}]} numberOfLines={1}>
                      {session.contactName || 'Unknown'}
                    </Text>
                    <Text style={[styles.sessionAddress, {color: c.tertiaryLabel}]} numberOfLines={1}>
                      {session.address}
                    </Text>
                    <Text style={[styles.sessionDevices, {color: c.secondaryLabel}]}>
                      {session.deviceCount} device{session.deviceCount !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  <Pressable
                    style={({pressed}) => [
                      styles.resetButton,
                      pressed && styles.resetButtonPressed,
                      resettingId === session.address && styles.resetButtonDisabled,
                    ]}
                    onPress={() => handleReset(session.address)}
                    disabled={resettingId === session.address}>
                    {resettingId === session.address ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text style={styles.resetText}>Reset</Text>
                    )}
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
          {onUnlink && (
            <Pressable
              style={({pressed}) => [
                styles.unlinkButton,
                pressed && styles.unlinkButtonPressed,
                unlinking && styles.resetButtonDisabled,
              ]}
              onPress={handleUnlink}
              disabled={unlinking}>
              {unlinking ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Text style={styles.unlinkText}>Unlink Device</Text>
              )}
            </Pressable>
          )}
        </View>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  modalContainer: {
    width: 420,
    maxHeight: 540,
    borderRadius: 16,
    overflow: 'hidden',
  },
  content: {
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
  },
  closeButton: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
  },
  closeText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#4A9EFF',
  },
  description: {
    fontSize: 12,
    marginBottom: 16,
    lineHeight: 16,
  },
  list: {
    maxHeight: 320,
  },
  loader: {
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 40,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  sessionInfo: {
    flex: 1,
    minWidth: 0,
    marginRight: 12,
  },
  sessionName: {
    fontSize: 14,
    fontWeight: '500',
  },
  sessionAddress: {
    fontSize: 10,
    fontFamily: 'Menlo',
    marginTop: 2,
  },
  sessionDevices: {
    fontSize: 11,
    marginTop: 2,
  },
  resetButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 59, 48, 0.2)',
    minWidth: 60,
    alignItems: 'center',
  },
  resetButtonPressed: {
    backgroundColor: 'rgba(255, 59, 48, 0.4)',
  },
  resetButtonDisabled: {
    opacity: 0.5,
  },
  resetText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FF6B6B',
  },
  unlinkButton: {
    marginTop: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 59, 48, 0.25)',
    alignItems: 'center',
  },
  unlinkButtonPressed: {
    backgroundColor: 'rgba(255, 59, 48, 0.45)',
  },
  unlinkText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FF453A',
  },
});
