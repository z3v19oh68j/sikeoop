package com.sikeoop.mobile.core.crypto

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets.UTF_8
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 手机这一端的握手（protocol/PAIRING.md + CRYPTO.md）。纯 JVM 代码，不碰 Android，
 * 所以单元测试能直接和真的电脑端网关对握（app/src/test/.../HandshakeInteropTest.kt）。
 */

private val b64 = MobileCrypto::encodeBase64Url
private fun unb64(s: String) = MobileCrypto.decodeBase64Url(s)
private val random = SecureRandom()

fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }
fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)
fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
    init(SecretKeySpec(key, "HmacSHA256"))
    doFinal(data)
}

/** 每个字段写成 u16be(长度) + 字节；字符串是 UTF-8，Int 是两字节的协议版本号。 */
fun canonical(vararg fields: Any): ByteArray {
    val out = ByteArrayOutputStream()
    for (f in fields) {
        val bytes = when (f) {
            is String -> f.toByteArray(UTF_8)
            is ByteArray -> f
            is Int -> byteArrayOf((f shr 8 and 0xff).toByte(), (f and 0xff).toByte())
            else -> error("bad canonical field")
        }
        require(bytes.size <= 0xffff) { "handshake field too long" }
        out.write(bytes.size shr 8 and 0xff)
        out.write(bytes.size and 0xff)
        out.write(bytes)
    }
    return out.toByteArray()
}

/** 一对 P-256 密钥：私钥 PKCS#8 DER，公钥 SPKI DER。 */
class P256(val privatePkcs8: ByteArray, val publicSpki: ByteArray) {
    companion object {
        fun generate(): P256 {
            val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            return P256(kp.private.encoded, kp.public.encoded)
        }
    }

    fun sign(data: ByteArray): ByteArray {
        val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(privatePkcs8))
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(data)
            sign()
        }
    }

    fun dh(peerSpki: ByteArray): ByteArray = MobileCrypto.deriveEcdh(privatePkcs8, peerSpki)
}

fun verifyP256(publicSpki: ByteArray, data: ByteArray, signature: ByteArray): Boolean = try {
    val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicSpki))
    Signature.getInstance("SHA256withECDSA").run {
        initVerify(key)
        update(data)
        verify(signature)
    }
} catch (_: Exception) {
    false
}

/** 二维码里的内容（sikeoop://pair/…）。 */
data class PairingQr(
    val relayUrl: String,
    val roomId: String,
    val roomToken: String,
    val computerId: String,
    val computerName: String,
    val pairId: String,
    val expiresAt: Long,
    val pairingToken: ByteArray,
    val computerSigningPublicKey: String,
    val computerStaticDhPublicKey: String,
) {
    companion object {
        private const val PREFIX = "sikeoop://pair/"

        /** 不是 sikeoop 的配对码、格式不对或已经过期时抛出，消息直接给人看。 */
        fun parse(payload: String, now: Long = System.currentTimeMillis()): PairingQr {
            require(payload.startsWith(PREFIX)) { "这不是 sikeoop 的配对二维码" }
            val o = try {
                Json.parseToJsonElement(String(unb64(payload.removePrefix(PREFIX)), UTF_8)) as JsonObject
            } catch (_: Exception) {
                throw IllegalArgumentException("二维码内容读不懂，请在电脑上重新生成")
            }
            fun s(k: String) = o[k]?.jsonPrimitive?.content ?: throw IllegalArgumentException("二维码缺少 $k，请更新电脑上的 sikeoop")
            require(o["v"]?.jsonPrimitive?.content == "1") { "二维码版本不对，请更新 sikeoop" }
            val qr = PairingQr(
                relayUrl = s("relayUrl"),
                roomId = s("roomId"),
                roomToken = s("roomToken"),
                computerId = s("computerId"),
                computerName = s("computerName"),
                pairId = s("pairId"),
                expiresAt = s("expiresAt").toLong(),
                pairingToken = unb64(s("pairingToken")),
                computerSigningPublicKey = s("computerSigningPublicKey"),
                computerStaticDhPublicKey = s("computerStaticDhPublicKey"),
            )
            require(qr.expiresAt > now) { "二维码过期了，请在电脑上重新生成" }
            require(qr.pairingToken.size == 32) { "二维码内容不完整" }
            require(qr.relayUrl.startsWith("wss://") || qr.relayUrl.startsWith("ws://")) { "中继地址不对" }
            return qr
        }
    }
}

/** 已经配对的电脑：重连时不用二维码，只要这些。 */
data class PairedComputer(
    val relayUrl: String,
    val roomId: String,
    val roomToken: String,
    val computerId: String,
    val computerName: String,
    val computerSigningPublicKey: String,
    val computerStaticDhPublicKey: String,
)

