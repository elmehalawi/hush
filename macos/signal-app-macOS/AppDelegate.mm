#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <Sparkle/Sparkle.h>
#import <QuartzCore/QuartzCore.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"signal-app";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];
  
  [super applicationDidFinishLaunching:notification];

  // Configure window chrome
  NSWindow *window = [NSApp mainWindow];
  if (!window) {
    window = [[NSApp windows] firstObject];
  }
  if (window) {
    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    window.backgroundColor = [NSColor windowBackgroundColor];

    // Add an empty toolbar for unified toolbar style.
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"MainToolbar"];
    toolbar.showsBaselineSeparator = NO;
    window.toolbar = toolbar;
    window.toolbarStyle = NSWindowToolbarStyleUnified;

    // Golden Gate: traffic lights stay in default position for edge-to-edge sidebar
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
