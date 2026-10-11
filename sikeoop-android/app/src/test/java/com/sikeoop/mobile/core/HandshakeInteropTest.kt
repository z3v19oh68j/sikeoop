package com.sikeoop.mobile.core

import com.sikeoop.mobile.core.crypto.DeviceIdentity
import com.sikeoop.mobile.core.crypto.PairingQr
import com.sikeoop.mobile.core.crypto.computer
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * 和真的电脑端网关对握：test/mobile/gateway-harness.mjs 起一个本地中继 + 网关（会自动允许），
 * 这里用 Kotlin 的握手扫码配对、调 RPC，再不扫码重连一次。电脑上没有 node 时跳过。
 */
class HandshakeInteropTest {
    private val harness = File("../../test/mobile/gateway-harness.mjs").canonicalFile

    private fun node(): String? = listOf("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node").firstOrNull { File(it).canExecute() }
        ?: System.getenv("PATH")?.split(File.pathSeparator)?.map { File(it, "node") }?.firstOrNull { it.canExecute() }?.path

    @Test
    fun pairsCallsAndReconnectsWithTheDesktopGateway() = runBlocking {
        val node = node()
        assumeTrue("node not found", node != null && harness.exists())
        val proc = ProcessBuilder(node, harness.path).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        try {
            val line = proc.inputStream.bufferedReader().readLine() ?: error("harness gave no QR")
            val qr = PairingQr.parse(Json.parseToJsonElement(line).jsonObject["qr"]!!.jsonPrimitive.content)
            assertEquals("互通测试电脑", qr.computerName)
            val http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
            val device = DeviceIdentity.create("互通测试手机")

            val first = RelaySession(http)
            val approved = async {
                first.events.filterIsInstance<RelaySession.Event.Notification>()
                    .first { it.method == "mobile.pairing" && it.params.str("status") == "approved" }
            }
            first.open(qr.computer(), device, qr)
            withTimeout(10_000) { approved.await() }
            assertEquals("session.snapshot", first.call("session.snapshot").str("echo"))
            first.close()

            // 不扫码重连：已登记的设备密钥，新的会话。
            kotlinx.coroutines.delay(200)
            val again = RelaySession(http)
            again.open(qr.computer(), device)
            assertEquals("agents.list", again.call("agents.list").str("echo"))
            again.close()
            http.dispatcher.executorService.shutdown()
        } finally {
            proc.outputStream.close()
            proc.waitFor(5, TimeUnit.SECONDS)
            proc.destroy()
        }
    }
}
