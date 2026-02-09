import React from 'react';
import {requireNativeComponent, ViewStyle} from 'react-native';

interface GlassContainerViewProps {
  style?: ViewStyle;
  children?: React.ReactNode;
}

const NativeGlassContainerView = requireNativeComponent<any>('GlassContainerView');

export function GlassContainerView({style, children}: GlassContainerViewProps) {
  return (
    <NativeGlassContainerView style={style}>
      {children}
    </NativeGlassContainerView>
  );
}
