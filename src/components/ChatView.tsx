import React, {useRef, useEffect} from 'react';
import {View, ScrollView, Text, StyleSheet} from 'react-native';
import {Message, Channel} from '../store/signalStore';
import {MessageBubble} from './MessageBubble';
import {MessageInput} from './MessageInput';

interface ChatViewProps {
  channel: Channel | null;
  messages: Message[];
  onSendMessage: (text: string) => void;
}

export function ChatView({channel, messages, onSendMessage}: ChatViewProps) {
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

      <MessageInput onSend={onSendMessage} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fafafa',
  },
  emptyText: {
    fontSize: 16,
    color: '#757575',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
    backgroundColor: '#ffffff',
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
    color: '#212121',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#757575',
  },
  messages: {
    flex: 1,
    backgroundColor: '#fafafa',
  },
  messagesContent: {
    paddingVertical: 8,
  },
  noMessages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
  },
  noMessagesText: {
    fontSize: 15,
    color: '#757575',
  },
  noMessagesHint: {
    fontSize: 13,
    color: '#9e9e9e',
    marginTop: 4,
  },
});
