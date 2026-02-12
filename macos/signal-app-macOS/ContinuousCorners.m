#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

// Swizzle CALayer's setCornerRadius: so every rounded corner in the app
// automatically uses the continuous (squircle) curve that macOS Tahoe uses
// for window chrome.  This makes React Native borderRadius values visually
// match the system window corners without per-view opt-in.

@implementation CALayer (ContinuousCorners)

+ (void)load
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Method original = class_getInstanceMethod(self, @selector(setCornerRadius:));
    Method swizzled = class_getInstanceMethod(self, @selector(cc_setCornerRadius:));
    if (original && swizzled) {
      method_exchangeImplementations(original, swizzled);
    }
  });
}

- (void)cc_setCornerRadius:(CGFloat)radius
{
  // Call the original implementation (swizzled)
  [self cc_setCornerRadius:radius];

  if (radius > 0) {
    self.cornerCurve = kCACornerCurveContinuous;
  }
}

@end
