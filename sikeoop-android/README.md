# sikeoop 安卓版（工程骨架）

独立的安卓工程，不放在 `sweet-code-desktop/` 里面。需求见 `../mobile-design/sikeoop-android-prd.md`，技术方案见 `../mobile-design/sikeoop-android.md`，线框见 `../mobile-design/sikeoop-android-wireframes.md`。

现在是 P0 骨架 + P1 界面：**界面全都能点，数据是假的**（`FakeLink`）。连接层（中继、加密、协议收发）还没实现。

## 怎么跑

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"   # Android Studio 装的 SDK
./gradlew :app:assembleDebug                      # 打出 app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug                       # 装到插着的手机 / 模拟器上
```

或者用 Android Studio 打开这个文件夹，直接点运行。

## 结构

```
app/src/main/java/com/sikeoop/mobile/
  MainActivity.kt          入口，挂上主题和导航
  core/
    model/Models.kt        数据模型：七种状态、计划、审批卡、回执
    protocol/Messages.kt   协议 v1 的消息形状和方法名（对齐电脑端 src/shared/protocol.ts）
    LinkService.kt         任务进行中的常驻通知（前台服务）
  link/
    LinkContract.kt        界面和连接层的接口 ← 换真连接只动这层
    FakeLink.kt            假数据源，按钮会真的改状态
  ui/
    AppRoot.kt             底部三个标签 + 二级页
    theme/Theme.kt         设计令牌，和桌面版一套颜色
    components/WhaleAvatar.kt   状态头像（表情占位）
    screens/               首页、待办、任务详情、回执、配对、保活、我的
```

## 界面和 PRD 的对应

| PRD | 在哪 |
|---|---|
| 首页「本鲸」7 种状态 | `HomeScreen.kt` + `WhaleAvatar.kt` |
| 任务详情、计划四态 | `TaskDetailScreen.kt` |
| 待办（审批卡带倒计时、置灰） | `TodoScreen.kt` |
| 回执详情 + 撤销 | `ReceiptScreen.kt` |
| 扫码配对 | `PairScreen.kt`（相机是占位） |
| 保活引导 | `KeepAliveScreen.kt` |
| 我的 | `MyScreen.kt` |

## 已知的占位和没做的事

- **连接层没实现**：`FakeLink` 只管假数据。中继、端到端加密、协议收发是 P1 的活。
- **鲸鱼娘是表情占位**：P1 从 `../whale-girl-svg/` 导出静止画面（PNG/WebP）放进 `res/drawable`，在 `WhaleAvatar.kt` 里换掉。别把几个 SVG 内联进同一个页面，id 会互相覆盖。
- **通知栏图标**：`res/drawable/ic_whale.xml` 是占位剪影，出正式单色剪影后替换。
- **相机扫码**：P1 接 ZXing。
- 构建有 6 条 deprecation 警告（`Icons.Default.ArrowBack` 等要换成 `Icons.AutoMirrored.*`），不影响运行。
- 版本：Gradle 8.9 / AGP 8.7.3 / Kotlin 2.0.21 / Compose BOM 2024.10.01 / minSdk 26 / compileSdk 35。
