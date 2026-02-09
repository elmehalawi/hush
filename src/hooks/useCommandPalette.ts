import {useEffect, useCallback, useRef} from 'react';
import {NativeModules, NativeEventEmitter} from 'react-native';
import {useSignalStore} from '../store/signalStore';

const {CommandPaletteModule} = NativeModules;

const commandPaletteEmitter = CommandPaletteModule
  ? new NativeEventEmitter(CommandPaletteModule)
  : null;

export function useCommandPalette(
  loadMessages: (channelId: string) => Promise<void>,
) {
  const channels = useSignalStore(state => state.channels);
  const setSelectedChannelId = useSignalStore(
    state => state.setSelectedChannelId,
  );
  const lastPushedRef = useRef<string>('');

  // Push channel data to native whenever it changes
  useEffect(() => {
    if (!CommandPaletteModule) return;

    const serialized = JSON.stringify(channels.map(c => c.id));
    if (serialized === lastPushedRef.current) return;
    lastPushedRef.current = serialized;

    const nativeChannels = channels.map(c => ({
      id: c.id,
      name: c.name,
      lastMessage: c.lastMessage || null,
      avatarPath: c.avatarPath || null,
      isGroup: c.isGroup,
      unreadCount: c.unreadCount,
    }));

    CommandPaletteModule.updateChannels(nativeChannels);
  }, [channels]);

  // Listen for selection events
  useEffect(() => {
    if (!commandPaletteEmitter) return;

    const sub = commandPaletteEmitter.addListener(
      'onChannelSelected',
      (event: {channelId: string}) => {
        setSelectedChannelId(event.channelId);
        loadMessages(event.channelId);
      },
    );

    return () => sub.remove();
  }, [loadMessages, setSelectedChannelId]);

  const showCommandPalette = useCallback(() => {
    CommandPaletteModule?.show();
  }, []);

  const hideCommandPalette = useCallback(() => {
    CommandPaletteModule?.hide();
  }, []);

  return {showCommandPalette, hideCommandPalette};
}
