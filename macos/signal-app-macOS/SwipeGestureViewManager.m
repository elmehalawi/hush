#import <React/RCTViewManager.h>

@interface SwipeGestureViewManager : RCTViewManager
@end

@implementation SwipeGestureViewManager

RCT_EXPORT_MODULE(SwipeGestureView)

- (NSView *)view
{
  Class cls = NSClassFromString(@"SwipeGestureView");
  if (cls) {
    return [[cls alloc] initWithFrame:NSZeroRect];
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

RCT_EXPORT_VIEW_PROPERTY(onSwipeUpdate, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSwipeEnd, RCTBubblingEventBlock)

@end
