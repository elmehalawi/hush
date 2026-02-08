import {create} from 'zustand';

// Types matching our Rust types
export interface Channel {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage?: string;
  lastMessageTimestamp?: number;
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
}

export type LinkingState =
  | {type: 'notStarted'}
  | {type: 'waitingForScan'; qrUrl: string}
  | {type: 'completed'}
  | {type: 'failed'; message: string};

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
  setMessages: (channelId: string, messages: Message[]) => void;
  updateChannel: (channel: Channel) => void;
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

  addMessage: (message: Message) => {
    const {messages, channels} = get();
    const channelMessages = messages[message.channelId] || [];

    // Update the channel's last message info for sorting
    const channelIndex = channels.findIndex(c => c.id === message.channelId);
    let updatedChannels = channels;
    if (channelIndex >= 0) {
      const channel = channels[channelIndex];
      if (!channel.lastMessageTimestamp || message.timestamp >= channel.lastMessageTimestamp) {
        updatedChannels = [...channels];
        updatedChannels[channelIndex] = {
          ...channel,
          lastMessage: message.body || channel.lastMessage,
          lastMessageTimestamp: message.timestamp,
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
      newChannels[index] = channel;
      set({channels: newChannels});
    } else {
      set({channels: [...channels, channel]});
    }
  },
}));
