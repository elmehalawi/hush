// @ts-ignore - DynamicColorMacOS is a macOS-specific export from react-native-macos
import {DynamicColorMacOS} from 'react-native';

export const colors = {
  label: DynamicColorMacOS({light: '#212121', dark: '#EBEBF0'}),
  secondaryLabel: DynamicColorMacOS({light: '#757575', dark: '#EBEBF099'}),
  tertiaryLabel: DynamicColorMacOS({light: '#9e9e9e', dark: '#EBEBF04D'}),
  separator: DynamicColorMacOS({light: 'rgba(0,0,0,0.1)', dark: 'rgba(255,255,255,0.1)'}),
  incomingBubble: DynamicColorMacOS({light: '#e0e0e0', dark: '#2A2A2C'}),
  incomingBody: DynamicColorMacOS({light: '#212121', dark: '#EBEBF0'}),
  sidebarBackground: DynamicColorMacOS({light: '#F5F5F5', dark: '#2B2B2B'}),
  sidebarSeparator: DynamicColorMacOS({light: 'rgba(0,0,0,0.12)', dark: 'rgba(255,255,255,0.12)'}),
  sidebarSelected: DynamicColorMacOS({light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.10)'}),
  searchFieldBackground: DynamicColorMacOS({light: 'rgba(0,0,0,0.06)', dark: 'rgba(255,255,255,0.08)'}),
};
