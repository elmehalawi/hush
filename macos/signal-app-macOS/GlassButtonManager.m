#import <React/RCTViewManager.h>

@interface GlassButtonManager : RCTViewManager
@end

@implementation GlassButtonManager

RCT_EXPORT_MODULE(GlassButton)

- (NSView *)view
{
  if (@available(macOS 26.0, *)) {
    Class cls = NSClassFromString(@"GlassButtonView");
    if (cls) {
      return [[cls alloc] initWithFrame:NSZeroRect];
    }
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

RCT_EXPORT_VIEW_PROPERTY(title, NSString)
RCT_EXPORT_VIEW_PROPERTY(symbolName, NSString)
RCT_EXPORT_VIEW_PROPERTY(bezelColor, NSColor)
RCT_EXPORT_VIEW_PROPERTY(enabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onPressCallback, RCTBubblingEventBlock)

@end
