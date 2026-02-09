#import <React/RCTViewManager.h>

@interface GlassEffectViewManager : RCTViewManager
@end

@implementation GlassEffectViewManager

RCT_EXPORT_MODULE(GlassEffectView)

- (NSView *)view
{
  if (@available(macOS 26.0, *)) {
    Class cls = NSClassFromString(@"GlassEffectWrapperView");
    if (cls) {
      return [[cls alloc] initWithFrame:NSZeroRect];
    }
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

RCT_EXPORT_VIEW_PROPERTY(cornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(glassTintColor, NSColor)

@end
