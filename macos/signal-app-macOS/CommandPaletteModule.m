#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(CommandPaletteModule, RCTEventEmitter)

RCT_EXTERN_METHOD(updateChannels:(NSArray *)channels)
RCT_EXTERN_METHOD(show)
RCT_EXTERN_METHOD(hide)

@end
