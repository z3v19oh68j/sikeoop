package com.sikeoop.mobile.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.sikeoop.mobile.R

/**
 * 任务进行中保持连接的常驻通知（前台服务，类型 remoteMessaging）。
 * P1 接上真连接后，进度一行跟着任务更新；现在先把通知的壳搭好。
 */
class LinkService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel_link), NotificationManager.IMPORTANCE_LOW),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_whale)
            // 文案和样式照设计稿 Notify：标题带进度，正文一句话，品牌色进度条。
            // 进度现在是写死的占位，接上真连接后跟着任务更新。
            .setContentTitle("本鲸在干活 · 2/5")
            .setContentText("正在跑测试")
            .setProgress(5, 2, false)
            .setColor(0xFFC4402C.toInt())
            .setColorized(false)
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        return START_STICKY
    }

    companion object {
        const val CHANNEL_ID = "link"
        const val NOTIF_ID = 1
    }
}
