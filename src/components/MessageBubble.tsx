import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import {Message} from '../store/signalStore';
import {colors} from '../theme/colors';

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({message}: MessageBubbleProps) {
  const isOutgoing = message.isOutgoing;

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  };

  const getStatusIcon = () => {
    switch (message.status) {
      case 'sending':
        return '\u23F3'; // hourglass
      case 'sent':
        return '\u2713'; // single check
      case 'delivered':
        return '\u2713\u2713'; // double check
      case 'read':
        return '\u2713\u2713'; // double check (would be blue in color)
      case 'failed':
        return '\u26A0'; // warning
      default:
        return '';
    }
  };

  return (
    <View
      style={[
        styles.container,
        isOutgoing ? styles.outgoing : styles.incoming,
      ]}>
      {!isOutgoing && message.senderName && (
        <Text style={styles.senderName}>{message.senderName}</Text>
      )}
      <View
        style={[
          styles.bubble,
          isOutgoing ? styles.bubbleOutgoing : styles.bubbleIncoming,
        ]}>
        <Text style={[styles.body, isOutgoing && styles.bodyOutgoing]}>
          {message.body || '[No content]'}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.time, isOutgoing && styles.timeOutgoing]}>
            {formatTime(message.timestamp)}
          </Text>
          {isOutgoing && (
            <Text
              style={[
                styles.status,
                message.status === 'read' && styles.statusRead,
              ]}>
              {getStatusIcon()}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 2,
    paddingHorizontal: 8,
  },
  outgoing: {
    alignItems: 'flex-end',
  },
  incoming: {
    alignItems: 'flex-start',
  },
  senderName: {
    fontSize: 12,
    color: '#2196f3',
    fontWeight: '500',
    marginBottom: 2,
    marginLeft: 12,
  },
  bubble: {
    maxWidth: '75%',
    padding: 10,
    borderRadius: 16,
  },
  bubbleOutgoing: {
    backgroundColor: '#2196f3',
    borderBottomRightRadius: 4,
  },
  bubbleIncoming: {
    backgroundColor: colors.incomingBubble,
    borderBottomLeftRadius: 4,
  },
  body: {
    fontSize: 15,
    color: colors.incomingBody,
  },
  bodyOutgoing: {
    color: 'white',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  time: {
    fontSize: 11,
    color: '#757575',
  },
  timeOutgoing: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  status: {
    fontSize: 12,
    marginLeft: 4,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  statusRead: {
    color: '#4fc3f7',
  },
});
