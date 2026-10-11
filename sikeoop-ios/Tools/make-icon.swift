import CoreGraphics
import Foundation
import ImageIO

// 生成 iOS App 图标（1024×1024，不带透明通道）：
// 奶油底色 + 蓝鲸剪影，图案和安卓版启动图标（app/src/main/res/drawable/ic_whale.xml）一致。
// 路径就是那份矢量图里的两段 path，坐标系 24×24、y 轴朝下。
// 用法: swiftc make-icon.swift -o /tmp/make-icon && /tmp/make-icon <输出png>
// 纯 CoreGraphics 画图，不依赖图形界面，命令行里也能跑。

func fail(_ msg: String) -> Never {
    print(msg)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("用法: make-icon <输出png>")
}
let outPath = args[1]

let size = 1024
guard let ctx = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else {
    fail("建不了画布")
}

// 奶油底色（和 Theme.swift 的 Sk.bg 一致）。
ctx.setFillColor(red: 0xFB / 255.0, green: 0xF7 / 255.0, blue: 0xF2 / 255.0, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

// 鲸鱼身体（对应 ic_whale.xml 第一段 path），坐标系 24×24、y 轴朝下。
let body = CGMutablePath()
body.move(to: CGPoint(x: 2.5, y: 12.2))
body.addCurve(to: CGPoint(x: 12.6, y: 4.3), control1: CGPoint(x: 2.5, y: 7.8), control2: CGPoint(x: 7.1, y: 4.3))
body.addCurve(to: CGPoint(x: 19.8, y: 8.8), control1: CGPoint(x: 16.6, y: 4.3), control2: CGPoint(x: 19.8, y: 6.2))
body.addCurve(to: CGPoint(x: 17.5, y: 12.0), control1: CGPoint(x: 19.8, y: 10.1), control2: CGPoint(x: 18.9, y: 11.2))
body.addCurve(to: CGPoint(x: 18.0, y: 15.5), control1: CGPoint(x: 18.7, y: 13.3), control2: CGPoint(x: 19.0, y: 14.8))
body.addCurve(to: CGPoint(x: 14.2, y: 14.6), control1: CGPoint(x: 17.0, y: 16.2), control2: CGPoint(x: 15.4, y: 15.7))
body.addCurve(to: CGPoint(x: 7.5, y: 16.1), control1: CGPoint(x: 12.4, y: 15.5), control2: CGPoint(x: 10.0, y: 16.1))
body.addCurve(to: CGPoint(x: 2.5, y: 12.2), control1: CGPoint(x: 5.4, y: 16.1), control2: CGPoint(x: 2.5, y: 14.4))
body.closeSubpath()

// 尾鳍（对应 ic_whale.xml 第二段 path）。
let fin = CGMutablePath()
fin.move(to: CGPoint(x: 18.2, y: 4.2))
fin.addCurve(to: CGPoint(x: 21.5, y: 3.4), control1: CGPoint(x: 19.4, y: 3.3), control2: CGPoint(x: 20.6, y: 3.0))
fin.addCurve(to: CGPoint(x: 21.7, y: 6.0), control1: CGPoint(x: 22.3, y: 3.8), control2: CGPoint(x: 22.4, y: 4.9))
fin.addCurve(to: CGPoint(x: 18.8, y: 7.7), control1: CGPoint(x: 21.1, y: 7.0), control2: CGPoint(x: 19.9, y: 7.7))
fin.addCurve(to: CGPoint(x: 18.2, y: 6.9), control1: CGPoint(x: 18.4, y: 7.6), control2: CGPoint(x: 18.2, y: 7.3))
fin.closeSubpath()

let shape = CGMutablePath()
shape.addPath(body)
shape.addPath(fin)

// 按图案的实际外框自动居中：放大到画布的 800/1024，并把 y 翻过来（矢量图 y 朝下）。
let box = shape.boundingBoxOfPath
let scale: CGFloat = 800 / max(box.width, box.height)
ctx.translateBy(x: CGFloat(size) / 2, y: CGFloat(size) / 2)
ctx.scaleBy(x: scale, y: -scale)
ctx.translateBy(x: -box.midX, y: -box.midY)

// 蓝鲸色（和 Theme.swift 的 Sk.blue 一致）。
ctx.setFillColor(red: 0x2A / 255.0, green: 0x6F / 255.0, blue: 0x8E / 255.0, alpha: 1)
ctx.addPath(shape)
ctx.fillPath()

guard let out = ctx.makeImage() else {
    fail("合成失败")
}
guard let dest = CGImageDestinationCreateWithURL(
    URL(fileURLWithPath: outPath) as CFURL,
    "public.png" as CFString,
    1,
    nil
) else {
    fail("建不了输出文件: \(outPath)")
}
CGImageDestinationAddImage(dest, out, [kCGImagePropertyHasAlpha: false] as CFDictionary)
guard CGImageDestinationFinalize(dest) else {
    fail("写文件失败")
}
print("已生成: \(outPath)")
