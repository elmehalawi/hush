import React from 'react';
import {requireNativeComponent, processColor, ViewStyle} from 'react-native';

interface GlassButtonProps {
  style?: ViewStyle;
  title?: string;
  symbolName?: string;
  bezelColor?: string;
  onPress?: () => void;
  disabled?: boolean;
}

const NativeGlassButton = requireNativeComponent<any>('GlassButton');

export function GlassButton({style, title, symbolName, bezelColor, onPress, disabled}: GlassButtonProps) {
  return (
    <NativeGlassButton
      style={style}
      title={title}
      symbolName={symbolName}
      bezelColor={bezelColor ? processColor(bezelColor) : undefined}
      onPressCallback={onPress ? () => onPress() : undefined}
      enabled={!disabled}
    />
  );
}
