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

interface SignalStore {
  // State
  isLinked: boolean;
  linkingState: LinkingState;
  channels: Channel[];
  selectedChannelId: string | null;
  messages: Record<string, Message[]>; // channelId -> messages
  userId: string | null;

  // Actions
  setIsLinked: (linked: boolean) => void;
  setLinkingState: (state: LinkingState) => void;
  setChannels: (channels: Channel[]) => void;
  setSelectedChannelId: (id: string | null) => void;
  setUserId: (id: string | null) => void;

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
}

export const useSignalStore = create<SignalStore>((set, get) => ({
  // Initial state
  isLinked: false,
  linkingState: {type: 'notStarted'},
  channels: [],
  selectedChannelId: null,
  messages: {},
  userId: null,

  // Actions
  setIsLinked: (linked: boolean) => set({isLinked: linked}),

  setLinkingState: (state: LinkingState) => set({linkingState: state}),

  setChannels: (channels: Channel[]) => set({channels}),

  setSelectedChannelId: (id: string | null) => set({selectedChannelId: id}),

  setUserId: (id: string | null) => set({userId: id}),

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
    const {messages, channels, selectedChannelId} = get();
    const channelMessages = messages[message.channelId] || [];

    // Update the channel's last message info for sorting
    const channelIndex = channels.findIndex(c => c.id === message.channelId);
    let updatedChannels = channels;
    if (channelIndex >= 0) {
      const channel = channels[channelIndex];
      if (!channel.lastMessageTimestamp || message.timestamp >= channel.lastMessageTimestamp) {
        updatedChannels = [...channels];
        const unreadDelta =
          !message.isOutgoing && message.channelId !== selectedChannelId ? 1 : 0;
        updatedChannels[channelIndex] = {
          ...channel,
          lastMessage: message.body || channel.lastMessage,
          lastMessageTimestamp: message.timestamp,
          unreadCount: channel.unreadCount + unreadDelta,
        };
      }
    }

    set({
      channels: updatedChannels,
      messages: {
        ...messages,
        [message.channelId]: [...channelMessages, message],
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
      const isUuid = (s: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
      const newName =
        channel.name && (!isUuid(channel.name) || !existing.name || isUuid(existing.name))
          ? channel.name
          : existing.name;
      newChannels[index] = {
        ...existing,
        lastMessage: channel.lastMessage || existing.lastMessage,
        lastMessageTimestamp: channel.lastMessageTimestamp || existing.lastMessageTimestamp,
        avatarPath: channel.avatarPath || existing.avatarPath,
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
