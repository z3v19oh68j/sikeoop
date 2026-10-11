package com.sikeoop.mobile.ui.components

import android.Manifest
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.sikeoop.mobile.ui.theme.Sk
import kotlinx.coroutines.delay
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 扫二维码的取景器：CameraX 出画面，ZXing 在后台线程逐帧找二维码，找到一次就回调 onResult。
 * 双击画面在后置和前置摄像头之间切换（拿电脑屏幕对着手机前置摄像头时方便），再双击切回去。
 * 没有相机权限时显示说明和「允许使用相机」。调试版长按画面当作扫码成功（模拟器上没二维码可扫）。
 * overlay 画在画面上面（取景框、扫描线），不接收手势。
 */
@Composable
fun QrScanner(
    onResult: (String) -> Unit,
    modifier: Modifier = Modifier,
    radius: Dp = 28.dp,
    overlay: @Composable BoxScope.() -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val result by rememberUpdatedState(onResult)
    val debuggable = remember { context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 }

    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }

    var front by remember { mutableStateOf(false) }
    // 切换后在画面上短暂提示现在用的是哪个摄像头。
    var hint by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(hint) { if (hint != null) { delay(1400); hint = null } }

    val done = remember { AtomicBoolean(false) }
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    val executor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }

    fun toggle() {
        val provider = runCatching { ProcessCameraProvider.getInstance(context).get() }.getOrNull()
        val want = if (front) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
        if (provider != null && runCatching { !provider.hasCamera(want) }.getOrDefault(false)) {
            hint = if (front) "这台设备没有后置摄像头" else "这台设备没有前置摄像头"
            return
        }
        front = !front
        hint = if (front) "前置摄像头" else "后置摄像头"
    }

    if (granted) {
        DisposableEffect(front, lifecycle) {
            val future = ProcessCameraProvider.getInstance(context)
            var provider: ProcessCameraProvider? = null
            future.addListener({
                val p = future.get().also { provider = it }
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { it.setAnalyzer(executor, QrAnalyzer { text -> if (done.compareAndSet(false, true)) ContextCompat.getMainExecutor(context).execute { result(text) } }) }
                val selector = if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                runCatching {
                    p.unbindAll()
                    p.bindToLifecycle(lifecycle, selector, preview, analysis)
                }.onFailure { hint = "打不开摄像头：${it.message ?: "未知原因"}" }
            }, ContextCompat.getMainExecutor(context))
            onDispose { provider?.unbindAll() }
        }
    }

    Box(
        modifier
            .clip(RoundedCornerShape(radius))
            .background(Sk.Dark2)
            .pointerInput(granted, debuggable) {
                detectTapGestures(
                    onDoubleTap = { if (granted) toggle() },
                    onLongPress = { if (debuggable && done.compareAndSet(false, true)) result("debug://simulated-pair") },
                )
            }
            .semantics {
                customActions = listOf(CustomAccessibilityAction("切换前后摄像头") { if (granted) toggle(); granted })
            },
        contentAlignment = Alignment.Center,
    ) {
        if (granted) {
            AndroidView({ previewView }, Modifier.fillMaxSize())
        } else {
            Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("扫码要用相机", fontSize = 15.sp, color = Sk.Ring)
                PrimaryPill("允许使用相机", { ask.launch(Manifest.permission.CAMERA) }, minHeight = 44.dp, fontSize = 14)
                Text("拒绝过的话，要去系统设置里打开", fontSize = 12.sp, color = Sk.DarkMuted)
            }
        }
        overlay()
        AnimatedVisibility(hint != null, Modifier.align(Alignment.TopCenter).padding(top = 18.dp), enter = fadeIn(), exit = fadeOut()) {
            Text(
                hint.orEmpty(),
                Modifier.background(Sk.Dark.copy(alpha = 0.72f), RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 6.dp),
                fontSize = 13.sp,
                color = Sk.Ring,
            )
        }
    }
}

/** 从每帧的亮度平面里找二维码。前置摄像头的原始帧不是镜像的（镜像只在预览里），所以不用翻转。 */
private class QrAnalyzer(private val onFound: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }
    private var buf = ByteArray(0)

    override fun analyze(image: ImageProxy) {
        image.use {
            val plane = it.planes[0]
            val stride = plane.rowStride
            val size = stride * it.height
            if (buf.size < size) buf = ByteArray(size)
            val src = plane.buffer.apply { rewind() }
            src.get(buf, 0, minOf(src.remaining(), size))
            val source = PlanarYUVLuminanceSource(buf, stride, it.height, 0, 0, it.width, it.height, false)
            try {
                onFound(reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text)
            } catch (_: NotFoundException) {
                // 这一帧没有二维码
            } finally {
                reader.reset()
            }
        }
    }
}
