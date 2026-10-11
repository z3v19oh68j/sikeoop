package com.sikeoop.mobile.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MobileCryptoTest {
    private val vector by lazy {
        val file = File(javaClass.classLoader!!.getResource("crypto-vectors.json")!!.toURI())
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun hex(value: String): ByteArray {
        require(value.length % 2 == 0)
        return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    private fun string(name: String) = vector.getValue(name).jsonPrimitive.content

    @Test
    fun ecdhHkdfAndAesGcmMatchDesktopVector() {
        val privateKeys = vector.getValue("privateKeysPkcs8DerBase64Url").jsonArray.map { MobileCrypto.decodeBase64Url(it.jsonPrimitive.content) }
        val publicKeys = vector.getValue("publicKeysSpkiDerBase64Url").jsonArray.map { MobileCrypto.decodeBase64Url(it.jsonPrimitive.content) }
        val secrets = mapOf(
            "ss" to MobileCrypto.deriveEcdh(privateKeys[0], publicKeys[2]),
            "es" to MobileCrypto.deriveEcdh(privateKeys[1], publicKeys[2]),
            "se" to MobileCrypto.deriveEcdh(privateKeys[0], publicKeys[3]),
            "ee" to MobileCrypto.deriveEcdh(privateKeys[1], publicKeys[3]),
        )
        val expectedDh = vector.getValue("ecdhSecretsHex").jsonObject
        secrets.forEach { (name, value) -> assertEquals(name, expectedDh.getValue(name).jsonPrimitive.content, value.joinToString("") { "%02x".format(it) }) }

        val key = MobileCrypto.deriveSessionKey(
            ss = secrets.getValue("ss"), es = secrets.getValue("es"), se = secrets.getValue("se"), ee = secrets.getValue("ee"),
            transcriptHash = hex(string("transcriptHashHex")), pairingToken = hex(string("pairingTokenHex")),
        )
        assertArrayEquals(hex(string("sessionKeyHex")), key)

        val expectedFrame = vector.getValue("frame").jsonObject
        val plaintext = expectedFrame.getValue("plaintextUtf8").jsonPrimitive.content.toByteArray(Charsets.UTF_8)
        val sealed = MobileCrypto.seal(key, "vector-session-01", FrameDirection.MOBILE_TO_DESKTOP, 7u, plaintext)
        assertEquals(expectedFrame.getValue("ciphertext").jsonPrimitive.content, sealed.ciphertext)
        assertEquals(expectedFrame.getValue("tag").jsonPrimitive.content, sealed.tag)
        assertArrayEquals(plaintext, MobileCrypto.open(key, sealed, FrameDirection.MOBILE_TO_DESKTOP, 7u))
    }

    @Test
    fun frameAuthenticationReplayAndDirectionAreEnforced() {
        val key = hex(string("sessionKeyHex"))
        val frame = vector.getValue("frame").jsonObject
        val plaintext = frame.getValue("plaintextUtf8").jsonPrimitive.content.toByteArray(Charsets.UTF_8)
        val sealed = MobileCrypto.seal(key, "vector-session-01", FrameDirection.MOBILE_TO_DESKTOP, 7u, plaintext)
        runCatching { MobileCrypto.open(key, sealed, FrameDirection.MOBILE_TO_DESKTOP, 6u) }.onSuccess { error("replay/out-of-order frame accepted") }
        runCatching { MobileCrypto.open(key, sealed, FrameDirection.DESKTOP_TO_MOBILE, 7u) }.onSuccess { error("wrong direction accepted") }
        val tampered = sealed.copy(ciphertext = if (sealed.ciphertext.startsWith("A")) "B${sealed.ciphertext.drop(1)}" else "A${sealed.ciphertext.drop(1)}")
        runCatching { MobileCrypto.open(key, tampered, FrameDirection.MOBILE_TO_DESKTOP, 7u) }.onSuccess { error("tampered frame accepted") }
    }
}
