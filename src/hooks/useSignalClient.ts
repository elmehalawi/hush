import {useEffect, useRef, useCallback} from 'react';
import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useSignalStore, Message, Channel, Attachment, Reaction, ReactionEvent} from '../store/signalStore';

// Get the native module
const {PresageModule} = NativeModules;

console.log('PresageModule available:', !!PresageModule);
console.log('NativeModules keys:', Object.keys(NativeModules));

// Create event emitter for receiving events from native
const presageEventEmitter = PresageModule
  ? new NativeEventEmitter(PresageModule)
  : null;

// Type definitions for native responses
interface NativeChannel {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageTimestamp: number | null;
  avatarPath: string | null;
}

interface NativeAttachment {
  contentType: string;
  filePath: string | null;
  fileName: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  thumbnailPath: string | null;
}

interface NativeReaction {
  emoji: string;
  senderId: string;
  targetTimestamp: number;
}

interface NativeReactionEvent {
  channelId: string;
  emoji: string;
  senderId: string;
  targetTimestamp: number;
  remove: boolean;
}

interface NativeMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string | null;
  body: string | null;
  timestamp: number;
  isOutgoing: boolean;
  status: string;
  attachments: NativeAttachment[] | null;
  reactions: NativeReaction[] | null;
}

// Convert native channel to store channel
function convertChannel(native: NativeChannel): Channel {
  return {
    id: native.id,
    name: native.name,
    isGroup: native.isGroup,
    unreadCount: native.unreadCount,
    lastMessage: native.lastMessage || undefined,
    lastMessageTimestamp: native.lastMessageTimestamp || undefined,
    avatarPath: native.avatarPath || undefined,
  };
}

// Convert native attachment to store attachment
function convertAttachment(native: NativeAttachment): Attachment {
  return {
    contentType: native.contentType,
    filePath: native.filePath || undefined,
    fileName: native.fileName || undefined,
    width: native.width || undefined,
    height: native.height || undefined,
    size: native.size || undefined,
    thumbnailPath: native.thumbnailPath || undefined,
  };
}

// Convert native reaction to store reaction
function convertReaction(native: NativeReaction): Reaction {
  return {
    emoji: native.emoji,
    senderId: native.senderId,
    targetTimestamp: native.targetTimestamp,
  };
}

// Convert native message to store message
function convertMessage(native: NativeMessage): Message {
  return {
    id: native.id,
    channelId: native.channelId,
    senderId: native.senderId,
    senderName: native.senderName || undefined,
    body: native.body || undefined,
    timestamp: native.timestamp,
    isOutgoing: native.isOutgoing,
    status: native.status as Message['status'],
    attachments: (native.attachments || []).map(convertAttachment),
    reactions: (native.reactions || []).map(convertReaction),
  };
}

