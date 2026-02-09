import React, {useState, useRef, useImperativeHandle, forwardRef} from 'react';
import {View, TextInput, StyleSheet, useColorScheme} from 'react-native';
import {GlassView} from './GlassView';
import {GlassButton} from './GlassButton';

interface MessageInputProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export interface MessageInputHandle {
  focus: () => void;
  insertText: (letter: string) => void;
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(
  function MessageInput({onSend, disabled}, ref) {
    const [text, setText] = useState('');
    const isDark = useColorScheme() === 'dark';
    const inputRef = useRef<TextInput>(null);
    const sendingRef = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
      },
      insertText: (letter: string) => {
        setText(prev => prev + letter);
        sendingRef.current = false;
        inputRef.current?.focus();
      },
    }));

    const handleSend = () => {
      if (sendingRef.current) return;
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        sendingRef.current = true;
        onSend(trimmed);
      }
      setText('');
    };

    const handleTextChange = (newText: string) => {
      sendingRef.current = false;
      setText(newText);
    };

    return (
      <View style={styles.container}>
        <GlassView style={styles.inputWrapper} cornerRadius={20}>
          <TextInput
            ref={inputRef}
            style={[styles.input, isDark && {color: '#FFFFFF'}]}
            value={text}
            onChangeText={handleTextChange}
            placeholder="Signal Message"
            placeholderTextColor="#9e9e9e"
            multiline
            submitBehavior="submit"
            blurOnSubmit={false}
            onSubmitEditing={handleSend}
            editable={!disabled}
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
  },
);

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
