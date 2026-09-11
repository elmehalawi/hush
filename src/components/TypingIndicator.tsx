import React, {useEffect, useState} from 'react';
import {View, StyleSheet, Image, Text} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';
import {useSignalStore} from '../store/signalStore';
import {useColors} from '../theme/colors';

/**
 * A typing indicator does not need 60fps.
 *
 * Animating these with Animated meant every dot's opacity and scale were
 * recomputed and pushed to the view on every frame -- three view updates per
 * indicator per frame, ~180/sec each, on the JS thread. With a chat pill and a
 * sidebar row both live that was the thing making the UI crawl while somebody
 * typed. (The native driver would have moved it off-thread, but it does not
 * work in this app at all -- see the v1.10.5/v1.10.6 history.)
 *
 * So the dots step instead of sliding: six discrete frames on a 150ms tick,
 * ~20 view updates/sec per indicator rather than ~180. One interval serves
 * every indicator in the app, it only runs while at least one is mounted, and
 * because they share it the dots stay in phase with each other.
 */
const STEP_MS = 150;
const STEPS = 6;

/** Opacity/scale by how many steps a dot is behind the leading edge. */
const DOT_OPACITY = [1, 0.7, 0.45, 0.3, 0.3, 0.3];
const DOT_SCALE = [1, 0.9, 0.8, 0.7, 0.7, 0.7];

const stepSubscribers = new Set<(step: number) => void>();
let stepTimer: ReturnType<typeof setInterval> | null = null;
let currentStep = 0;

function subscribeToStep(fn: (step: number) => void): () => void {
  stepSubscribers.add(fn);
  if (stepTimer == null) {
    stepTimer = setInterval(() => {
      currentStep = (currentStep + 1) % STEPS;
      stepSubscribers.forEach(f => f(currentStep));
    }, STEP_MS);
  }
  return () => {
    stepSubscribers.delete(fn);
    if (stepSubscribers.size === 0 && stepTimer != null) {
      clearInterval(stepTimer);
      stepTimer = null;
      currentStep = 0;
    }
  };
}

export function useDotStep(): number {
  const [step, setStep] = useState(currentStep);
  useEffect(() => subscribeToStep(setStep), []);
  return step;
}

/**
 * The animating part, kept in its own component so the 150ms tick re-renders
 * only three tiny views -- not the avatar image or the surrounding row.
 */
export function DotRow({
  color,
  dotStyle,
  rowStyle,
}: {
  color: string;
  dotStyle: StyleProp<ViewStyle>;
  rowStyle?: StyleProp<ViewStyle>;
}) {
  const step = useDotStep();

  return (
    <View style={rowStyle}>
      {[0, 1, 2].map(i => {
        const phase = (((step - i) % STEPS) + STEPS) % STEPS;
        return (
          <View
            key={i}
            style={[
              dotStyle,
              {
                backgroundColor: color,
                opacity: DOT_OPACITY[phase],
                transform: [{scale: DOT_SCALE[phase]}],
              },
            ]}
          />
        );
      })}
    </View>
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

  const pill = (
    <DotRow
      color={c.secondaryLabel}
      dotStyle={styles.dot}
      rowStyle={[styles.pill, {backgroundColor: c.incomingBubble}]}
    />
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
