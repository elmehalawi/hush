import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Image} from 'react-native';
import {ActiveCall, Channel, useSignalStore} from '../store/signalStore';
import {GlassView} from './GlassView';
import {useColors} from '../theme/colors';

interface CallScreenProps {
  activeCall: ActiveCall;
  onAccept: (callId: number) => void;
  onHangup: () => void;
  onToggleMute: (muted: boolean) => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function statusText(status: ActiveCall['status']): string {
  switch (status) {
    case 'outgoing': return 'Calling...';
    case 'incoming': return 'Incoming Call';
    case 'ringing': return 'Ringing...';
    case 'connected': return '';
    case 'reconnecting': return 'Reconnecting...';
    case 'ended': return 'Call Ended';
    default: return '';
  }
}

export function CallScreen({activeCall, onAccept, onHangup, onToggleMute}: CallScreenProps) {
  const c = useColors();
  const channels = useSignalStore(state => state.channels);
  const [now, setNow] = useState(Date.now());

  // Timer for connected call duration
  useEffect(() => {
    if (activeCall.status !== 'connected' || !activeCall.startedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [activeCall.status, activeCall.startedAt]);

  // Resolve display name
  const channel = channels.find((ch: Channel) => ch.id === activeCall.remotePeerId);
  const displayName = channel?.name || activeCall.remotePeerId;
  const initial = displayName.charAt(0).toUpperCase();
  const avatarPath = channel?.avatarPath;

  const durationText = activeCall.status === 'connected' && activeCall.startedAt
    ? formatDuration(now - activeCall.startedAt)
    : statusText(activeCall.status);

  return (
    <View style={styles.overlay}>
      <GlassView style={StyleSheet.absoluteFill} cornerRadius={0} tintColor="rgba(0, 0, 0, 0.6)" />

      <View style={styles.content}>
        {/* Avatar */}
        <View style={styles.avatar}>
          {avatarPath ? (
            <Image source={{uri: `file://${avatarPath}`}} style={styles.avatarImage} />
          ) : (
            <>
              <GlassView style={StyleSheet.absoluteFill} cornerRadius={50} tintColor="rgba(30, 120, 255, 0.45)" />
              <Text style={styles.avatarText}>{initial}</Text>
            </>
          )}
        </View>

        {/* Name */}
        <Text style={styles.name}>{displayName}</Text>

        {/* Status / Duration */}
        <Text style={styles.status}>{durationText}</Text>

        {/* Buttons */}
        <View style={styles.buttons}>
          {/* Mute button */}
          <TouchableOpacity
            style={[styles.actionButton, activeCall.isMuted && styles.actionButtonActive]}
            onPress={() => onToggleMute(!activeCall.isMuted)}
            activeOpacity={0.7}
          >
            <GlassView style={StyleSheet.absoluteFill} cornerRadius={28} />
            <Text style={styles.actionIcon}>{activeCall.isMuted ? '\u{1F507}' : '\u{1F50A}'}</Text>
            <Text style={[styles.actionLabel, {color: c.secondaryLabel}]}>
              {activeCall.isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </TouchableOpacity>

          {/* Accept button (incoming only) */}
          {activeCall.status === 'incoming' && (
            <TouchableOpacity
              style={[styles.actionButton, styles.acceptButton]}
              onPress={() => onAccept(activeCall.callId)}
              activeOpacity={0.7}
            >
              <Text style={styles.actionIcon}>{'\u{1F4DE}'}</Text>
              <Text style={styles.acceptLabel}>Accept</Text>
            </TouchableOpacity>
          )}

          {/* End call button */}
          <TouchableOpacity
            style={[styles.actionButton, styles.endButton]}
            onPress={onHangup}
            activeOpacity={0.7}
          >
            <Text style={styles.actionIcon}>{'\u{1F4F5}'}</Text>
            <Text style={styles.endLabel}>End</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  avatarText: {
    color: 'white',
    fontSize: 40,
    fontWeight: '600',
  },
  name: {
    color: 'white',
    fontSize: 24,
    fontWeight: '600',
    marginTop: 8,
  },
  status: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 16,
    fontWeight: '400',
    minHeight: 22,
  },
  buttons: {
    flexDirection: 'row',
    gap: 24,
    marginTop: 32,
  },
  actionButton: {
    width: 56,
    height: 72,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    gap: 4,
  },
  actionButtonActive: {
    opacity: 0.7,
  },
  actionIcon: {
    fontSize: 22,
  },
  actionLabel: {
    fontSize: 10,
    fontWeight: '500',
  },
  acceptButton: {
    backgroundColor: 'rgba(52, 199, 89, 0.85)',
  },
  acceptLabel: {
    color: 'white',
    fontSize: 10,
    fontWeight: '500',
  },
  endButton: {
    backgroundColor: 'rgba(255, 59, 48, 0.85)',
  },
  endLabel: {
    color: 'white',
    fontSize: 10,
    fontWeight: '500',
  },
});
