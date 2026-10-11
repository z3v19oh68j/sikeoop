package com.sikeoop.mobile.link

import android.content.Context
import android.os.Build
import com.sikeoop.mobile.core.KeystoreSecrets
import com.sikeoop.mobile.core.LinkStore
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

/** 整个 App 共用一条连接：Activity 重建（转屏、切深色）时不断线。 */
object Links {
    @Volatile private var link: RelayLink? = null

    fun get(context: Context): RelayLink = link ?: synchronized(this) {
        link ?: run {
            val app = context.applicationContext
            val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "0"
            RelayLink(
                store = LinkStore(KeystoreSecrets(app)),
                // 中继 30 秒 ping 一次；读超时关掉，靠 ping 发现断线。
                http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build(),
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                deviceName = listOfNotNull(Build.MANUFACTURER?.replaceFirstChar { it.uppercase() }, Build.MODEL).joinToString(" ").take(64),
                appVersion = version,
            ).also { link = it }
        }
    }
}
