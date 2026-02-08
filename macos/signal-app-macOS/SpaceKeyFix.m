#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Fix: React Native macOS's RCTTextInputComponentView.focus calls
// [window makeFirstResponder:RCTWrappedTextView]. But RCTWrappedTextView
// is a plain NSView wrapper, NOT an NSTextView. So after focus, keyDown:
// events go to the wrapper (which can't handle text input) instead of
// the real RCTUITextView (NSTextView subclass) inside it.
//
// Fix: intercept makeFirstResponder: and when the target is an
// RCTWrappedTextView, find and substitute the actual NSTextView within.

static IMP sOriginalMakeFirstResponder = NULL;

static NSTextView *findTextViewInView(NSView *view) {
  for (NSView *subview in view.subviews) {
    if ([subview isKindOfClass:[NSTextView class]]) {
      return (NSTextView *)subview;
    }
    NSTextView *found = findTextViewInView(subview);
    if (found) return found;
  }
  return nil;
}

static BOOL swizzled_makeFirstResponder(id self, SEL _cmd, NSResponder *responder) {
  static Class sWrappedClass = Nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    sWrappedClass = NSClassFromString(@"RCTWrappedTextView");
  });

  if (sWrappedClass && [responder isKindOfClass:sWrappedClass] && [responder isKindOfClass:[NSView class]]) {
    NSTextView *realTextView = findTextViewInView((NSView *)responder);
    if (realTextView) {
      responder = realTextView;
    }
  }

  return ((BOOL(*)(id, SEL, NSResponder *))sOriginalMakeFirstResponder)(self, _cmd, responder);
}

__attribute__((constructor))
static void installSpaceKeyFix(void) {
  Method m = class_getInstanceMethod([NSWindow class], @selector(makeFirstResponder:));
  sOriginalMakeFirstResponder = method_getImplementation(m);
  method_setImplementation(m, (IMP)swizzled_makeFirstResponder);
}
