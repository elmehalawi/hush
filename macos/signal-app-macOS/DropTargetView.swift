import AppKit

@objc(DropTargetView)
class DropTargetView: RCTUIView {
    @objc var onFileDrop: RCTBubblingEventBlock?

    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        return .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        return .copy
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard let pasteboard = sender.draggingPasteboard.propertyList(forType: .init("NSFilenamesPboardType")) as? [String] else {
            // Try alternate approach via readObjects
            if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
                let paths = urls.map { $0.path }
                if !paths.isEmpty {
                    onFileDrop?(["paths": paths])
                    return true
                }
            }
            return false
        }

        if !pasteboard.isEmpty {
            onFileDrop?(["paths": pasteboard])
            return true
        }
        return false
    }

    override func insertReactSubview(_ subview: NSView!, at atIndex: Int) {
        addSubview(subview)
    }

    override func removeReactSubview(_ subview: NSView!) {
        subview.removeFromSuperview()
    }
}
