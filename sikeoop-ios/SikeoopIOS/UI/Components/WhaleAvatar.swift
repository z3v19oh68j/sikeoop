import SwiftUI

/// 鲸鱼娘的几张静止画面。
enum WhalePose: String {
    case work, sleepy, waiting, lazy, error

    var imageName: String { "whale_\(rawValue)" }
}

extension WhaleStatus {
    var pose: WhalePose {
        switch self {
        case .idle: return .sleepy
        case .working: return .work
        case .waiting: return .waiting
        case .done: return .lazy
        case .error: return .error
        case .halted: return .sleepy
        case .offline: return .sleepy
        }
    }
}

/// 状态头像：圆形白底 + 一圈 #F3ECE4 外环；离线时灰度加半透明。动画版放 P3。
struct WhaleAvatar: View {
    let status: WhaleStatus
    var size: CGFloat = 196

    var body: some View {
        WhaleImage(
            pose: status.pose,
            size: size,
            ring: max(size / 24, 5),
            dim: status == .offline,
        )
    }
}

struct WhaleImage: View {
    let pose: WhalePose
    var size: CGFloat
    var ring: CGFloat = 5
    var dim: Bool = false

    var body: some View {
        Image(pose.imageName)
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
            .background(Circle().fill(Sk.card))
            .saturation(dim ? 0 : 1)
            .opacity(dim ? 0.6 : 1)
            .padding(ring)
            .background(Circle().fill(Sk.ring))
    }
}
