#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

@implementation AppDelegate {
  BOOL _trafficLightOffsetsRecorded;
  CGFloat _closeOrigX, _miniOrigX, _zoomOrigX, _origY;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"signal-app";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];
  
  [super applicationDidFinishLaunching:notification];

  // Configure window for liquid glass (macOS Tahoe)
  NSWindow *window = [NSApp mainWindow];
  if (!window) {
    window = [[NSApp windows] firstObject];
  }
  if (window) {
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    window.backgroundColor = [NSColor windowBackgroundColor];

    // Move traffic light buttons inside the conversation panel
    // Sidebar panel is at left:12, top:12 with borderRadius:16
    [self repositionTrafficLights:window];
    [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResizeNotification
                                                      object:window
                                                       queue:[NSOperationQueue mainQueue]
                                                  usingBlock:^(NSNotification *note) {
      [self repositionTrafficLights:note.object];
    }];
  }
}

- (void)repositionTrafficLights:(NSWindow *)window
{
  NSButton *closeButton = [window standardWindowButton:NSWindowCloseButton];
  NSButton *miniButton = [window standardWindowButton:NSWindowMiniaturizeButton];
  NSButton *zoomButton = [window standardWindowButton:NSWindowZoomButton];

  if (!closeButton.superview) return;

  // Record original x positions once (they don't change with resize)
  if (!_trafficLightOffsetsRecorded) {
    _closeOrigX = closeButton.frame.origin.x;
    _miniOrigX = miniButton.frame.origin.x;
    _zoomOrigX = zoomButton.frame.origin.x;
    _origY = closeButton.frame.origin.y;
    _trafficLightOffsetsRecorded = YES;
  }

  CGFloat xOffset = 20;
  CGFloat yOffset = -16;
  NSSize size = closeButton.frame.size;

  closeButton.frame = NSMakeRect(_closeOrigX + xOffset, _origY + yOffset, size.width, size.height);
  miniButton.frame = NSMakeRect(_miniOrigX + xOffset, _origY + yOffset, size.width, size.height);
  zoomButton.frame = NSMakeRect(_zoomOrigX + xOffset, _origY + yOffset, size.width, size.height);
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
