#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Fix scroll behavior for React Native macOS scroll views on macOS Tahoe.
//
// Root causes addressed:
// 1. RCTScrollViewComponentView sets autoresizingMask = FlexibleWidth|FlexibleHeight
//    on the document view, which fights with Fabric's frame management and causes
//    the document view to auto-resize to the clip view's size, corrupting content size.
//    Fixed via setDocumentView: and layout swizzles that clear the mask.
// 2. With the autoresizingMask fix in place, vertical elasticity (rubber banding)
//    is enabled for native-feeling scroll behavior.

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

// Cached class for RN scroll view detection
static Class sRNScrollViewClass = nil;

static BOOL isRNScrollView(id sv) {
  return sRNScrollViewClass && [sv isKindOfClass:sRNScrollViewClass];
}

// ---- Fix 1: constrainBoundsRect swizzle ----
// Pass through to the original implementation. The autoresizingMask fixes
// (setDocumentView / layout swizzles) prevent the content-size corruption that
// originally required strict [0, max] clamping. Removing the clamp lets
// NSScrollView handle elastic overscroll naturally.
static IMP sOrigConstrainBoundsRect = NULL;

static NSRect swizzled_constrainBoundsRect(id self, SEL _cmd, NSRect proposedBounds) {
  return ((NSRect(*)(id, SEL, NSRect))sOrigConstrainBoundsRect)(self, _cmd, proposedBounds);
}

// ---- Fix 2: setDocumentView swizzle ----
// Clear autoresizingMask at creation time to prevent it from fighting Fabric's layout.
static IMP sOrigSetDocumentView = NULL;

static void swizzled_setDocumentView(id self, SEL _cmd, NSView *view) {
  ((void(*)(id, SEL, NSView *))sOrigSetDocumentView)(self, _cmd, view);
  if (view && isRNScrollView(self)) {
    NSAutoresizingMaskOptions mask = view.autoresizingMask;
    if (mask & (NSViewWidthSizable | NSViewHeightSizable)) {
      view.autoresizingMask = mask & ~(NSViewWidthSizable | NSViewHeightSizable);
    }
  }
}

// ---- Fix 3: scrollWheel swizzle ----
// Strip horizontal deltas on scroll views without a horizontal scroller.
// Enable vertical elasticity (rubber banding) for RN scroll views.
static IMP sOrigScrollWheel = NULL;

static void swizzled_scrollWheel(id self, SEL _cmd, NSEvent *event) {
  NSScrollView *sv = (NSScrollView *)self;
  sv.horizontalScrollElasticity = NSScrollElasticityNone;

  if (isRNScrollView(sv)) {
    sv.verticalScrollElasticity = NSScrollElasticityAllowed;
  }

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

// ---- Fix 4: layout swizzle ----
// Enable bounds change notifications, enforce document view sizing.
static IMP sOrigNSScrollViewLayout = NULL;

static void swizzled_NSScrollView_layout(id self, SEL _cmd) {
  ((void(*)(id, SEL))sOrigNSScrollViewLayout)(self, _cmd);
  NSScrollView *sv = (NSScrollView *)self;
  NSClipView *clipView = sv.contentView;
  if (clipView && !clipView.postsBoundsChangedNotifications) {
    clipView.postsBoundsChangedNotifications = YES;
  }

  if (isRNScrollView(sv)) {
    NSView *docView = sv.documentView;
    if (docView) {
      // Belt-and-suspenders: clear autoresizingMask in case setDocumentView swizzle missed it
      NSAutoresizingMaskOptions mask = docView.autoresizingMask;
      if (mask & (NSViewWidthSizable | NSViewHeightSizable)) {
        docView.autoresizingMask = mask & ~(NSViewWidthSizable | NSViewHeightSizable);
      }

      // Ensure document view is at least as tall as the clip view
      NSRect clipFrame = clipView.frame;
      NSRect docFrame = docView.frame;
      if (docFrame.size.height < clipFrame.size.height) {
        docFrame.size.height = clipFrame.size.height;
        docView.frame = docFrame;
      }
    }
  }
}

__attribute__((constructor))
static void installScrollFix(void) {
  sRNScrollViewClass = NSClassFromString(@"RCTEnhancedScrollView");

  disableResponsiveScrollingOnAllClasses();

  // Swizzle constrainBoundsRect: on RCTClipView (which overrides NSClipView's version)
  // to prevent invalid scroll positions from being set.
  Class rctClipViewClass = NSClassFromString(@"RCTClipView");
  if (rctClipViewClass) {
    Method constrainMethod = class_getInstanceMethod(rctClipViewClass, @selector(constrainBoundsRect:));
    sOrigConstrainBoundsRect = method_getImplementation(constrainMethod);
    method_setImplementation(constrainMethod, (IMP)swizzled_constrainBoundsRect);
  } else {
    Method constrainMethod = class_getInstanceMethod([NSClipView class], @selector(constrainBoundsRect:));
    sOrigConstrainBoundsRect = method_getImplementation(constrainMethod);
    method_setImplementation(constrainMethod, (IMP)swizzled_constrainBoundsRect);
  }

  // Swizzle setDocumentView: on NSScrollView — clears autoresizingMask at creation
  Method docViewMethod = class_getInstanceMethod([NSScrollView class], @selector(setDocumentView:));
  sOrigSetDocumentView = method_getImplementation(docViewMethod);
  method_setImplementation(docViewMethod, (IMP)swizzled_setDocumentView);

  // Swizzle scrollWheel: on NSScrollView — strips horizontal deltas, disables elasticity
  Method m = class_getInstanceMethod([NSScrollView class], @selector(scrollWheel:));
  sOrigScrollWheel = method_getImplementation(m);
  method_setImplementation(m, (IMP)swizzled_scrollWheel);

  // Swizzle layout on NSScrollView — enforces document view sizing
  Method layoutMethod = class_getInstanceMethod([NSScrollView class], @selector(layout));
  sOrigNSScrollViewLayout = method_getImplementation(layoutMethod);
  method_setImplementation(layoutMethod, (IMP)swizzled_NSScrollView_layout);
}
