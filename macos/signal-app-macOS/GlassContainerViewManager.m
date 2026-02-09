#import <React/RCTViewManager.h>

@interface GlassContainerViewManager : RCTViewManager
@end

@implementation GlassContainerViewManager

RCT_EXPORT_MODULE(GlassContainerView)

- (NSView *)view
{
  if (@available(macOS 26.0, *)) {
    Class cls = NSClassFromString(@"GlassContainerWrapperView");
    if (cls) {
      return [[cls alloc] initWithFrame:NSZeroRect];
    }
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

@end
