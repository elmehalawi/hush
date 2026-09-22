export type CornerStyle = {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
};

// Per-corner radii for media in a message run. The spine is the side the
// sender's bubbles hang from: right for outgoing, left for incoming.
export function mediaCorners(isOutgoing: boolean, spineTop: number, spineBottom: number, outer: number): CornerStyle {
  return isOutgoing
    ? {borderTopLeftRadius: outer, borderBottomLeftRadius: outer, borderTopRightRadius: spineTop, borderBottomRightRadius: spineBottom}
    : {borderTopRightRadius: outer, borderBottomRightRadius: outer, borderTopLeftRadius: spineTop, borderBottomLeftRadius: spineBottom};
}
