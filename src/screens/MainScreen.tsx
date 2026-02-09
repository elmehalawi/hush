import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, StyleSheet, PanResponder, NativeModules, NativeEventEmitter} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {ChannelList} from '../components/ChannelList';
import {ChatView} from '../components/ChatView';
import {MessageInput, MessageInputHandle} from '../components/MessageInput';
import {GlassView} from '../components/GlassView';
import {GlassContainerView} from '../components/GlassContainerView';

const {CommandPaletteModule} = NativeModules;
const emitter = CommandPaletteModule
  ? new NativeEventEmitter(CommandPaletteModule)
  : null;

const SIDEBAR_DEFAULT = 268;
const SIDEBAR_MIN = 100;
const SIDEBAR_MAX = 500;
const SIDEBAR_MARGIN = 12;
const COLLAPSE_THRESHOLD = 120;

interface MainScreenProps {
  onSendMessage: (channelId: string, text: string) => void;
  onSelectChannel: (channelId: string) => void;
}

export function MainScreen({onSendMessage, onSelectChannel}: MainScreenProps) {
  const channels = useSignalStore(state => state.channels);
  const selectedChannelId = useSignalStore(state => state.selectedChannelId);
  const messages = useSignalStore(state => state.messages);
  const setSelectedChannelId = useSignalStore(state => state.setSelectedChannelId);

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const startWidthRef = useRef(SIDEBAR_DEFAULT);
  const currentWidthRef = useRef(SIDEBAR_DEFAULT);
  const inputRef = useRef<MessageInputHandle>(null);

  const selectedChannel = channels.find(c => c.id === selectedChannelId) || null;
  const channelMessages = selectedChannelId ? messages[selectedChannelId] || [] : [];

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startWidthRef.current = currentWidthRef.current;
      },
      onPanResponderMove: (_, gestureState) => {
        const newWidth = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startWidthRef.current + gestureState.dx),
        );
        currentWidthRef.current = newWidth;
        setSidebarWidth(newWidth);
      },
    }),
  ).current;

  const collapsed = sidebarWidth < COLLAPSE_THRESHOLD;
  const chatLeft = sidebarWidth + SIDEBAR_MARGIN * 2;

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

  // Channel navigation shortcut handler
  useEffect(() => {
    if (!emitter) return;

    const navSub = emitter.addListener(
      'onNavigateChannel',
      (event: {direction: string}) => {
        const sorted = useSignalStore.getState().channels
          .slice()
          .sort((a, b) => (b.lastMessageTimestamp ?? 0) - (a.lastMessageTimestamp ?? 0));
        if (sorted.length === 0) return;

        const currentId = useSignalStore.getState().selectedChannelId;
        const currentIndex = currentId ? sorted.findIndex(c => c.id === currentId) : -1;

        let nextIndex: number;
        if (currentIndex === -1) {
          nextIndex = 0;
        } else if (event.direction === 'next') {
          nextIndex = Math.min(currentIndex + 1, sorted.length - 1);
        } else {
          nextIndex = Math.max(currentIndex - 1, 0);
        }

        const nextChannel = sorted[nextIndex];
        setSelectedChannelId(nextChannel.id);
        onSelectChannel(nextChannel.id);
      },
    );

    const letterSub = emitter.addListener(
      'onLetterTyped',
      (event: {letter: string}) => {
        inputRef.current?.insertText(event.letter);
      },
    );

    return () => {
      navSub.remove();
      letterSub.remove();
    };
  }, [setSelectedChannelId, onSelectChannel]);

  return (
    <View style={styles.container}>
      {/* Chat area fills behind sidebar and input */}
      <View style={[styles.chatArea, {left: chatLeft}]}>
        <ChatView
          channel={selectedChannel}
          messages={channelMessages}
        />
      </View>

      {/* Glass sidebar overlay */}
      <GlassView
        style={[styles.sidebar, {width: sidebarWidth}]}
        cornerRadius={26}>
        <ChannelList
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={handleSelectChannel}
          collapsed={collapsed}
        />
      </GlassView>

      {/* Resize handle */}
      <View
        {...panResponder.panHandlers}
        style={[styles.resizeHandle, {left: sidebarWidth + SIDEBAR_MARGIN - 4}]}
      />

      {/* Glass input bar floating at bottom over chat area */}
      {selectedChannel && (
        <GlassContainerView style={[styles.inputContainer, {left: chatLeft}]}>
          <MessageInput ref={inputRef} onSend={handleSendMessage} />
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
    right: 0,
  },
  sidebar: {
    position: 'absolute',
    top: 12,
    bottom: 12,
    left: 12,
  },
  resizeHandle: {
    position: 'absolute',
    top: 12,
    bottom: 12,
    width: 8,
    cursor: 'col-resize',
    zIndex: 10,
  },
  inputContainer: {
    position: 'absolute',
    bottom: 0,
    right: 0,
  },
});
