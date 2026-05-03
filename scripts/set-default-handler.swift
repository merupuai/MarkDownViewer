// set-default-handler.swift — make Markdown Viewer the default app for .md files.
// Uses LaunchServices' LSSetDefaultRoleHandlerForContentType (deprecated but
// still functional through current macOS versions).
import Foundation
import CoreServices

let bundleID = "com.local.markdownviewer"
let utis = [
    "net.daringfireball.markdown",
    "com.local.markdownviewer.md",
    "com.local.markdownviewer.markdown",
    "com.local.markdownviewer.mdown",
    "com.local.markdownviewer.mkd",
    "com.local.markdownviewer.mkdn",
    "com.local.markdownviewer.mdx",
]
for uti in utis {
    let status = LSSetDefaultRoleHandlerForContentType(uti as CFString, .viewer, bundleID as CFString)
    print("\(uti) -> \(status)")
}
