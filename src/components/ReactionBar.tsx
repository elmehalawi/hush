import React, {useCallback} from 'react';
import {View, Pressable, Text, StyleSheet} from 'react-native';
import {GlassView} from './GlassView';

const EMOJI_LIST = ['\u2764\uFE0F', '\uD83D\uDC4D', '\uD83D\uDE02', '\uD83D\uDE2E', '\uD83D\uDE22', '\uD83D\uDE4F'];

interface ReactionBarProps {
  onReact: (emoji: string) => void;
  existingReactionEmoji?: string;
}

export function ReactionBar({onReact, existingReactionEmoji}: ReactionBarProps) {
  const handlePress = useCallback(
    (emoji: string) => {
      onReact(emoji);
    },
    [onReact],
  );

  return (
    <View style={styles.container}>
      <GlassView style={StyleSheet.absoluteFill} cornerRadius={14} />
      <View style={styles.row}>
        {EMOJI_LIST.map(emoji => {
          const isActive = existingReactionEmoji === emoji;
          return (
            <Pressable
              key={emoji}
              onPress={() => handlePress(emoji)}
              style={({pressed}) => [
                styles.emojiButton,
                isActive && styles.emojiButtonActive,
                pressed && styles.emojiButtonPressed,
              ]}>
              <Text style={styles.emoji}>{emoji}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 3,
    paddingVertical: 2,
    gap: 1,
  },
  emojiButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiButtonActive: {
    backgroundColor: 'rgba(0, 120, 255, 0.2)',
  },
  emojiButtonPressed: {
    transform: [{scale: 1.2}],
  },
  emoji: {
    fontSize: 15,
  },
});
