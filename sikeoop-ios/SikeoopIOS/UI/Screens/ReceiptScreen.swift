import SwiftUI

/// 回执：本鲸一句话总结、改了哪些文件、你拍板的事、被拦下的事、她自己的决定、撤销。对应设计稿 Receipt。
struct ReceiptScreen: View {
    let receipt: Receipt
    var onBack: () -> Void = {}
    var onUndo: () -> Void = {}
    var onOpenDiff: () -> Void = {}

    @State private var confirm = false

    var body: some View {
        VStack(spacing: 0) {
            BackHeader(title: "回执", onBack: onBack) {
                Text(receipt.time)
                    .font(.system(size: 13))
                    .foregroundColor(Sk.muted)
                    .padding(.trailing, 8)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 14) {
                        WhaleImage(pose: .lazy, size: 84, ring: 5)
                        Text(receipt.summary)
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(Sk.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Sk.card, in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Sk.fieldLine, lineWidth: 1))
                    }

                    if !receipt.files.isEmpty {
                        SkCard(padding: 14, gap: 8) {
                            HStack {
                                Text("改了 \(receipt.files.count) 个文件")
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundColor(Sk.ink)
                                Spacer()
                                Button(action: onOpenDiff) {
                                    Text("看改动")
                                        .font(.system(size: 13))
                                        .foregroundColor(Sk.blueInk)
                                        .padding(4)
                                }
                                .buttonStyle(.plain)
                            }
                            ForEach(receipt.files) { f in
                                FileRow(f: f)
                            }
                        }
                    }

                    ResultSection(title: "你拍板的事", items: receipt.approved, color: Sk.ok2)
                    ResultSection(title: "被拦下的事", items: receipt.blocked, color: Sk.warn)

                    if !receipt.decisions.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SectionLabel("本鲸自己做的决定")
                            SkCard(radius: 16, padding: 12, gap: 6) {
                                ForEach(receipt.decisions, id: \.self) { line in
                                    Text(line)
                                        .font(.system(size: 14))
                                        .foregroundColor(Sk.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }

            VStack(spacing: 6) {
                SecondaryPill("撤销这一轮", action: { confirm = true }, minHeight: 50, weight: .medium)
                Text("已推送的提交和命令做过的事撤不回")
                    .font(.system(size: 12))
                    .foregroundColor(Sk.muted)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Sk.bg)
        .alert("撤销这一轮？", isPresented: $confirm) {
            Button("再想想", role: .cancel) {}
            Button("撤销", role: .destructive) { onUndo() }
        } message: {
            Text("改过的文件回到修改前。已推送的提交和命令做过的事撤不回。")
        }
    }
}

private struct FileRow: View {
    let f: FileChange

    var body: some View {
        HStack(spacing: 10) {
            Text(f.badge)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .foregroundColor(f.kind == .added ? Sk.ok2 : (f.kind == .deleted ? Sk.warn : Sk.blueInk))
            Text(f.path)
                .font(.system(size: 13, design: .monospaced))
                .foregroundColor(Sk.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            let counts = [f.added.map { "+\($0)" }, (f.removed ?? 0) > 0 ? f.removed.map { "−\($0)" } : nil]
                .compactMap { $0 }
                .joined(separator: " ")
            if !counts.isEmpty {
                Text(counts)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(Sk.muted)
            }
        }
    }
}

/// 「命令：说明」一条一行，命令用等宽字，说明靠右上色。
private struct ResultSection: View {
    let title: String
    let items: [String]
    let color: Color

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("\(title) · \(items.count)")
                ForEach(items, id: \.self) { line in
                    let parts = line.splitOnce()
                    SkCard(radius: 16, padding: 12, gap: 10) {
                        HStack(spacing: 10) {
                            Text(parts.0)
                                .font(.system(size: 14, design: .monospaced))
                                .foregroundColor(Sk.ink)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if !parts.1.isEmpty {
                                Text(parts.1)
                                    .font(.system(size: 14))
                                    .foregroundColor(color)
                            }
                        }
                    }
                }
            }
        }
    }
}

private extension String {
    /// 按第一个「：」或「:」切成命令和说明。
    func splitOnce() -> (String, String) {
        for sep in ["：", ":"] {
            if let idx = firstIndex(of: Character(sep)) {
                return (String(self[..<idx]).trimmingCharacters(in: .whitespaces),
                        String(self[index(after: idx)...]).trimmingCharacters(in: .whitespaces))
            }
        }
        return (self, "")
    }
}

#Preview {
    ReceiptScreen(receipt: FakeLink().state.receipts[0])
}
