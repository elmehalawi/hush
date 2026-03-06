#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <Sparkle/Sparkle.h>
#import <QuartzCore/QuartzCore.h>

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

    // Add an empty toolbar — toolbar windows get the larger Tahoe
    // squircle corner radius (~26pt) instead of titlebar-only (~16pt).
    // Use .unified (not .unifiedCompact) for the full-size corner radius.
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"MainToolbar"];
    toolbar.showsBaselineSeparator = NO;
    window.toolbar = toolbar;
    window.toolbarStyle = NSWindowToolbarStyleUnified;

    // Move traffic light buttons inside the sidebar panel
    // Sidebar panel is at left:4, top:4 with borderRadius:20
    [self repositionTrafficLights:window];
    [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidResizeNotification
                                                      object:window
                                                       queue:[NSOperationQueue mainQueue]
                                                  usingBlock:^(NSNotification *note) {
      [self repositionTrafficLights:note.object];
    }];
  }

  // Initialize Sparkle updater
  self.updaterController = [[SPUStandardUpdaterController alloc]
                             initWithStartingUpdater:YES
                             updaterDelegate:nil
                             userDriverDelegate:nil];

  // Add "Check for Updates..." to the app menu
  NSMenu *appMenu = [[NSApp mainMenu] itemAtIndex:0].submenu;
  if (appMenu) {
    NSMenuItem *checkForUpdatesItem =
      [[NSMenuItem alloc] initWithTitle:@"Check for Updates..."
                                 action:@selector(checkForUpdates:)
                          keyEquivalent:@""];
    checkForUpdatesItem.target = self.updaterController;
    // Insert after the first separator (or at index 1 if no separator)
    NSInteger insertIndex = 1;
    for (NSInteger i = 0; i < appMenu.numberOfItems; i++) {
      if ([appMenu itemAtIndex:i].isSeparatorItem) {
        insertIndex = i + 1;
        break;
      }
    }
    [appMenu insertItem:checkForUpdatesItem atIndex:insertIndex];

    // Add "Sessions..." menu item
    NSMenuItem *sessionsItem =
      [[NSMenuItem alloc] initWithTitle:@"Sessions..."
                                 action:@selector(openSessions:)
                          keyEquivalent:@""];
    sessionsItem.target = self;
    [appMenu insertItem:sessionsItem atIndex:insertIndex + 1];
  }
}

- (void)openSessions:(id)sender
{
  [[NSNotificationCenter defaultCenter] postNotificationName:@"OpenSessionsSettings" object:nil];
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

  CGFloat xOffset = 12;
  CGFloat yOffset = -8;
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