// Hook for using the Signal client
export function useSignalClient() {
  const isInitialized = useRef(false);

  // Select individual actions from store — these are stable references
  const setLinkingState = useSignalStore(state => state.setLinkingState);
  const setIsLinked = useSignalStore(state => state.setIsLinked);
  const setUserId = useSignalStore(state => state.setUserId);
  const setChannels = useSignalStore(state => state.setChannels);
  const addMessage = useSignalStore(state => state.addMessage);
  const addReaction = useSignalStore(state => state.addReaction);
  const updateChannel = useSignalStore(state => state.updateChannel);
  const markChannelAsRead = useSignalStore(state => state.markChannelAsRead);

  // Initialize client
  const initialize = useCallback(async () => {
    console.log('initialize() called, PresageModule:', !!PresageModule);

    if (!PresageModule) {
      console.error('PresageModule not available');
      setLinkingState({type: 'failed', message: 'Native module not available'});
      return;
    }

    if (isInitialized.current) {
      console.log('Already initialized');
      return;
    }

    try {
      console.log('Initializing PresageModule...');
      await PresageModule.initialize();
      console.log('Initialize succeeded');
      isInitialized.current = true;

      // Check if already linked
      const linked = await PresageModule.isLinked();
      if (linked) {
        setIsLinked(true);
        try {
          const userId = await PresageModule.getUserId();
          setUserId(userId);
        } catch {
          // Ignore error getting user ID
        }

        // Load channels (with any cached avatars already on disk)
        const channels = await PresageModule.getChannels();
        setChannels(channels.map(convertChannel));

        // Fetch avatars from network in background, then refresh channels
        PresageModule.fetchAllAvatars()
          .then(async () => {
            try {
              const updated = await PresageModule.getChannels();
              setChannels(updated.map(convertChannel));
            } catch {
              // Ignore refresh error
            }
          })
          .catch(() => {
            // Avatar fetch is best-effort
          });
      }
    } catch (error) {
      console.error('Failed to initialize Signal client:', error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start device linking
  const startLinking = useCallback(
    async (deviceName: string) => {
      console.warn('startLinking called, PresageModule:', !!PresageModule, 'isInitialized:', isInitialized.current);

      if (!PresageModule) {
        setLinkingState({type: 'failed', message: 'Native module not available'});
        return;
      }

      setLinkingState({type: 'notStarted'});

      try {
        // Start linking (this is async and will call callbacks)
        PresageModule.startLinking(deviceName);

        // Poll for QR code URL as a fallback in case the event isn't received
        console.warn('Starting QR code polling fallback...');
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          try {
            const qrUrl = await PresageModule.getCurrentQrCodeUrl();
            if (qrUrl) {
              console.warn('Got QR code URL via polling:', qrUrl.length, 'chars');
              clearInterval(pollInterval);
              // Only update if we haven't already received it via event
              const currentState = useSignalStore.getState().linkingState;
              if (currentState.type !== 'waitingForScan') {
                console.warn('Updating state via polling fallback');
                setLinkingState({type: 'waitingForScan', qrUrl});
              }
            }
          } catch (e) {
            // Ignore polling errors
          }
          // Stop polling after 30 seconds
          if (pollCount > 30) {
            clearInterval(pollInterval);
          }
        }, 1000);
      } catch (error) {
        setLinkingState({
          type: 'failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Refresh channels
  const refreshChannels = useCallback(async () => {
    if (!PresageModule || !isInitialized.current) return;

    try {
      const channels = await PresageModule.getChannels();
      setChannels(channels.map(convertChannel));
    } catch (error) {
      console.error('Failed to refresh channels:', error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load messages for a channel
  const loadMessages = useCallback(
    async (channelId: string, limit: number = 50) => {
      if (!PresageModule || !isInitialized.current) return;

      try {
        const msgs = await PresageModule.getMessages(channelId, limit);
        const setMessages = useSignalStore.getState().setMessages;
        setMessages(channelId, msgs.map(convertMessage));
      } catch (error) {
        console.error('Failed to load messages:', error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Send message
  const sendMessage = useCallback(
    async (channelId: string, text: string) => {
      if (!PresageModule || !isInitialized.current) return;

      try {
        const message = await PresageModule.sendMessage(channelId, text);
        addMessage(convertMessage(message));
      } catch (error) {
        console.error('Failed to send message:', error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Start receiving messages
  const startReceiving = useCallback(async () => {
    if (!PresageModule || !isInitialized.current) return;

    try {
      await PresageModule.startReceiving();
    } catch (error) {
      console.error('Failed to start receiving:', error);
    }
  }, []);

  // Stop receiving
  const stopReceiving = useCallback(async () => {
    if (!PresageModule) return;

    try {
      await PresageModule.stopReceiving();
    } catch (error) {
      console.error('Failed to stop receiving:', error);
    }
  }, []);

  // Mark a channel as read — clears unread badge and sends read receipt
  const markAsRead = useCallback(
    async (channelId: string) => {
      if (!PresageModule || !isInitialized.current) return;

      const state = useSignalStore.getState();
      const channelMessages = state.messages[channelId];
      if (!channelMessages || channelMessages.length === 0) return;

      // Find the latest message timestamp
      const latestTs = channelMessages[channelMessages.length - 1].timestamp;

      // Find the last incoming message sender + their timestamps (for read receipt)
      const incomingMessages = channelMessages.filter(m => !m.isOutgoing);
      const lastIncoming = incomingMessages[incomingMessages.length - 1];

      // Clear badge immediately in JS
      markChannelAsRead(channelId);

      try {
        await PresageModule.markAsRead(
          channelId,
          latestTs,
          lastIncoming?.senderId || '',
          lastIncoming ? incomingMessages.map(m => m.timestamp) : [],
        );
      } catch (error) {
        console.error('Failed to mark as read:', error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Set up event listeners ONCE on mount
  useEffect(() => {
    console.log('Setting up event listeners, presageEventEmitter:', !!presageEventEmitter);
    if (!presageEventEmitter) return;

    const subscriptions = [
      presageEventEmitter.addListener('onLinkingQrCode', (event: {url: string}) => {
        console.warn('EVENT: onLinkingQrCode received, url length:', event.url?.length);
        console.warn('EVENT: Setting linkingState to waitingForScan with qrUrl');
        setLinkingState({type: 'waitingForScan', qrUrl: event.url});
      }),
      presageEventEmitter.addListener('onLinkingComplete', () => {
        setIsLinked(true);
        setLinkingState({type: 'completed'});
        // Refresh channels after linking, then fetch avatars
        refreshChannels();
        PresageModule.fetchAllAvatars()
          .then(() => refreshChannels())
          .catch(() => {});
      }),
      presageEventEmitter.addListener('onMessage', (message: NativeMessage) => {
        const converted = convertMessage(message);
        addMessage(converted);

        // Auto-mark as read if this message is in the currently selected channel
        if (!converted.isOutgoing) {
          const currentSelectedId = useSignalStore.getState().selectedChannelId;
          if (currentSelectedId === converted.channelId && PresageModule && isInitialized.current) {
            // Fire-and-forget: mark as read + send read receipt
            PresageModule.markAsRead(
              converted.channelId,
              converted.timestamp,
              converted.senderId,
              [converted.timestamp],
            ).catch(() => {});
            // Clear badge immediately
            useSignalStore.getState().markChannelAsRead(converted.channelId);
          }
        }
      }),
      presageEventEmitter.addListener('onReaction', (event: NativeReactionEvent) => {
        addReaction({
          channelId: event.channelId,
          emoji: event.emoji,
          senderId: event.senderId,
          targetTimestamp: event.targetTimestamp,
          remove: event.remove,
        });
      }),
      presageEventEmitter.addListener('onChannelUpdated', (channel: NativeChannel) => {
        updateChannel(convertChannel(channel));
      }),
      presageEventEmitter.addListener('onNotificationClicked', (event: {channelId: string}) => {
        const {setSelectedChannelId} = useSignalStore.getState();
        setSelectedChannelId(event.channelId);
        if (PresageModule && isInitialized.current) {
          PresageModule.getMessages(event.channelId, 50).then((msgs: NativeMessage[]) => {
            const {setMessages} = useSignalStore.getState();
            setMessages(event.channelId, msgs.map(convertMessage));
          });
        }
      }),
      presageEventEmitter.addListener('onError', (event: {message: string}) => {
        console.error('Signal error:', event.message);
        // If we're in linking state, update to failed
        const currentState = useSignalStore.getState().linkingState;
        if (currentState.type === 'waitingForScan' || currentState.type === 'notStarted') {
          setLinkingState({type: 'failed', message: event.message});
        }
      }),
    ];

    return () => {
      subscriptions.forEach(sub => sub.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - only run once on mount

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopReceiving();
    };
  }, [stopReceiving]);

  return {
    initialize,
    startLinking,
    refreshChannels,
    loadMessages,
    sendMessage,
    startReceiving,
    stopReceiving,
    markAsRead,
  };
}
