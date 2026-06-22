import React, {useCallback, useEffect, useState, useRef} from 'react';
import {View, StyleSheet, Text, Pressable} from 'react-native';
import {useSignalStore} from './store/signalStore';
import {useSignalClient} from './hooks/useSignalClient';
import {useCommandPalette} from './hooks/useCommandPalette';
import {LinkingScreen} from './screens/LinkingScreen';
import {MainScreen} from './screens/MainScreen';

function App(): React.JSX.Element {
  const isLinked = useSignalStore(state => state.isLinked);
  const linkingState = useSignalStore(state => state.linkingState);
  const [isInitializing, setIsInitializing] = useState(true);
  const [listenersReady, setListenersReady] = useState(false);

  // Debug logging
  useEffect(() => {
    console.warn('APP MOUNTED - linkingState:', linkingState.type);
  }, []);

  useEffect(() => {
    console.warn('STATE CHANGED - isInitializing:', isInitializing, 'listenersReady:', listenersReady, 'linkingState:', linkingState.type);
  }, [isInitializing, listenersReady, linkingState]);

  const {
    initialize,
    startLinking,
    refreshChannels,
    loadMessages,
    sendMessage,
    sendReaction,
    startReceiving,
    markAsRead,
    retryDownload,
    unlink,
    startCall,
    acceptCall,
    hangupCall,
    setCallMuted,
  } = useSignalClient();

  // Ref to prevent multiple linking calls - declared early so handleUnlink can reset it
  const linkingStarted = useRef(false);

  const handleUnlink = useCallback(async () => {
    linkingStarted.current = false;
    await unlink();
  }, [unlink]);

  const handleSelectChannel = useCallback(
    async (channelId: string) => {
      await loadMessages(channelId);
      markAsRead(channelId);
    },
    [loadMessages, markAsRead],
  );

  useCommandPalette(handleSelectChannel);

  // Mark listeners as ready after first render cycle completes
  // This ensures the useEffect in useSignalClient has run
  useEffect(() => {
    // Use a small delay to ensure event listeners are fully set up
    const timer = setTimeout(() => {
      console.warn('Event listeners should now be ready');
      setListenersReady(true);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Initialize on mount
  useEffect(() => {
    const init = async () => {
      setIsInitializing(true);
      await initialize();
      setIsInitializing(false);
    };
    init();
  }, [initialize]);

  // Start linking if not linked
  // IMPORTANT: Wait for listenersReady to avoid race condition where QR event is missed
  useEffect(() => {
    if (!isInitializing && listenersReady && !isLinked && linkingState.type === 'notStarted' && !linkingStarted.current) {
      linkingStarted.current = true;
      console.warn('Starting linking process...');
      startLinking('Hush Desktop');
    }
  }, [isInitializing, listenersReady, isLinked, linkingState.type, startLinking]);

  // Start receiving and refresh channels when linked
  useEffect(() => {
    if (isLinked) {
      refreshChannels();
      startReceiving();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLinked]);

  // Loading state
  if (isInitializing) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={styles.loadingText}>Initializing...</Text>
        </View>
      </View>
    );
  }

  // Not linked - show linking screen
  if (!isLinked) {
    const qrUrl =
      linkingState.type === 'waitingForScan' ? linkingState.qrUrl : null;
    const error =
      linkingState.type === 'failed' ? linkingState.message : null;
    const isLinking =
      linkingState.type === 'waitingForScan' ||
      linkingState.type === 'notStarted';

    return (
      <View style={styles.container}>
        <LinkingScreen qrUrl={qrUrl} error={error} isLinking={isLinking} />
        {error && (
          <Pressable
            style={styles.retryButton}
            onPress={() => startLinking('Hush Desktop')}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        )}
      </View>
    );
  }

  // Linked - show main screen
  return (
    <View style={styles.container}>
      <MainScreen
        onSendMessage={sendMessage}
        onSelectChannel={handleSelectChannel}
        onReact={sendReaction}
        onRetryDownload={retryDownload}
        onUnlink={handleUnlink}
        onStartCall={startCall}
        onAcceptCall={acceptCall}
        onHangupCall={hangupCall}
        onToggleCallMute={setCallMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#757575',
  },
  retryButton: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    backgroundColor: '#2196f3',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default App;
