import SwiftUI

struct ContentView: View {
    @EnvironmentObject var tabs: TabModel

    var body: some View {
        VStack(spacing: 0) {
            TabBar()
            Divider().opacity(0.4)
            ZStack {
                ForEach(tabs.tabs) { tab in
                    WebViewView(tab: tab)
                        .opacity(tab.id == tabs.activeID ? 1 : 0)
                        .allowsHitTesting(tab.id == tabs.activeID)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor).ignoresSafeArea())
    }
}
