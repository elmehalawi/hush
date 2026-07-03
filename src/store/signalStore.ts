import {create} from 'zustand';

// Types matching our Rust types
export interface Channel {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage?: string;
  lastMessageTimestamp?: number;
  avatarPath?: string;
  phoneNumber?: string;
}

export interface Attachment {
  contentType: string;
  filePath?: string;
  fileName?: string;
  width?: number;
  height?: number;
  size?: number;
  thumbnailPath?: string;
}

export interface Reaction {
  emoji: string;
  senderId: string;
  targetTimestamp: number;
}

export interface Mention {
  start: number;
  length: number;
  uuid: string;
  name: string;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: Attachment;
  date?: number;
}

export interface Quote {
  id: number;
  authorId: string;
  authorName?: string;
  text?: string;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  body?: string;
  timestamp: number;
  isOutgoing: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  attachments: Attachment[];
  reactions: Reaction[];
  mentions: Mention[];
  readBy: string[];
  linkPreviews: LinkPreview[];
  quote?: Quote;
  messageType?: 'regular' | 'missedAudioCall' | 'missedVideoCall' | 'audioCall' | 'videoCall';
  edited?: boolean;
}

export type LinkingState =
  | {type: 'notStarted'}
  | {type: 'waitingForScan'; qrUrl: string}
  | {type: 'completed'}
  | {type: 'failed'; message: string};

export interface ReactionEvent {
  channelId: string;
  emoji: string;
  senderId: string;
  targetTimestamp: number;
  remove: boolean;
}

// Call types
export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'ringing' | 'connected' | 'reconnecting' | 'ended';

export interface ActiveCall {
  remotePeerId: string;
  callId: number;
  isVideo: boolean;
  status: CallStatus;
  isMuted: boolean;
  startedAt?: number;
}

interface SignalStore {
  // State
  isLinked: boolean;
  linkingState: LinkingState;
  channels: Channel[];
  selectedChannelId: string | null;
  messages: Record<string, Message[]>; // channelId -> messages
  userId: string | null;
  typingUsers: Record<string, {senderId: string; timestamp: number}[]>; // channelId -> active typers
  activeCall: ActiveCall | null;

  // Actions
  setIsLinked: (linked: boolean) => void;
  setLinkingState: (state: LinkingState) => void;
  setChannels: (channels: Channel[]) => void;
  setSelectedChannelId: (id: string | null) => void;
  setUserId: (id: string | null) => void;

  // Call actions
  setActiveCall: (call: ActiveCall | null) => void;
  updateCallStatus: (status: CallStatus) => void;
  setCallMuted: (muted: boolean) => void;

  // Message actions
  addMessage: (message: Message) => void;
  addReaction: (event: ReactionEvent) => void;
  setMessages: (channelId: string, messages: Message[]) => void;
  updateChannel: (channel: Channel) => void;
  markChannelAsRead: (channelId: string) => void;
  incrementUnread: (channelId: string) => void;
  updateAttachment: (
    channelId: string,
    messageId: string,
    attachmentIndex: number,
    attachment: Attachment,
  ) => void;
  updateLinkPreviewImage: (
    channelId: string,
    messageId: string,
    previewIndex: number,
    image: Attachment,
  ) => void;
  markMessagesAsRead: (senderId: string, timestamps: number[]) => void;
  setTyping: (channelId: string, senderId: string, started: boolean) => void;
  resetStore: () => void;
}

