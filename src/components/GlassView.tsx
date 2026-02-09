import React from 'react';
import {requireNativeComponent, processColor, ViewStyle} from 'react-native';

interface GlassViewProps {
  style?: ViewStyle;
  cornerRadius?: number;
  tintColor?: string;
  children?: React.ReactNode;
}

const NativeGlassEffectView = requireNativeComponent<any>('GlassEffectView');

export function GlassView({style, cornerRadius, tintColor, children}: GlassViewProps) {
  return (
    <NativeGlassEffectView
      style={style}
      cornerRadius={cornerRadius}
      glassTintColor={tintColor ? processColor(tintColor) : undefined}>
      {children}
    </NativeGlassEffectView>
  );
}
