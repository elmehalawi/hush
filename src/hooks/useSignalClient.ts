import {useEffect, useRef, useCallback} from 'react';
import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useSignalStore, Message, Channel, Attachment, LinkPreview, Mention, Quote, Reaction, ReactionEvent, ActiveCall} from '../store/signalStore';

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
  phoneNumber: string | null;
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

interface NativeMention {
  start: number;
  length: number;
  uuid: string;
  name: string;
}

interface NativeLinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: NativeAttachment | null;
  date: number | null;
}

interface NativeQuote {
  id: number;
  authorId: string;
  authorName: string | null;
  text: string | null;
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
  mentions: NativeMention[] | null;
  readBy: string[] | null;
  linkPreviews: NativeLinkPreview[] | null;
  quote: NativeQuote | null;
  messageType: string | null;
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
    phoneNumber: native.phoneNumber || undefined,
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

// Convert native link preview to store link preview
function convertLinkPreview(native: NativeLinkPreview): LinkPreview {
  return {
    url: native.url,
    title: native.title || undefined,
    description: native.description || undefined,
    image: native.image ? convertAttachment(native.image) : undefined,
    date: native.date || undefined,
  };
}

// Convert native quote to store quote
function convertQuote(native: NativeQuote): Quote {
  return {
    id: native.id,
    authorId: native.authorId,
    authorName: native.authorName || undefined,
    text: native.text || undefined,
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
    mentions: (native.mentions || []),
    readBy: native.readBy || [],
    linkPreviews: (native.linkPreviews || []).map(convertLinkPreview),
    quote: native.quote ? convertQuote(native.quote) : undefined,
    messageType: (native.messageType as Message['messageType']) || undefined,
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
  const updateAttachment = useSignalStore(state => state.updateAttachment);
  const updateLinkPreviewImage = useSignalStore(state => state.updateLinkPreviewImage);
  const markMessagesAsRead = useSignalStore(state => state.markMessagesAsRead);

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

  // Link preview data for sending
  interface LinkPreviewData {
    url: string;
    title?: string;
    description?: string;
    imagePath?: string;
    date?: number;
  }

  // Send message (with optional attachments, link previews, and quote)
  const sendMessage = useCallback(
    async (channelId: string, text: string, attachmentPaths?: string[], linkPreviews?: LinkPreviewData[], quote?: Quote) => {
      if (!PresageModule || !isInitialized.current) return;

      try {
        let message;
        if (quote) {
          // Use the quote-aware send path
          message = await PresageModule.sendMessageWithQuote(
            channelId,
            text || null,
            attachmentPaths || [],
            linkPreviews || [],
            {id: quote.id, authorId: quote.authorId, authorName: quote.authorName || null, text: quote.text || null},
          );
        } else if (linkPreviews && linkPreviews.length > 0) {
          // Use the previews-aware send path
          message = await PresageModule.sendMessageWithPreviews(
            channelId,
            text || null,
            attachmentPaths || [],
            linkPreviews,
          );
        } else if (attachmentPaths && attachmentPaths.length > 0) {
          message = await PresageModule.sendMessageWithAttachments(
            channelId,
            text || null,
            attachmentPaths,
          );
        } else {
          message = await PresageModule.sendMessage(channelId, text);
        }
        addMessage(convertMessage(message));
      } catch (error) {
        console.error('Failed to send message:', error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Send a reaction
  const sendReaction = useCallback(
    async (channelId: string, emoji: string, targetTimestamp: number, remove: boolean) => {
      if (!PresageModule || !isInitialized.current) return;

      // Optimistic local update
      const userId = useSignalStore.getState().userId;
      if (userId) {
        addReaction({
          channelId,
          emoji,
          senderId: userId,
          targetTimestamp,
          remove,
        });
      }

      try {
        await PresageModule.sendReaction(channelId, emoji, targetTimestamp, remove);
      } catch (error) {
        console.error('Failed to send reaction:', error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Call methods
  const startCall = useCallback(
    async (channelId: string, isVideo: boolean) => {
      if (!PresageModule || !isInitialized.current) return;

      // Optimistic state update
      useSignalStore.getState().setActiveCall({
        remotePeerId: channelId,
        callId: 0, // Will be updated by onCallStateChanged
        isVideo,
        status: 'outgoing',
        isMuted: false,
      });

      try {
        await PresageModule.startCall(channelId, isVideo);
      } catch (error) {
        console.error('Failed to start call:', error);
        useSignalStore.getState().setActiveCall(null);
      }
    },
    [],
  );

  const acceptCall = useCallback(
    async (callId: number) => {
      if (!PresageModule || !isInitialized.current) return;

      try {
        await PresageModule.acceptCall(callId);
      } catch (error) {
        console.error('Failed to accept call:', error);
      }
    },
    [],
  );

  const hangupCall = useCallback(async () => {
    if (!PresageModule) return;

    try {
      await PresageModule.hangupCall();
    } catch (error) {
      console.error('Failed to hangup call:', error);
    }
    useSignalStore.getState().setActiveCall(null);
  }, []);

  const setCallMuted = useCallback(
    async (muted: boolean) => {
      if (!PresageModule || !isInitialized.current) return;

      useSignalStore.getState().setCallMuted(muted);

      try {
        await PresageModule.setCallMuted(muted);
      } catch (error) {
        console.error('Failed to set call muted:', error);
      }
    },
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

  // Retry downloading a specific attachment
  const retryDownload = useCallback(
    async (channelId: string, messageId: string, attachmentIndex: number) => {
      if (!PresageModule || !isInitialized.current) return;

      try {
        await PresageModule.retryDownload(channelId, messageId, attachmentIndex);
      } catch (error) {
        console.error('Failed to retry download:', error);
      }
    },
    [],
  );

  // Unlink this device and clear all local data
  const unlink = useCallback(async () => {
    if (!PresageModule) return;
    try {
      await PresageModule.unlink();
      useSignalStore.getState().resetStore();
    } catch (error) {
      console.error('Failed to unlink:', error);
    }
  }, []);

  // Typing timeout management
  const typingTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
      presageEventEmitter.addListener('onReadReceipt', (event: {senderId: string; timestamps: number[]}) => {
        markMessagesAsRead(event.senderId, event.timestamps);
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
      presageEventEmitter.addListener('onAttachmentDownloaded', (event: {
        channelId: string;
        messageId: string;
        attachmentIndex: number;
        attachment: NativeAttachment;
      }) => {
        updateAttachment(
          event.channelId,
          event.messageId,
          event.attachmentIndex,
          convertAttachment(event.attachment),
        );
      }),
      presageEventEmitter.addListener('onLinkPreviewImageDownloaded', (event: {
        channelId: string;
        messageId: string;
        previewIndex: number;
        image: NativeAttachment;
      }) => {
        updateLinkPreviewImage(
          event.channelId,
          event.messageId,
          event.previewIndex,
          convertAttachment(event.image),
        );
      }),
      presageEventEmitter.addListener('onTyping', (event: {channelId: string; senderId: string; started: boolean}) => {
        const {setTyping} = useSignalStore.getState();
        setTyping(event.channelId, event.senderId, event.started);

        const timeoutKey = `${event.channelId}:${event.senderId}`;
        // Clear any existing timeout for this sender
        const existing = typingTimeouts.current.get(timeoutKey);
        if (existing) {
          clearTimeout(existing);
          typingTimeouts.current.delete(timeoutKey);
        }

        if (event.started) {
          // Auto-clear after 10 seconds if no new event
          const timeout = setTimeout(() => {
            useSignalStore.getState().setTyping(event.channelId, event.senderId, false);
            typingTimeouts.current.delete(timeoutKey);
          }, 10000);
          typingTimeouts.current.set(timeoutKey, timeout);
        }
      }),
      presageEventEmitter.addListener('onIncomingCall', (event: {remotePeerId: string; callId: number; isVideo: boolean}) => {
        const {setActiveCall} = useSignalStore.getState();
        setActiveCall({
          remotePeerId: event.remotePeerId,
          callId: event.callId,
          isVideo: event.isVideo,
          status: 'incoming',
          isMuted: false,
        });
      }),
      presageEventEmitter.addListener('onCallStateChanged', (event: {remotePeerId: string; state: string; callId: number}) => {
        const {activeCall, updateCallStatus, setActiveCall} = useSignalStore.getState();
        const state = event.state as ActiveCall['status'];
        if (activeCall) {
          updateCallStatus(state);
          // Also update callId if it was initially 0 (outgoing call)
          if (activeCall.callId === 0 && event.callId !== 0) {
            setActiveCall({...activeCall, callId: event.callId, status: state});
          }
        } else {
          // Call state changed but no active call — set one up (e.g. outgoing)
          setActiveCall({
            remotePeerId: event.remotePeerId,
            callId: event.callId,
            isVideo: false,
            status: state,
            isMuted: false,
          });
        }
      }),
      presageEventEmitter.addListener('onCallEnded', (event: {remotePeerId: string; reason: string}) => {
        const {activeCall, setActiveCall} = useSignalStore.getState();
        if (activeCall) {
          // Show "ended" briefly, then clear
          setActiveCall({...activeCall, status: 'ended'});
          setTimeout(() => {
            useSignalStore.getState().setActiveCall(null);
          }, 1500);
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
      // Clear all typing timeouts
      typingTimeouts.current.forEach(t => clearTimeout(t));
      typingTimeouts.current.clear();
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
    sendReaction,
    startReceiving,
    stopReceiving,
    markAsRead,
    retryDownload,
    unlink,
    startCall,
    acceptCall,
    hangupCall,
    setCallMuted,
  };
}
