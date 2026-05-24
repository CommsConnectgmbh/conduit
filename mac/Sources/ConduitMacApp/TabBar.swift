import SwiftUI

struct TabBar: View {
    @EnvironmentObject var tabs: TabModel

    var body: some View {
        HStack(spacing: 6) {
            // traffic-light gutter
            Spacer().frame(width: 72)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(tabs.tabs) { tab in
                        TabPill(tab: tab)
                    }
                }
                .padding(.horizontal, 2)
            }

            Button {
                tabs.newTab()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Neuer Tab (⌘T)")

            Spacer(minLength: 8)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(height: 40)
    }
}

struct TabPill: View {
    @EnvironmentObject var tabs: TabModel
    @ObservedObject var tab: TabItem
    @State private var hovering = false

    var body: some View {
        let active = tab.id == tabs.activeID
        HStack(spacing: 6) {
            if tab.isLoading {
                ProgressView()
                    .controlSize(.mini)
                    .scaleEffect(0.6)
                    .frame(width: 10, height: 10)
            } else {
                Circle()
                    .fill(active ? Color.accentColor : Color.secondary.opacity(0.5))
                    .frame(width: 6, height: 6)
            }
            Text(tab.title.isEmpty ? "Neuer Chat" : tab.title)
                .lineLimit(1)
                .truncationMode(.tail)
                .font(.system(size: 12, weight: active ? .medium : .regular))
                .foregroundStyle(active ? Color.primary : Color.secondary)
            Spacer(minLength: 0)
            if hovering || active {
                Button {
                    tabs.close(tab.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Tab schließen (⌘W)")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .frame(width: 180, height: 28)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(active
                      ? Color(nsColor: .controlBackgroundColor)
                      : (hovering ? Color.secondary.opacity(0.08) : Color.clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(active ? Color.secondary.opacity(0.18) : Color.clear, lineWidth: 0.5)
        )
        .contentShape(Rectangle())
        .onTapGesture { tabs.activate(tab.id) }
        .onHover { hovering = $0 }
    }
}
