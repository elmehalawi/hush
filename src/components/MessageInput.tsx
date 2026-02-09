import React, {useState} from 'react';
import {View, TextInput, StyleSheet} from 'react-native';
import {GlassView} from './GlassView';
import {GlassButton} from './GlassButton';

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function MessageInput({onSend, disabled}: MessageInputProps) {
  const [text, setText] = useState('');

  const handleSend = () => {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      onSend(trimmed);
      setText('');
    }
  };

  const handleKeyPress = (e: any) => {
    if (e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <View style={styles.container}>
      <GlassView style={styles.inputWrapper} cornerRadius={20}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Type a message..."
          placeholderTextColor="#9e9e9e"
          multiline
          editable={!disabled}
          onKeyPress={handleKeyPress}
        />
      </GlassView>
      <GlassButton
        style={styles.sendButton}
        symbolName="arrow.up"
        bezelColor="#007AFF"
        onPress={handleSend}
        disabled={disabled || text.trim().length === 0}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
  },
  inputWrapper: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    marginRight: 8,
  },
  input: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: 'transparent',
  },
  sendButton: {
    width: 40,
    height: 40,
  },
});
