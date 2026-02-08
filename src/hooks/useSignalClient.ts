import {useEffect, useRef, useCallback} from 'react';
import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useSignalStore, Message, Channel} from '../store/signalStore';

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
  };
}

// Get the data directory for storing Signal data
function getDataDir(): string {
  // Use a simple path in tmp for now to avoid directory creation issues
  return '/tmp/signal-app-data';
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
  const updateChannel = useSignalStore(state => state.updateChannel);

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
      const dataDir = getDataDir();
      console.log('Initializing with dataDir:', dataDir);
      await PresageModule.initialize(dataDir);
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

        // Load channels
        const channels = await PresageModule.getChannels();
        setChannels(channels.map(convertChannel));
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
        // Refresh channels after linking
        refreshChannels();
      }),
      presageEventEmitter.addListener('onMessage', (message: NativeMessage) => {
        addMessage(convertMessage(message));
      }),
      presageEventEmitter.addListener('onChannelUpdated', (channel: NativeChannel) => {
        updateChannel(convertChannel(channel));
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
  };
}
