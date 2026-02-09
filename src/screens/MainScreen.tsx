import React, {useCallback} from 'react';
import {View, StyleSheet} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {ChannelList} from '../components/ChannelList';
import {ChatView} from '../components/ChatView';
import {MessageInput} from '../components/MessageInput';
import {GlassView} from '../components/GlassView';
import {GlassContainerView} from '../components/GlassContainerView';

interface MainScreenProps {
  onSendMessage: (channelId: string, text: string) => void;
  onSelectChannel: (channelId: string) => void;
}

export function MainScreen({onSendMessage, onSelectChannel}: MainScreenProps) {
  const channels = useSignalStore(state => state.channels);
  const selectedChannelId = useSignalStore(state => state.selectedChannelId);
  const messages = useSignalStore(state => state.messages);
  const setSelectedChannelId = useSignalStore(state => state.setSelectedChannelId);

  const selectedChannel = channels.find(c => c.id === selectedChannelId) || null;
  const channelMessages = selectedChannelId ? messages[selectedChannelId] || [] : [];

  const handleSelectChannel = useCallback(
    (id: string) => {
      setSelectedChannelId(id);
      onSelectChannel(id);
    },
    [setSelectedChannelId, onSelectChannel],
  );

  const handleSendMessage = useCallback(
    (text: string) => {
      if (selectedChannelId) {
        onSendMessage(selectedChannelId, text);
      }
    },
    [selectedChannelId, onSendMessage],
  );

  return (
    <View style={styles.container}>
      {/* Chat area fills behind sidebar and input */}
      <View style={styles.chatArea}>
        <ChatView
          channel={selectedChannel}
          messages={channelMessages}
        />
      </View>

      {/* Glass sidebar overlay */}
      <GlassView style={styles.sidebar} cornerRadius={16}>
        <ChannelList
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={handleSelectChannel}
        />
      </GlassView>

      {/* Glass input bar floating at bottom over chat area */}
      {selectedChannel && (
        <GlassContainerView style={styles.inputContainer}>
          <MessageInput onSend={handleSendMessage} />
        </GlassContainerView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  chatArea: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 292,
    right: 0,
  },
  sidebar: {
    position: 'absolute',
    top: 12,
    bottom: 12,
    left: 12,
    width: 268,
    borderRadius: 16,
    overflow: 'hidden',
  },
  inputContainer: {
    position: 'absolute',
    bottom: 0,
    left: 292,
    right: 0,
  },
});
