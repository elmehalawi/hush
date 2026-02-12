import React, {useRef, useEffect} from 'react';
import {View, ScrollView, Text, StyleSheet, Image, useColorScheme} from 'react-native';
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
  useColorScheme(); // subscribe to appearance changes so DynamicColorMacOS values update
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
            <MessageBubble key={message.id} message={message} isGroup={channel.isGroup} />
          ))
        )}
      </ScrollView>

      {/* Gradient blur overlay at top - mimics Tahoe Messages */}
      <GradientBlurView style={styles.topBlur} />

      {/* Small glass pill header */}
      <View style={styles.headerPillContainer} pointerEvents="none">
        <View style={styles.headerPillWrapper}>
          <View style={styles.pillAvatar}>
            {channel.avatarPath ? (
              <Image
                source={{uri: `file://${channel.avatarPath}`}}
                style={styles.pillAvatarImage}
              />
            ) : (
              <>
                <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} tintColor="rgba(30, 120, 255, 0.45)" />
                <Text style={styles.pillAvatarText}>{initial}</Text>
              </>
            )}
          </View>
          <View style={styles.headerPill}>
            <GlassView style={StyleSheet.absoluteFill} cornerRadius={20} />
            <Text style={styles.pillName} numberOfLines={1}>
              {channel.name}
            </Text>
          </View>
        </View>
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
    paddingTop: 80,
    paddingBottom: 80,
  },
  topBlur: {
    position: 'absolute',
    top: 0,
    left: -292,
    right: 0,
    height: 80,
  },
  headerPillContainer: {
    position: 'absolute',
    top: 12,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  headerPillWrapper: {
    alignItems: 'center',
  },
  headerPill: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 20,
    marginTop: -6,
  },
  pillAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  pillAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  pillAvatarText: {
    color: 'white',
    fontSize: 17,
    fontWeight: '600',
  },
  pillName: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.label,
    textAlign: 'center',
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
