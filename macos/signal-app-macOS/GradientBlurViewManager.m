#import <React/RCTViewManager.h>

@interface GradientBlurViewManager : RCTViewManager
@end

@implementation GradientBlurViewManager

RCT_EXPORT_MODULE(GradientBlurView)

- (NSView *)view
{
  Class cls = NSClassFromString(@"GradientBlurWrapperView");
  if (cls) {
    return [[cls alloc] initWithFrame:NSZeroRect];
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

@end
