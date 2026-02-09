import React, {useRef, useEffect} from 'react';
import {View, ScrollView, Text, StyleSheet} from 'react-native';
import {Message, Channel} from '../store/signalStore';
import {MessageBubble} from './MessageBubble';
import {colors} from '../theme/colors';

interface ChatViewProps {
  channel: Channel | null;
  messages: Message[];
}

export function ChatView({channel, messages}: ChatViewProps) {
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    scrollViewRef.current?.scrollToEnd({animated: true});
  }, [messages.length]);

  if (!channel) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Select a conversation to start messaging</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {channel.isGroup ? '#' : channel.name.charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>{channel.name}</Text>
          <Text style={styles.headerSubtitle}>
            {channel.isGroup ? 'Group' : 'Direct Message'}
          </Text>
        </View>
      </View>

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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingTop: 52,
    backgroundColor: 'transparent',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#2196f3',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.label,
  },
  headerSubtitle: {
    fontSize: 12,
    color: colors.secondaryLabel,
  },
  messages: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  messagesContent: {
    paddingVertical: 8,
    paddingBottom: 80,
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