export const useSignalStore = create<SignalStore>((set, get) => ({
  // Initial state
  isLinked: false,
  linkingState: {type: 'notStarted'},
  channels: [],
  selectedChannelId: null,
  messages: {},
  userId: null,
  typingUsers: {},
  activeCall: null,

  // Actions
  setIsLinked: (linked: boolean) => set({isLinked: linked}),

  setLinkingState: (state: LinkingState) => set({linkingState: state}),

  setChannels: (incoming: Channel[]) => {
    const {channels: existing} = get();
    if (existing.length === 0) {
      set({channels: incoming});
      return;
    }
    const existingMap = new Map<string, Channel>();
    for (const ch of existing) {
      existingMap.set(ch.id, ch);
    }
    const merged = incoming.map(ch => {
      const prev = existingMap.get(ch.id);
      if (!prev) return ch;
      // Preserve the existing real name if the incoming name is empty or a UUID
      const name =
        ch.name && !UUID_RE.test(ch.name)
          ? ch.name
          : (prev.name && !UUID_RE.test(prev.name) ? prev.name : ch.name);
      return {...ch, name, phoneNumber: ch.phoneNumber || prev.phoneNumber};
    });
    set({channels: merged});
  },

  setSelectedChannelId: (id: string | null) => set({selectedChannelId: id}),

  setUserId: (id: string | null) => set({userId: id}),

  setActiveCall: (call: ActiveCall | null) => set({activeCall: call}),

  updateCallStatus: (status: CallStatus) => {
    const {activeCall} = get();
    if (!activeCall) return;
    set({
      activeCall: {
        ...activeCall,
        status,
        startedAt: status === 'connected' && !activeCall.startedAt ? Date.now() : activeCall.startedAt,
      },
    });
  },

  setCallMuted: (muted: boolean) => {
    const {activeCall} = get();
    if (!activeCall) return;
    set({activeCall: {...activeCall, isMuted: muted}});
  },

  addReaction: (event: ReactionEvent) => {
    const {messages} = get();
    const channelMessages = messages[event.channelId];
    if (!channelMessages) return;

    const msgIndex = channelMessages.findIndex(
      m => m.timestamp === event.targetTimestamp,
    );
    if (msgIndex < 0) return;

    const msg = channelMessages[msgIndex];
    let newReactions: Reaction[];
    if (event.remove) {
      newReactions = msg.reactions.filter(
        r => !(r.senderId === event.senderId && r.emoji === event.emoji),
      );
    } else {
      // Replace any existing reaction from this sender, then add new one
      newReactions = msg.reactions.filter(
        r => r.senderId !== event.senderId,
      );
      newReactions.push({
        emoji: event.emoji,
        senderId: event.senderId,
        targetTimestamp: event.targetTimestamp,
      });
    }

    const updatedMessages = [...channelMessages];
    updatedMessages[msgIndex] = {...msg, reactions: newReactions};
    set({
      messages: {
        ...messages,
        [event.channelId]: updatedMessages,
      },
    });
  },

  addMessage: (message: Message) => {
    const {messages, channels, selectedChannelId, typingUsers} = get();
    const channelMessages = messages[message.channelId] || [];

    // An edit (or a redelivery) arrives with the same id as an existing message.
    // Replace it in place rather than appending a duplicate.
    const existingIndex = channelMessages.findIndex(m => m.id === message.id);
    const isReplacement = existingIndex >= 0;

    // Update the channel's last message info for sorting
    const channelIndex = channels.findIndex(c => c.id === message.channelId);
    let updatedChannels = channels;
    if (channelIndex >= 0) {
      const channel = channels[channelIndex];
      if (!channel.lastMessageTimestamp || message.timestamp >= channel.lastMessageTimestamp) {
        updatedChannels = [...channels];
        const unreadDelta =
          !isReplacement && !message.isOutgoing && message.channelId !== selectedChannelId ? 1 : 0;
        updatedChannels[channelIndex] = {
          ...channel,
          lastMessage: message.body
            || (message.messageType === 'missedVideoCall' ? 'Missed video call' : undefined)
            || (message.messageType === 'missedAudioCall' ? 'Missed voice call' : undefined)
            || (message.messageType === 'videoCall' ? 'Video call' : undefined)
            || (message.messageType === 'audioCall' ? 'Voice call' : undefined)
            || channel.lastMessage,
          lastMessageTimestamp: message.timestamp,
          unreadCount: channel.unreadCount + unreadDelta,
        };
      }
    }

    // Clear typing state for the sender (they sent a message, so they stopped typing)
    let updatedTyping = typingUsers;
    const channelTyping = typingUsers[message.channelId];
    if (channelTyping && channelTyping.some(t => t.senderId === message.senderId)) {
      const filtered = channelTyping.filter(t => t.senderId !== message.senderId);
      if (filtered.length === 0) {
        const {[message.channelId]: _, ...rest} = typingUsers;
        updatedTyping = rest;
      } else {
        updatedTyping = {...typingUsers, [message.channelId]: filtered};
      }
    }

    let updatedChannelMessages: Message[];
    if (isReplacement) {
      const existing = channelMessages[existingIndex];
      updatedChannelMessages = [...channelMessages];
      updatedChannelMessages[existingIndex] = {
        ...message,
        // Preserve reactions/read state; an edit event doesn't carry them
        reactions: message.reactions.length > 0 ? message.reactions : existing.reactions,
        readBy: message.readBy.length > 0 ? message.readBy : existing.readBy,
      };
    } else {
      updatedChannelMessages = [...channelMessages, message];
    }

    set({
      channels: updatedChannels,
      typingUsers: updatedTyping,
      messages: {
        ...messages,
        [message.channelId]: updatedChannelMessages,
      },
    });
  },

  setMessages: (channelId: string, newMessages: Message[]) => {
    const {messages} = get();
    set({
      messages: {
        ...messages,
        [channelId]: newMessages,
      },
    });
  },

  updateChannel: (channel: Channel) => {
    const {channels} = get();
    const index = channels.findIndex(c => c.id === channel.id);
    if (index >= 0) {
      const newChannels = [...channels];
      // Merge: keep existing fields if new channel has empty/placeholder values
      const existing = newChannels[index];
      // Don't overwrite a real name with a UUID-looking string
      const newName =
        channel.name && (!UUID_RE.test(channel.name) || !existing.name || UUID_RE.test(existing.name))
          ? channel.name
          : existing.name;
      newChannels[index] = {
        ...existing,
        lastMessage: channel.lastMessage || existing.lastMessage,
        lastMessageTimestamp: channel.lastMessageTimestamp || existing.lastMessageTimestamp,
        avatarPath: channel.avatarPath || existing.avatarPath,
        phoneNumber: channel.phoneNumber || existing.phoneNumber,
        name: newName,
      };
      set({channels: newChannels});
    } else {
      set({channels: [...channels, channel]});
    }
  },

  markChannelAsRead: (channelId: string) => {
    const {channels} = get();
    const index = channels.findIndex(c => c.id === channelId);
    if (index >= 0 && channels[index].unreadCount > 0) {
      const newChannels = [...channels];
      newChannels[index] = {...newChannels[index], unreadCount: 0};
      set({channels: newChannels});
    }
  },

  incrementUnread: (channelId: string) => {
    const {channels} = get();
    const index = channels.findIndex(c => c.id === channelId);
    if (index >= 0) {
      const newChannels = [...channels];
      newChannels[index] = {
        ...newChannels[index],
        unreadCount: newChannels[index].unreadCount + 1,
      };
      set({channels: newChannels});
    }
  },

  updateAttachment: (
    channelId: string,
    messageId: string,
    attachmentIndex: number,
    attachment: Attachment,
  ) => {
    const {messages} = get();
    const channelMessages = messages[channelId];
    if (!channelMessages) return;

    const msgIndex = channelMessages.findIndex(m => m.id === messageId);
    if (msgIndex < 0) return;

    const msg = channelMessages[msgIndex];
    if (attachmentIndex >= msg.attachments.length) return;

    const newAttachments = [...msg.attachments];
    newAttachments[attachmentIndex] = attachment;

    const updatedMessages = [...channelMessages];
    updatedMessages[msgIndex] = {...msg, attachments: newAttachments};
    set({
      messages: {
        ...messages,
        [channelId]: updatedMessages,
      },
    });
  },

  updateLinkPreviewImage: (
    channelId: string,
    messageId: string,
    previewIndex: number,
    image: Attachment,
  ) => {
    const {messages} = get();
    const channelMessages = messages[channelId];
    if (!channelMessages) return;

    const msgIndex = channelMessages.findIndex(m => m.id === messageId);
    if (msgIndex < 0) return;

    const msg = channelMessages[msgIndex];
    if (previewIndex >= msg.linkPreviews.length) return;

    const newPreviews = [...msg.linkPreviews];
    newPreviews[previewIndex] = {...newPreviews[previewIndex], image};

    const updatedMessages = [...channelMessages];
    updatedMessages[msgIndex] = {...msg, linkPreviews: newPreviews};
    set({
      messages: {
        ...messages,
        [channelId]: updatedMessages,
      },
    });
  },

  markMessagesAsRead: (senderId: string, timestamps: number[]) => {
    const {messages} = get();
    const tsSet = new Set(timestamps);
    let changed = false;
    const updatedMessages: Record<string, Message[]> = {...messages};

    for (const channelId of Object.keys(updatedMessages)) {
      const channelMessages = updatedMessages[channelId];
      let channelChanged = false;
      const newMessages = channelMessages.map(m => {
        if (m.isOutgoing && tsSet.has(m.timestamp)) {
          const alreadyHasReader = m.readBy.includes(senderId);
          if (m.status !== 'read' || !alreadyHasReader) {
            channelChanged = true;
            return {
              ...m,
              status: 'read' as const,
              readBy: alreadyHasReader ? m.readBy : [...m.readBy, senderId],
            };
          }
        }
        return m;
      });
      if (channelChanged) {
        updatedMessages[channelId] = newMessages;
        changed = true;
      }
    }

    if (changed) {
      set({messages: updatedMessages});
    }
  },

  setTyping: (channelId: string, senderId: string, started: boolean) => {
    const {typingUsers, userId} = get();
    // Don't show our own typing indicator
    if (senderId === userId) return;

    const current = typingUsers[channelId] || [];
    if (started) {
      const filtered = current.filter(t => t.senderId !== senderId);
      filtered.push({senderId, timestamp: Date.now()});
      set({typingUsers: {...typingUsers, [channelId]: filtered}});
    } else {
      const filtered = current.filter(t => t.senderId !== senderId);
      if (filtered.length === 0) {
        const {[channelId]: _, ...rest} = typingUsers;
        set({typingUsers: rest});
      } else {
        set({typingUsers: {...typingUsers, [channelId]: filtered}});
      }
    }
  },

  resetStore: () =>
    set({
      isLinked: false,
      linkingState: {type: 'notStarted'},
      channels: [],
      selectedChannelId: null,
      messages: {},
      userId: null,
      typingUsers: {},
      activeCall: null,
    }),
}));

/**
 * Resolve a UUID to a display name using available store data.
 * Checks channels (for 1:1 chats where channel.id matches the UUID),
 * then scans loaded messages in the given channel for a senderName.
 * Returns undefined if no name can be found.
 */
export function resolveContactName(
  uuid: string,
  userId: string | null,
  channels: Channel[],
  channelMessages: Message[],
): string | undefined {
  if (uuid === userId) return 'You';

  // 1:1 chats use the contact UUID as channel ID
  const channel = channels.find(c => c.id === uuid && !c.isGroup);
  if (channel?.name && channel.name !== uuid) return channel.name;

  // In group chats, find a message from this sender that has a resolved name
  for (const msg of channelMessages) {
    if (msg.senderId === uuid && msg.senderName && msg.senderName !== uuid) {
      return msg.senderName;
    }
  }

  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return a display-safe name for a channel.
 * Falls back to phone number or "Unknown" instead of showing a raw UUID.
 */
export function channelDisplayName(channel: Channel): string {
  if (channel.name && !UUID_RE.test(channel.name)) return channel.name;
  if (channel.phoneNumber) return channel.phoneNumber;
  return 'Unknown';
}
