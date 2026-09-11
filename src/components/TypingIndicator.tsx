import React, {useEffect, useMemo, useRef} from 'react';
import {View, Animated, StyleSheet, Image, Text} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {useColors} from '../theme/colors';

interface TypingIndicatorProps {
  senderId: string;
  isGroup: boolean;
}

export function TypingIndicator({senderId, isGroup}: TypingIndicatorProps) {
  const c = useColors();

  // Look up sender info for group avatars
  const senderChannel = useSignalStore(state =>
    isGroup ? state.channels.find(ch => ch.id === senderId) : undefined,
  );
  const senderAvatar = senderChannel?.avatarPath;
  const senderInitial = senderChannel?.name?.charAt(0).toUpperCase() || '?';

  // Three animated dots
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const createDotAnimation = (dot: Animated.Value, delay: number) =>
      Animated.sequence([
        Animated.delay(delay),
        Animated.loop(
          Animated.sequence([
            Animated.timing(dot, {
              toValue: 1,
              duration: 400,
              useNativeDriver: true,
            }),
            Animated.timing(dot, {
              toValue: 0,
              duration: 400,
              useNativeDriver: true,
            }),
          ]),
        ),
      ]);

    const animation = Animated.parallel([
      createDotAnimation(dot1, 0),
      createDotAnimation(dot2, 200),
      createDotAnimation(dot3, 400),
    ]);

    animation.start();

    return () => {
      animation.stop();
    };
  }, [dot1, dot2, dot3]);

  // Interpolations must be built once: re-creating them on every render
  // rebuilds the underlying animated nodes and re-registers them natively.
  const dotStyles = useMemo(() => {
    const build = (anim: Animated.Value) => ({
      opacity: anim.interpolate({
        inputRange: [0, 1],
        outputRange: [0.3, 1],
      }),
      transform: [
        {
          scale: anim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.7, 1],
          }),
        },
      ],
    });
    return [build(dot1), build(dot2), build(dot3)];
  }, [dot1, dot2, dot3]);

  const dotColor = {backgroundColor: c.secondaryLabel};

  const pill = (
    <View style={[styles.pill, {backgroundColor: c.incomingBubble}]}>
      <Animated.View style={[styles.dot, dotColor, dotStyles[0]]} />
      <Animated.View style={[styles.dot, dotColor, dotStyles[1]]} />
      <Animated.View style={[styles.dot, dotColor, dotStyles[2]]} />
    </View>
  );

  if (isGroup) {
    return (
      <View style={styles.groupRow}>
        <View style={styles.avatarContainer}>
          {senderAvatar ? (
            <Image
              source={{uri: `file://${senderAvatar}`}}
              style={styles.avatarImage}
            />
          ) : (
            <View style={styles.avatarFallback}>
              <Text style={styles.avatarText}>{senderInitial}</Text>
            </View>
          )}
        </View>
        {pill}
      </View>
    );
  }

  return (
    <View style={styles.dmRow}>
      {pill}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginHorizontal: 2,
  },
  dmRow: {
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  avatarContainer: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 6,
    marginBottom: 2,
    overflow: 'hidden',
  },
  avatarImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  avatarFallback: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#7B8794',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
});
