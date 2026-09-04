// Release-only Metro config: bypasses Watchman.
//
// Watchman cannot watch anything under ~/Documents on this machine (macOS TCC
// blocks it and the request hangs rather than failing), which wedges the
// "Bundle React Native code and images" Xcode phase. The Node crawler needs no
// such permission; blockList keeps it away from the multi-GB Rust target dirs.
const {mergeConfig} = require('@react-native/metro-config');
const base = require('./metro.config.js');

module.exports = mergeConfig(base, {
  resolver: {
    useWatchman: false,
    blockList: [
      /\/rust\/.*\/target\/.*/,
      /\/rust\/ringrtc\/out\/.*/,
      /\/macos\/Pods\/.*/,
      /\/macos\/build\/.*/,
      /\/releases\/.*/,
    ],
  },
});
