#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Fix scroll behavior for React Native macOS scroll views on macOS Tahoe.
// Disables responsive scrolling, strips unwanted horizontal deltas,
// and caps vertical overscroll to prevent infinite scrolling.

static const CGFloat kMaxOverscroll = 100.0;

static BOOL swizzled_responsiveScrolling_NO(id self, SEL _cmd) {
  return NO;
}

static void disableResponsiveScrollingOnAllClasses(void) {
  int numClasses = objc_getClassList(NULL, 0);
  Class *classes = (Class *)malloc(sizeof(Class) * numClasses);
  numClasses = objc_getClassList(classes, numClasses);
  for (int i = 0; i < numClasses; i++) {
    Class superCls = class_getSuperclass(classes[i]);
    while (superCls) {
      if (superCls == [NSScrollView class]) {
        Method m = class_getClassMethod(classes[i], @selector(isCompatibleWithResponsiveScrolling));
        if (m) method_setImplementation(m, (IMP)swizzled_responsiveScrolling_NO);
        break;
      }
      superCls = class_getSuperclass(superCls);
    }
  }
  free(classes);
  Method m = class_getClassMethod([NSScrollView class], @selector(isCompatibleWithResponsiveScrolling));
  if (m) method_setImplementation(m, (IMP)swizzled_responsiveScrolling_NO);
}

// Clamp clip view bounds so overscroll never exceeds kMaxOverscroll.
static BOOL sIsClamping = NO;

static void clampClipView(NSClipView *clipView) {
  if (sIsClamping) return;

  NSScrollView *sv = (NSScrollView *)clipView.superview;
  if (![sv isKindOfClass:[NSScrollView class]]) return;

  NSView *documentView = sv.documentView;
  if (!documentView) return;

  NSRect docFrame = documentView.frame;
  NSRect clipBounds = clipView.bounds;
  CGFloat maxX = MAX(0, docFrame.size.width - clipBounds.size.width);
  CGFloat maxY = MAX(0, docFrame.size.height - clipBounds.size.height);

  CGFloat clampedX = MAX(-kMaxOverscroll, MIN(clipBounds.origin.x, maxX + kMaxOverscroll));
  CGFloat clampedY = MAX(-kMaxOverscroll, MIN(clipBounds.origin.y, maxY + kMaxOverscroll));

  if (!sv.hasHorizontalScroller) {
    clampedX = MAX(0, MIN(clipBounds.origin.x, maxX));
  }

  if (clampedX != clipBounds.origin.x || clampedY != clipBounds.origin.y) {
    sIsClamping = YES;
    [clipView scrollToPoint:NSMakePoint(clampedX, clampedY)];
    [sv reflectScrolledClipView:clipView];
    sIsClamping = NO;
  }
}

// Strip horizontal deltas on scroll views without a horizontal scroller.
static IMP sOrigScrollWheel = NULL;

static void swizzled_scrollWheel(id self, SEL _cmd, NSEvent *event) {
  NSScrollView *sv = (NSScrollView *)self;
  sv.horizontalScrollElasticity = NSScrollElasticityNone;
  sv.verticalScrollElasticity = NSScrollElasticityAllowed;

  if (!sv.hasHorizontalScroller && event.scrollingDeltaX != 0.0) {
    CGEventRef cgEvent = CGEventCreateCopy(event.CGEvent);
    if (cgEvent) {
      CGEventSetDoubleValueField(cgEvent, kCGScrollWheelEventFixedPtDeltaAxis2, 0);
      CGEventSetIntegerValueField(cgEvent, kCGScrollWheelEventDeltaAxis2, 0);
      CGEventSetDoubleValueField(cgEvent, kCGScrollWheelEventPointDeltaAxis2, 0);
      NSEvent *modified = [NSEvent eventWithCGEvent:cgEvent];
      CFRelease(cgEvent);
      if (modified) {
        ((void(*)(id, SEL, NSEvent *))sOrigScrollWheel)(self, _cmd, modified);
        return;
      }
    }
  }

  ((void(*)(id, SEL, NSEvent *))sOrigScrollWheel)(self, _cmd, event);
}

// Enable bounds change notifications on clip views during layout.
static IMP sOrigNSScrollViewLayout = NULL;

static void swizzled_NSScrollView_layout(id self, SEL _cmd) {
  ((void(*)(id, SEL))sOrigNSScrollViewLayout)(self, _cmd);
  NSClipView *clipView = ((NSScrollView *)self).contentView;
  if (clipView && !clipView.postsBoundsChangedNotifications) {
    clipView.postsBoundsChangedNotifications = YES;
  }
}

__attribute__((constructor))
static void installScrollFix(void) {
  disableResponsiveScrollingOnAllClasses();

  Method m = class_getInstanceMethod([NSScrollView class], @selector(scrollWheel:));
  sOrigScrollWheel = method_getImplementation(m);
  method_setImplementation(m, (IMP)swizzled_scrollWheel);

  Method layoutMethod = class_getInstanceMethod([NSScrollView class], @selector(layout));
  sOrigNSScrollViewLayout = method_getImplementation(layoutMethod);
  method_setImplementation(layoutMethod, (IMP)swizzled_NSScrollView_layout);

  [[NSNotificationCenter defaultCenter]
    addObserverForName:NSViewBoundsDidChangeNotification
                object:nil
                 queue:nil
            usingBlock:^(NSNotification *note) {
    if ([note.object isKindOfClass:[NSClipView class]]) {
      clampClipView((NSClipView *)note.object);
    }
  }];
}
