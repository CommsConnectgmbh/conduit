# conduit-mac

Tiny native macOS wrapper around the [Conduit PWA](https://github.com/CommsConnectgmbh/conduit) — SwiftUI + `WKWebView` per tab, Chrome-style multi-tab layout, shared cookie store so logging in once covers every tab. Each tab is an independent Claude session.

Ad-hoc signed — for local use, no notarization. Drop the PWA URL in `TabModel.swift` and you're done.

## Build + install

```bash
bash scripts/make-icon.sh    # one time — generate AppIcon.icns from a 512px source
bash scripts/install.sh      # build release, copy to /Applications, launch
```

Or just build and run from the repo:
```bash
bash scripts/build.sh
open dist/Conduit.app
```

## Shortcuts

| Shortcut | Action                |
|----------|-----------------------|
| ⌘T       | New tab               |
| ⌘W       | Close active tab      |
| ⌘⇧]      | Next tab              |
| ⌘⇧[      | Previous tab          |
| ⌘1 … ⌘9  | Activate tab N        |
| ⌘R       | Reload active tab     |

## Stack

Swift 6, SwiftUI, `WKWebView`, Swift Package Manager (no Xcode project needed). macOS 14+. Bundle ID `de.example.conduit` — change in `Resources/Info.plist` and `Package.swift` if you fork.

## Configure your URL

`Sources/ConduitMacApp/TabModel.swift` line ~13:
```swift
url: URL = URL(string: "https://conduit.example.com")!
```
Replace with your own Conduit deployment.

## License

MIT — see `LICENSE`.
