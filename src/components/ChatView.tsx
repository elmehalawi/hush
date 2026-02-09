import React, {useRef, useEffect} from 'react';
import {View, ScrollView, Text, StyleSheet} from 'react-native';
import {Message, Channel} from '../store/signalStore';
import {MessageBubble} from './MessageBubble';
import {GlassView} from './GlassView';
import {GradientBlurView} from './GradientBlurView';
import {colors} from '../theme/colors';

interface ChatViewProps {
  channel: Channel | null;
  messages: Message[];
}

export function ChatView({channel, messages}: ChatViewProps) {
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({animated: true});
  }, [messages.length]);

  if (!channel) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Select a conversation to start messaging</Text>
      </View>
    );
  }

  const initial = channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase();

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 ? (
          <View style={styles.noMessages}>
            <Text style={styles.noMessagesText}>No messages yet</Text>
            <Text style={styles.noMessagesHint}>Send a message to start the conversation</Text>
          </View>
        ) : (
          messages.map(message => (
            <MessageBubble key={message.id} message={message} />
          ))
        )}
      </ScrollView>

      {/* Gradient blur overlay at top - mimics Tahoe Messages */}
      <GradientBlurView style={styles.topBlur} />

      {/* Small glass pill header */}
      <View style={styles.headerPillContainer} pointerEvents="none">
        <GlassView style={styles.headerPill} cornerRadius={16}>
          <View style={styles.pillAvatar}>
            <Text style={styles.pillAvatarText}>{initial}</Text>
          </View>
          <Text style={styles.pillName} numberOfLines={1}>
            {channel.name}
          </Text>
        </GlassView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  emptyText: {
    fontSize: 16,
    color: colors.secondaryLabel,
  },
  messages: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  messagesContent: {
    paddingTop: 110,
    paddingBottom: 80,
  },
  topBlur: {
    position: 'absolute',
    top: 0,
    left: -292,
    right: 0,
    height: 110,
  },
  headerPillContainer: {
    position: 'absolute',
    top: 12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  headerPill: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  pillAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#2196f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  pillAvatarText: {
    color: 'white',
    fontSize: 11,
    fontWeight: '600',
  },
  pillName: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.label,
  },
  noMessages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  noMessagesText: {
    fontSize: 15,
    color: colors.secondaryLabel,
  },
  noMessagesHint: {
    fontSize: 13,
    color: colors.tertiaryLabel,
    marginTop: 4,
  },
});
