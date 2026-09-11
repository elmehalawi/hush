import React, {useEffect, useMemo, useRef} from 'react';
import {View, Animated, Easing, StyleSheet, Image, Text} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {useColors} from '../theme/colors';

/**
 * One clock drives all three dots.
 *
 * This deliberately stays on the JS driver. useNativeDriver: true is a dead end
 * in this app: react-native-macos accepts startAnimatingNode under bridgeless
 * Fabric and then never advances the animation, with no error. A native-driven
 * timing simply never completes (measured: a 600ms timing still unfinished at
 * 3000ms, while the identical JS-driven timing finished in 601ms). That is what
 * froze the dots in v1.10.5 -- not the loop shape.
 *
 * What this does save is JS work: one clock per indicator instead of three
 * independent values, with each dot deriving its own phase by interpolation.
 * Offsets of 0 / 0.25 / 0.5 of the period reproduce the old 200ms stagger, and
 * every row's endpoints match so the loop is seamless.
 */
export const DOT_WAVE = [
  // Peaks at clock 0 / 0.25 / 0.5 so the wave runs left-to-right, matching the
  // old 0 / 200ms / 400ms stagger over an 800ms period.
  {input: [0, 0.5, 1], opacity: [1, 0.3, 1], scale: [1, 0.7, 1]},
  {input: [0, 0.25, 0.75, 1], opacity: [0.65, 1, 0.3, 0.65], scale: [0.85, 1, 0.7, 0.85]},
  {input: [0, 0.5, 1], opacity: [0.3, 1, 0.3], scale: [0.7, 1, 0.7]},
];

export const DOT_PERIOD_MS = 800;

/** Starts the shared native dot clock for the lifetime of the component. */
export function useDotClock(): Animated.Value {
  const clock = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(clock, {
        toValue: 1,
        duration: DOT_PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [clock]);

  return clock;
}

/** Interpolations are built once; rebuilding them re-registers native nodes. */
export function useDotStyles(clock: Animated.Value) {
  return useMemo(
    () =>
      DOT_WAVE.map(w => ({
        opacity: clock.interpolate({inputRange: w.input, outputRange: w.opacity}),
        transform: [
          {scale: clock.interpolate({inputRange: w.input, outputRange: w.scale})},
        ],
      })),
    [clock],
  );
}

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

  const clock = useDotClock();
  const dotStyles = useDotStyles(clock);

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
