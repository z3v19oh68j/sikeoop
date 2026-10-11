package com.sikeoop.mobile.core

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets.UTF_8
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

enum class FrameDirection(val wireName: String, val prefix: ByteArray) {
    MOBILE_TO_DESKTOP("mobile-to-desktop", byteArrayOf(0x4d, 0x4f, 0x42, 0x31)),
    DESKTOP_TO_MOBILE("desktop-to-mobile", byteArrayOf(0x48, 0x4f, 0x53, 0x31)),
}

data class SealedFrame(
    val version: Int,
    val sessionId: String,
    val direction: String,
    val counter: String,
    val ciphertext: String,
    val tag: String,
)

object MobileCrypto {
    fun decodeBase64Url(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
    fun encodeBase64Url(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)

    fun deriveSessionKey(
        ss: ByteArray,
        es: ByteArray,
        se: ByteArray,
        ee: ByteArray,
        transcriptHash: ByteArray,
        pairingToken: ByteArray = byteArrayOf(),
    ): ByteArray {
        require(listOf(ss, es, se, ee).all { it.size == 32 }) { "P-256 ECDH outputs must each be 32 bytes" }
        require(transcriptHash.size == 32) { "transcriptHash must be SHA-256" }
        require(pairingToken.isEmpty() || pairingToken.size == 32) { "pairingToken must be empty or 32 bytes" }
        val ikm = ByteBuffer.allocate(32 * 4 + 1 + pairingToken.size)
            .put(ss).put(es).put(se).put(ee).put(pairingToken.size.toByte()).put(pairingToken).array()
        val salt = sha256("sikeoop/mobile/v1/kdf/salt\u0000".toByteArray(UTF_8) + transcriptHash)
        return hkdfSha256(ikm, salt, "sikeoop/mobile/v1/session-key".toByteArray(UTF_8), 32)
    }

    fun deriveEcdh(privatePkcs8: ByteArray, peerPublicX509: ByteArray): ByteArray {
        val factory = KeyFactory.getInstance("EC")
        val privateKey: PrivateKey = factory.generatePrivate(PKCS8EncodedKeySpec(privatePkcs8))
        val publicKey: PublicKey = factory.generatePublic(X509EncodedKeySpec(peerPublicX509))
        return KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(publicKey, true)
            generateSecret()
        }
    }

    fun seal(key: ByteArray, sessionId: String, direction: FrameDirection, counter: ULong, plaintext: ByteArray): SealedFrame {
        require(key.size == 32) { "AES-256-GCM key must be 32 bytes" }
        validateSessionId(sessionId)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(direction, counter)))
        cipher.updateAAD(aad(sessionId, direction, counter))
        val sealed = cipher.doFinal(plaintext)
        return SealedFrame(
            version = 1,
            sessionId = sessionId,
            direction = direction.wireName,
            counter = counter.toString(),
            ciphertext = encodeBase64Url(sealed.copyOfRange(0, sealed.size - 16)),
            tag = encodeBase64Url(sealed.copyOfRange(sealed.size - 16, sealed.size)),
        )
    }

    fun open(key: ByteArray, frame: SealedFrame, expectedDirection: FrameDirection, expectedCounter: ULong): ByteArray {
        require(frame.version == 1 && frame.direction == expectedDirection.wireName) { "wrong frame version or direction" }
        require(frame.counter.matches(Regex("0|[1-9][0-9]*"))) { "invalid frame counter" }
        val counter = frame.counter.toULongOrNull() ?: throw IllegalArgumentException("frame counter out of range")
        require(counter == expectedCounter) { "replayed or out-of-order frame" }
        require(key.size == 32) { "AES-256-GCM key must be 32 bytes" }
        validateSessionId(frame.sessionId)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(expectedDirection, counter)))
        cipher.updateAAD(aad(frame.sessionId, expectedDirection, counter))
        return cipher.doFinal(decodeBase64Url(frame.ciphertext) + decodeBase64Url(frame.tag))
    }

    private fun nonce(direction: FrameDirection, counter: ULong): ByteArray =
        ByteBuffer.allocate(12).put(direction.prefix).putLong(counter.toLong()).array()

    private fun aad(sessionId: String, direction: FrameDirection, counter: ULong): ByteArray {
        validateSessionId(sessionId)
        return "sikeoop-mobile-v1\n$sessionId\n${direction.wireName}\n$counter".toByteArray(UTF_8)
    }

    private fun validateSessionId(value: String) {
        require(value.matches(Regex("[A-Za-z0-9_-]{8,128}"))) { "invalid sessionId" }
    }

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32))
        val prk = hmacSha256(salt, ikm)
        val output = ByteArray(length)
        var previous = byteArrayOf()
        var offset = 0
        var block = 1
        while (offset < length) {
            previous = hmacSha256(prk, previous + info + byteArrayOf(block.toByte()))
            val count = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, count)
            offset += count
            block++
        }
        return output
    }
}
