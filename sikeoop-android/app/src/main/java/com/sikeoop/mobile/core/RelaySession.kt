package com.sikeoop.mobile.core

import com.sikeoop.mobile.core.crypto.DeviceIdentity
import com.sikeoop.mobile.core.crypto.FrameDirection
import com.sikeoop.mobile.core.crypto.HandshakeException
import com.sikeoop.mobile.core.crypto.MobileCrypto
import com.sikeoop.mobile.core.crypto.PairedComputer
import com.sikeoop.mobile.core.crypto.PairingQr
import com.sikeoop.mobile.core.crypto.PhoneHandshake
import com.sikeoop.mobile.core.crypto.SealedFrame
import com.sikeoop.mobile.core.crypto.SessionKeys
import java.nio.charset.StandardCharsets.UTF_8
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * 到电脑的一条连接：连中继、加入房间、握手（PAIRING.md），然后用加密帧收发 JSON-RPC。
 * 一个对象只用一次：断了就丢掉，重连时新建（新的临时密钥、新的会话）。纯 JVM，单元测试能直接跑。
 */
class RelaySession(private val http: OkHttpClient) {

    sealed interface Event {
        /** 电脑推来的通知：mobile.event / mobile.status / mobile.pairing / … */
        data class Notification(val method: String, val params: JsonElement?) : Event
        data class Presence(val desktopOnline: Boolean) : Event
        data class Closed(val reason: String) : Event
    }

    class RpcException(val code: Int, message: String) : Exception(message)

