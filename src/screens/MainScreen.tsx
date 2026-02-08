import React, {useCallback} from 'react';
import {View, StyleSheet} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {ChannelList} from '../components/ChannelList';
import {ChatView} from '../components/ChatView';

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
      <View style={styles.sidebar}>
        <ChannelList
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={handleSelectChannel}
        />
      </View>
      <View style={styles.main}>
        <ChatView
          channel={selectedChannel}
          messages={channelMessages}
          onSendMessage={handleSendMessage}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebar: {
    width: 280,
  },
  main: {
    flex: 1,
  },
});