/** 这台手机的长期身份：设备 id、签名密钥、静态 DH 密钥。 */
data class DeviceIdentity(val deviceId: String, val deviceName: String, val signing: P256, val staticDh: P256) {
    companion object {
        fun create(deviceName: String) = DeviceIdentity(b64(randomBytes(16)), deviceName.take(64).ifBlank { "安卓手机" }, P256.generate(), P256.generate())
    }
}

/** 握手完成后的会话。 */
class SessionKeys(val sessionId: String, val key: ByteArray)

/**
 * 一次握手：hello → (challenge) → authenticate。
 * pairing 不为空是第一次配对（带一次性证明），为空是已配对设备重连。
 */
class PhoneHandshake(
    private val computer: PairedComputer,
    private val device: DeviceIdentity,
    private val pairing: PairingQr? = null,
) {
    private val ephemeral = P256.generate()
    private val clientNonce = randomBytes(32)
    private var session: SessionKeys? = null

    fun hello(): JsonObject {
        val pairId = pairing?.pairId
        val digest = sha256(
            canonical(
                "sikeoop/mobile/v1/hello", 1, computer.roomId, pairId ?: "", device.deviceId, device.deviceName,
                device.signing.publicSpki, device.staticDh.publicSpki, ephemeral.publicSpki, clientNonce,
            ),
        )
        return buildJsonObject {
            put("t", "hello")
            put("v", 1)
            put("roomId", computer.roomId)
            if (pairing != null) put("pairId", pairing.pairId)
            put("deviceId", device.deviceId)
            put("deviceName", device.deviceName)
            put("deviceSigningPublicKey", b64(device.signing.publicSpki))
            put("deviceStaticDhPublicKey", b64(device.staticDh.publicSpki))
            put("deviceEphemeralPublicKey", b64(ephemeral.publicSpki))
            put("clientNonce", b64(clientNonce))
            if (pairing != null) put("helloProof", b64(hmacSha256(pairing.pairingToken, digest)))
        }
    }

    /** 检查电脑的 challenge，返回要发回去的 authenticate；对不上就抛出（这台不是二维码里的那台电脑）。 */
    fun answer(challenge: JsonObject): JsonObject {
        fun s(k: String) = challenge[k]?.jsonPrimitive?.content ?: throw HandshakeException("challenge 缺少 $k")
        if (s("t") != "challenge") throw HandshakeException("电脑拒绝了连接")
        // 电脑的身份必须和二维码（或第一次配对时存下的）完全一致，否则可能是冒充的。
        if (s("computerSigningPublicKey") != computer.computerSigningPublicKey ||
            s("computerStaticDhPublicKey") != computer.computerStaticDhPublicKey ||
            s("computerId") != computer.computerId
        ) throw HandshakeException("这台电脑的身份和配对时不一样")
        val compEph = unb64(s("computerEphemeralPublicKey"))
        val base = canonical(
            "sikeoop/mobile/v1/handshake", 1, computer.roomId, pairing?.pairId ?: "", computer.computerId,
            device.deviceId, device.deviceName,
            unb64(computer.computerSigningPublicKey), unb64(computer.computerStaticDhPublicKey),
            device.signing.publicSpki, device.staticDh.publicSpki,
            compEph, ephemeral.publicSpki, clientNonce, unb64(s("serverNonce")),
        )
        val compSig = unb64(s("computerSignature"))
        if (!verifyP256(unb64(computer.computerSigningPublicKey), base, compSig)) throw HandshakeException("电脑的签名不对")
        val devSig = device.signing.sign(base + compSig)
        val compDh = unb64(computer.computerStaticDhPublicKey)
        val key = MobileCrypto.deriveSessionKey(
            ss = device.staticDh.dh(compDh),
            es = ephemeral.dh(compDh),
            se = device.staticDh.dh(compEph),
            ee = ephemeral.dh(compEph),
            transcriptHash = sha256(canonical(base, compSig, devSig)),
            pairingToken = pairing?.pairingToken ?: byteArrayOf(),
        )
        val sessionId = s("sessionId")
        session = SessionKeys(sessionId, key)
        return buildJsonObject {
            put("t", "authenticate")
            put("v", 1)
            put("sessionId", sessionId)
            put("deviceSignature", b64(devSig))
        }
    }

    fun session(): SessionKeys = session ?: throw HandshakeException("握手还没完成")
}

class HandshakeException(message: String) : Exception(message)

fun PairingQr.computer() = PairedComputer(relayUrl, roomId, roomToken, computerId, computerName, computerSigningPublicKey, computerStaticDhPublicKey)