    private val json = Json { ignoreUnknownKeys = true }
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 512)
    val events: SharedFlow<Event> = _events

    private var ws: WebSocket? = null
    private val joined = CompletableDeferred<Unit>()
    private val handshakeInbox = Channel<JsonObject>(Channel.BUFFERED)
    private var keys: SessionKeys? = null
    private var sendCounter = 0UL
    private var recvCounter = 0UL
    private val lock = Any()
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    @Volatile private var closed = false

    /** 连上并握手。pairing 不为空 = 第一次配对。失败抛出，消息给人看。 */
    suspend fun open(computer: PairedComputer, device: DeviceIdentity, pairing: PairingQr? = null, timeoutMs: Long = 15_000) {
        val request = Request.Builder().url(computer.relayUrl).build()
        ws = http.newWebSocket(request, Listener())
        withTimeout(timeoutMs) {
            joinMessage(computer)
            joined.await()
            val hs = PhoneHandshake(computer, device, pairing)
            sendHandshake(hs.hello())
            val auth = hs.answer(handshakeInbox.receive())
            synchronized(lock) { keys = hs.session() }
            sendHandshake(auth)
        }
    }

    private fun joinMessage(c: PairedComputer) {
        ws?.send(
            buildJsonObject {
                put("type", "join")
                put("protocolVersion", 1)
                put("roomId", c.roomId)
                put("roomToken", c.roomToken)
                put("role", "mobile")
            }.toString(),
        )
    }

    private fun sendHandshake(msg: JsonObject) {
        val payload = MobileCrypto.encodeBase64Url(msg.toString().toByteArray(UTF_8))
        ws?.send(buildJsonObject { put("type", "handshake"); put("payload", payload) }.toString())
    }

    /** 调一个 RPC，返回 result；电脑回了错误就抛 RpcException。 */
    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 20_000): JsonElement {
        val id = nextId.getAndIncrement().toString()
        val waiter = CompletableDeferred<JsonElement>()
        pending[id] = waiter
        try {
            sendSealed(buildJsonObject { put("jsonrpc", "2.0"); put("id", id); put("method", method); put("params", params) })
            return withTimeout(timeoutMs) { waiter.await() }
        } finally {
            pending.remove(id)
        }
    }

    private fun sendSealed(msg: JsonObject) {
        val frame = synchronized(lock) {
            val k = keys ?: throw IllegalStateException("还没连上电脑")
            MobileCrypto.seal(k.key, k.sessionId, FrameDirection.MOBILE_TO_DESKTOP, sendCounter++, msg.toString().toByteArray(UTF_8))
        }
        val body = buildJsonObject {
            put("type", "data")
            put(
                "frame",
                buildJsonObject {
                    put("version", frame.version)
                    put("sessionId", frame.sessionId)
                    put("direction", frame.direction)
                    put("counter", frame.counter)
                    put("ciphertext", frame.ciphertext)
                    put("tag", frame.tag)
                },
            )
        }
        if (ws?.send(body.toString()) != true) throw IllegalStateException("连接已经断了")
    }

    fun close(reason: String = "已断开") {
        if (closed) return
        closed = true
        ws?.close(1000, null)
        fail(reason)
    }

    private fun fail(reason: String) {
        closed = true
        if (!joined.isCompleted) joined.completeExceptionally(HandshakeException(reason))
        handshakeInbox.close(HandshakeException(reason))
        pending.values.forEach { it.completeExceptionally(IllegalStateException(reason)) }
        synchronized(lock) { keys?.key?.fill(0); keys = null }
        _events.tryEmit(Event.Closed(reason))
    }

    private fun onFrame(o: JsonObject) {
        val plain = synchronized(lock) {
            val k = keys ?: return
            val frame = SealedFrame(
                version = o["version"]?.jsonPrimitive?.intOrNull ?: 0,
                sessionId = o["sessionId"]?.jsonPrimitive?.content ?: "",
                direction = o["direction"]?.jsonPrimitive?.content ?: "",
                counter = o["counter"]?.jsonPrimitive?.content ?: "",
                ciphertext = o["ciphertext"]?.jsonPrimitive?.content ?: "",
                tag = o["tag"]?.jsonPrimitive?.content ?: "",
            )
            if (frame.sessionId != k.sessionId) return
            try {
                MobileCrypto.open(k.key, frame, FrameDirection.DESKTOP_TO_MOBILE, recvCounter).also { recvCounter++ }
            } catch (_: Exception) {
                null
            }
        }
        if (plain == null) {
            // 重放、乱序或被改过的帧：这条连接不能再信了。
            close("收到异常数据，已断开重连")
            return
        }
        val msg = try {
            json.parseToJsonElement(String(plain, UTF_8)).jsonObject
        } catch (_: Exception) {
            return
        }
        val id = (msg["id"] as? JsonPrimitive)?.content
        val method = msg["method"]?.jsonPrimitive?.content
        if (method != null) {
            _events.tryEmit(Event.Notification(method, msg["params"]))
        } else if (id != null) {
            val waiter = pending[id] ?: return
            val err = msg["error"] as? JsonObject
            if (err != null) {
                waiter.completeExceptionally(RpcException(err["code"]?.jsonPrimitive?.int ?: -1, err["message"]?.jsonPrimitive?.content ?: "电脑那边出错了"))
            } else {
                waiter.complete(msg["result"] ?: JsonObject(emptyMap()))
            }
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.length > 1_100_000) return
            val m = try {
                json.parseToJsonElement(text).jsonObject
            } catch (_: Exception) {
                return
            }
            when (m["type"]?.jsonPrimitive?.content) {
                "joined" -> joined.complete(Unit)
                "error" -> {
                    val code = m["code"]?.jsonPrimitive?.content
                    close(
                        when (code) {
                            "ROOM_NOT_FOUND" -> "电脑不在线（电脑上的手机连接没打开）"
                            "AUTH_FAILED" -> "电脑换了配对信息，请重新扫码"
                            "ROLE_BUSY" -> "已经有一台手机连着这台电脑"
                            "KICKED" -> "电脑断开了这台手机（没通过验证，或已被移除）"
                            else -> "中继拒绝了连接（$code）"
                        },
                    )
                }
                "presence" -> if (m["role"]?.jsonPrimitive?.content == "desktop") {
                    val online = m["online"]?.jsonPrimitive?.content == "true"
                    _events.tryEmit(Event.Presence(online))
                    if (!online) close("电脑断开了")
                }
                "forward" -> {
                    val env = m["envelope"] as? JsonObject ?: return
                    when (env["type"]?.jsonPrimitive?.content) {
                        "handshake" -> {
                            val payload = env["payload"]?.jsonPrimitive?.content ?: return
                            val msg = try {
                                json.parseToJsonElement(String(MobileCrypto.decodeBase64Url(payload), UTF_8)).jsonObject
                            } catch (_: Exception) {
                                return
                            }
                            handshakeInbox.trySend(msg)
                        }
                        "data" -> (env["frame"] as? JsonObject)?.let { onFrame(it) }
                    }
                }
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!closed) fail("连接断开了")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!closed) fail("连不上中继：${t.message ?: t.javaClass.simpleName}")
        }
    }
}

/** 一些 JSON 读取的小工具。 */
internal fun JsonElement?.str(key: String): String? = (this as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.content }
internal fun JsonElement?.long(key: String): Long? = (this as? JsonObject)?.get(key)?.let { (it as? JsonPrimitive)?.longOrNull }
