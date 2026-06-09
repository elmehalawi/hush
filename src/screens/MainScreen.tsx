import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, StyleSheet, PanResponder, NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {ChannelList} from '../components/ChannelList';
import {ChatView} from '../components/ChatView';
import {MessageInput, MessageInputHandle} from '../components/MessageInput';
import {GlassContainerView} from '../components/GlassContainerView';
import {DropTargetView} from '../components/DropTargetView';
import {SessionsModal} from '../components/SessionsModal';
import {colors} from '../theme/colors';

const {CommandPaletteModule, PresageModule} = NativeModules;
const emitter = CommandPaletteModule
  ? new NativeEventEmitter(CommandPaletteModule)
  : null;
const presageEmitter = PresageModule
  ? new NativeEventEmitter(PresageModule)
  : null;

const SIDEBAR_DEFAULT = 268;
const SIDEBAR_MIN = 100;
const SIDEBAR_MAX = 500;
const COLLAPSE_THRESHOLD = 120;

interface MainScreenProps {
  onSendMessage: (channelId: string, text: string, attachmentPaths?: string[]) => void;
  onSelectChannel: (channelId: string) => void;
  onReact?: (channelId: string, emoji: string, targetTimestamp: number, remove: boolean) => void;
  onRetryDownload?: (channelId: string, messageId: string, attachmentIndex: number) => void;
}

export function MainScreen({onSendMessage, onSelectChannel, onReact, onRetryDownload}: MainScreenProps) {
  const channels = useSignalStore(state => state.channels);
  const selectedChannelId = useSignalStore(state => state.selectedChannelId);
  const messages = useSignalStore(state => state.messages);
  const setSelectedChannelId = useSignalStore(state => state.setSelectedChannelId);

  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [settingsVisible, setSettingsVisible] = useState(false);
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
  const chatLeft = sidebarWidth + 1; // 1px for separator line

  const handleSelectChannel = useCallback(
    (id: string) => {
      setSelectedChannelId(id);
      onSelectChannel(id);
    },
    [setSelectedChannelId, onSelectChannel],
  );

  const handleSendMessage = useCallback(
    (text: string, attachmentPaths?: string[]) => {
      if (selectedChannelId) {
        onSendMessage(selectedChannelId, text, attachmentPaths);
      }
    },
    [selectedChannelId, onSendMessage],
  );

  // Listen for "Sessions..." menu item from macOS app menu
  useEffect(() => {
    if (!presageEmitter) return;
    const sub = presageEmitter.addListener('onOpenSessions', () => {
      setSettingsVisible(true);
    });
    return () => sub.remove();
  }, []);

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
      <DropTargetView
        style={[styles.chatArea, {left: chatLeft}]}
        onFileDrop={(paths) => inputRef.current?.addFiles(paths)}>
        <ChatView
          channel={selectedChannel}
          messages={channelMessages}
          onReact={onReact}
          onRetryDownload={onRetryDownload}
        />
      </DropTargetView>

      {/* Edge-to-edge sidebar */}
      <View style={[styles.sidebar, {width: sidebarWidth}]}>
        <ChannelList
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={handleSelectChannel}
          collapsed={collapsed}
        />
      </View>

      {/* Sidebar separator */}
      <View style={[styles.sidebarSeparator, {left: sidebarWidth}]} />

      {/* Resize handle */}
      <View
        {...panResponder.panHandlers}
        style={[styles.resizeHandle, {left: sidebarWidth - 4}]}
      />

      {/* Glass input bar floating at bottom over chat area */}
      {selectedChannel && (
        <GlassContainerView style={[styles.inputContainer, {left: chatLeft}]}>
          <MessageInput ref={inputRef} onSend={handleSendMessage} />
        </GlassContainerView>
      )}

      <SessionsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
      />
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
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.sidebarBackground,
  },
  sidebarSeparator: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: colors.sidebarSeparator,
    zIndex: 5,
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
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
