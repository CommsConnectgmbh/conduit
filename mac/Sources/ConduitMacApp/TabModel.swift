import Foundation
import SwiftUI

@MainActor
final class TabItem: ObservableObject, Identifiable {
    let id = UUID()
    @Published var title: String
    @Published var url: URL
    @Published var isLoading: Bool = false

    init(title: String = "New chat",
         url: URL = URL(string: "https://conduit.example.com")!) {
        self.title = title
        self.url = url
    }
}

@MainActor
final class TabModel: ObservableObject {
    @Published var tabs: [TabItem]
    @Published var activeID: UUID

    init() {
        let initial = TabItem()
        self.tabs = [initial]
        self.activeID = initial.id
    }

    func newTab() {
        let t = TabItem()
        tabs.append(t)
        activeID = t.id
    }

    func close(_ id: UUID) {
        guard let idx = tabs.firstIndex(where: { $0.id == id }) else { return }
        let wasActive = (id == activeID)
        tabs.remove(at: idx)
        if tabs.isEmpty {
            newTab()
            return
        }
        if wasActive {
            activeID = tabs[max(0, idx - 1)].id
        }
    }

    func closeActive() { close(activeID) }

    func activate(_ id: UUID) { activeID = id }

    func activateIndex(_ idx: Int) {
        guard tabs.indices.contains(idx) else { return }
        activeID = tabs[idx].id
    }

    func nextTab() {
        guard let i = tabs.firstIndex(where: { $0.id == activeID }) else { return }
        let next = (i + 1) % tabs.count
        activeID = tabs[next].id
    }

    func prevTab() {
        guard let i = tabs.firstIndex(where: { $0.id == activeID }) else { return }
        let prev = (i - 1 + tabs.count) % tabs.count
        activeID = tabs[prev].id
    }

    func reloadActive() {
        NotificationCenter.default.post(name: .conduitReloadTab, object: activeID)
    }
}

extension Notification.Name {
    static let conduitReloadTab = Notification.Name("conduitReloadTab")
}
