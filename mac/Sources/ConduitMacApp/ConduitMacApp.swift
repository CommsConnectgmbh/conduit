import SwiftUI

@main
struct ConduitMacApp: App {
    @StateObject private var tabs = TabModel()

    init() {
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(tabs)
                .frame(minWidth: 900, minHeight: 600)
                .background(WindowAccessor())
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact(showsTitle: false))
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Neuer Tab") { tabs.newTab() }
                    .keyboardShortcut("t", modifiers: .command)
                Button("Tab schließen") { tabs.closeActive() }
                    .keyboardShortcut("w", modifiers: .command)
                Divider()
                Button("Nächster Tab") { tabs.nextTab() }
                    .keyboardShortcut("]", modifiers: [.command, .shift])
                Button("Vorheriger Tab") { tabs.prevTab() }
                    .keyboardShortcut("[", modifiers: [.command, .shift])
                Divider()
                ForEach(1...9, id: \.self) { n in
                    Button("Tab \(n)") { tabs.activateIndex(n - 1) }
                        .keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
                }
            }
            CommandGroup(replacing: .textEditing) {}
            CommandGroup(after: .toolbar) {
                Button("Neu laden") { tabs.reloadActive() }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

// Style the hosting NSWindow once it's available.
struct WindowAccessor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            if let win = v.window {
                win.titleVisibility = .hidden
                win.titlebarAppearsTransparent = true
                win.styleMask.insert(.fullSizeContentView)
                win.isMovableByWindowBackground = true
                win.backgroundColor = NSColor.windowBackgroundColor
            }
        }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
