package com.sikeoop.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import com.sikeoop.mobile.link.Links
import com.sikeoop.mobile.ui.AppRoot
import com.sikeoop.mobile.ui.theme.SikeoopTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SikeoopTheme {
                // 走中继的真连接；预览和界面调试仍可换回 FakeLink。
                val link = remember { Links.get(this) }
                AppRoot(link = link)
            }
        }
    }
}
