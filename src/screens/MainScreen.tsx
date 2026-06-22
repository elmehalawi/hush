import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, StyleSheet, PanResponder, NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useSignalStore, resolveContactName} from '../store/signalStore';
import {ChannelList} from '../components/ChannelList';
import {ChatView} from '../components/ChatView';
import {MessageInput, MessageInputHandle, ReplyingTo} from '../components/MessageInput';
import {GlassContainerView} from '../components/GlassContainerView';
import {DropTargetView} from '../components/DropTargetView';
import {CallScreen} from '../components/CallScreen';
import {SessionsModal} from '../components/SessionsModal';
import {useColors} from '../theme/colors';

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

interface LinkPreviewSendData {
  url: string;
  title?: string;
  description?: string;
  imagePath?: string;
  date?: number;
}

interface MainScreenProps {
  onSendMessage: (channelId: string, text: string, attachmentPaths?: string[], linkPreviews?: LinkPreviewSendData[], replyingTo?: ReplyingTo) => void;
  onSelectChannel: (channelId: string) => void;
  onReact?: (channelId: string, emoji: string, targetTimestamp: number, remove: boolean) => void;
  onRetryDownload?: (channelId: string, messageId: string, attachmentIndex: number) => void;
  onUnlink?: () => void;
  onStartCall?: (channelId: string, isVideo: boolean) => void;
  onAcceptCall?: (callId: number) => void;
  onHangupCall?: () => void;
  onToggleCallMute?: (muted: boolean) => void;
}

export function MainScreen({onSendMessage, onSelectChannel, onReact, onRetryDownload, onUnlink, onStartCall, onAcceptCall, onHangupCall, onToggleCallMute}: MainScreenProps) {
  const c = useColors();
  const channels = useSignalStore(state => state.channels);
  const selectedChannelId = useSignalStore(state => state.selectedChannelId);
  const messages = useSignalStore(state => state.messages);
  const userId = useSignalStore(state => state.userId);
  const activeCall = useSignalStore(state => state.activeCall);
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
    (text: string, attachmentPaths?: string[], linkPreviews?: LinkPreviewSendData[], replyingTo?: ReplyingTo) => {
      if (selectedChannelId) {
        onSendMessage(selectedChannelId, text, attachmentPaths, linkPreviews, replyingTo);
      }
    },
    [selectedChannelId, onSendMessage],
  );

  const handleReply = useCallback(
    (message: import('../store/signalStore').Message) => {
      const channelMsgs = messages[message.channelId] || [];
      const authorName = resolveContactName(message.senderId, userId, channels, channelMsgs)
        || message.senderId;
      inputRef.current?.setReplyingTo({
        id: message.timestamp,
        authorId: message.senderId,
        authorName,
        text: message.body,
      });
    },
    [channels, messages, userId],
  );

  // Listen for "Sessions..." menu item from macOS app menu
  useEffect(() => {
    if (!presageEmitter) return;
    const sub = presageEmitter.addListener('onOpenSessions', () => {
      setSettingsVisible(true);
    });
    return () => sub.remove();
  }, []);

  // Listen for Reply from native context menu
  useEffect(() => {
    if (!presageEmitter) return;
    const sub = presageEmitter.addListener('onReplyToMessage', (data: {id: number; authorId: string; authorName: string; text: string}) => {
      inputRef.current?.setReplyingTo({
        id: data.id,
        authorId: data.authorId,
        authorName: data.authorName,
        text: data.text || undefined,
      });
    });
    return () => sub.remove();
  }, []);

  // Listen for emoji reaction from native context menu
  useEffect(() => {
    if (!presageEmitter || !onReact) return;
    const sub = presageEmitter.addListener('onContextMenuReaction', (data: {channelId: string; emoji: string; targetTimestamp: number; remove: boolean}) => {
      onReact(data.channelId, data.emoji, data.targetTimestamp, data.remove);
    });
    return () => sub.remove();
  }, [onReact]);

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
          onReply={handleReply}
          onRetryDownload={onRetryDownload}
          onStartCall={onStartCall}
        />
      </DropTargetView>

      {/* Edge-to-edge sidebar */}
      <View style={[styles.sidebar, {width: sidebarWidth, backgroundColor: c.sidebarBackground}]}>
        <ChannelList
          channels={channels}
          selectedId={selectedChannelId}
          onSelect={handleSelectChannel}
          collapsed={collapsed}
        />
      </View>

      {/* Sidebar separator */}
      <View style={[styles.sidebarSeparator, {left: sidebarWidth, backgroundColor: c.sidebarSeparator}]} />

      {/* Resize handle */}
      <View
        {...panResponder.panHandlers}
        style={[styles.resizeHandle, {left: sidebarWidth - 4}]}
      />

      {/* Glass input bar floating at bottom over chat area */}
      {selectedChannel && (
        <GlassContainerView style={[styles.inputContainer, {left: chatLeft}]}>
          <MessageInput ref={inputRef} onSend={handleSendMessage} channelId={selectedChannelId} />
        </GlassContainerView>
      )}

      <SessionsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onUnlink={onUnlink}
      />

      {activeCall && onAcceptCall && onHangupCall && onToggleCallMute && (
        <CallScreen
          activeCall={activeCall}
          onAccept={onAcceptCall}
          onHangup={onHangupCall}
          onToggleMute={onToggleCallMute}
        />
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
    top: 0,
    bottom: 0,
    left: 0,
  },
  sidebarSeparator: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
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
