#import <React/RCTViewManager.h>

@interface DropTargetViewManager : RCTViewManager
@end

@implementation DropTargetViewManager

RCT_EXPORT_MODULE(DropTargetView)

- (NSView *)view
{
  Class cls = NSClassFromString(@"DropTargetView");
  if (cls) {
    return [[cls alloc] initWithFrame:NSZeroRect];
  }
  return [[NSView alloc] initWithFrame:NSZeroRect];
}

RCT_EXPORT_VIEW_PROPERTY(onFileDrop, RCTBubblingEventBlock)

@end
