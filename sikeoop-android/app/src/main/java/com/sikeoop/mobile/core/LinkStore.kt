package com.sikeoop.mobile.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.sikeoop.mobile.core.crypto.DeviceIdentity
import com.sikeoop.mobile.core.crypto.MobileCrypto
import com.sikeoop.mobile.core.crypto.P256
import com.sikeoop.mobile.core.crypto.PairedComputer
import java.io.File
import java.nio.charset.StandardCharsets.UTF_8
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 小块机密数据的存取。App 里用 Keystore 加密（[KeystoreSecrets]），测试里可以换成内存版。 */
interface SecretStore {
    fun load(name: String): ByteArray?
    fun save(name: String, data: ByteArray)
    fun delete(name: String)
}

/**
 * 用 Android Keystore 里的 AES-256-GCM 密钥加密，文件放在 noBackupFilesDir（不进系统备份、也不进云备份）。
 * Keystore 里的密钥本身导不出来：换手机、刷机后这些数据就读不出了，只能重新扫码配对，这是有意的。
 */
class KeystoreSecrets(context: Context) : SecretStore {
    private val dir = File(context.noBackupFilesDir, "link").apply { mkdirs() }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    override fun load(name: String): ByteArray? {
        val f = File(dir, "$name.bin")
        if (!f.exists()) return null
        return try {
            val raw = f.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
            cipher.doFinal(raw, 12, raw.size - 12)
        } catch (_: Exception) {
            null // 密钥没了（刷机、清数据）：当作没有，重新配对
        }
    }

    override fun save(name: String, data: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(data)
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(out)
        tmp.renameTo(File(dir, "$name.bin"))
    }

    override fun delete(name: String) {
        File(dir, "$name.bin").delete()
    }

    private companion object {
        const val ALIAS = "sikeoop-link"
    }
}

/** 这台手机的身份和已配对的电脑，存在 [SecretStore] 里。 */
class LinkStore(private val secrets: SecretStore) {
    private val json = Json { ignoreUnknownKeys = true }

    fun identity(defaultName: String): DeviceIdentity {
        secrets.load(IDENTITY)?.let { raw ->
            runCatching {
                val o = json.parseToJsonElement(String(raw, UTF_8)).jsonObject
                fun s(k: String) = o[k]!!.jsonPrimitive.content
                return DeviceIdentity(
                    s("deviceId"),
                    s("deviceName"),
                    P256(MobileCrypto.decodeBase64Url(s("signingPrivate")), MobileCrypto.decodeBase64Url(s("signingPublic"))),
                    P256(MobileCrypto.decodeBase64Url(s("dhPrivate")), MobileCrypto.decodeBase64Url(s("dhPublic"))),
                )
            }
        }
        val created = DeviceIdentity.create(defaultName)
        val o = buildJsonObject {
            put("deviceId", created.deviceId)
            put("deviceName", created.deviceName)
            put("signingPrivate", MobileCrypto.encodeBase64Url(created.signing.privatePkcs8))
            put("signingPublic", MobileCrypto.encodeBase64Url(created.signing.publicSpki))
            put("dhPrivate", MobileCrypto.encodeBase64Url(created.staticDh.privatePkcs8))
            put("dhPublic", MobileCrypto.encodeBase64Url(created.staticDh.publicSpki))
        }
        secrets.save(IDENTITY, o.toString().toByteArray(UTF_8))
        return created
    }

    fun computer(): PairedComputer? {
        val raw = secrets.load(COMPUTER) ?: return null
        return runCatching {
            val o = json.parseToJsonElement(String(raw, UTF_8)) as JsonObject
            fun s(k: String) = o[k]!!.jsonPrimitive.content
            PairedComputer(s("relayUrl"), s("roomId"), s("roomToken"), s("computerId"), s("computerName"), s("computerSigningPublicKey"), s("computerStaticDhPublicKey"))
        }.getOrNull()
    }

    fun saveComputer(c: PairedComputer) {
        val o = buildJsonObject {
            put("relayUrl", c.relayUrl)
            put("roomId", c.roomId)
            put("roomToken", c.roomToken)
            put("computerId", c.computerId)
            put("computerName", c.computerName)
            put("computerSigningPublicKey", c.computerSigningPublicKey)
            put("computerStaticDhPublicKey", c.computerStaticDhPublicKey)
        }
        secrets.save(COMPUTER, o.toString().toByteArray(UTF_8))
    }

    fun forgetComputer() = secrets.delete(COMPUTER)

    private companion object {
        const val IDENTITY = "identity"
        const val COMPUTER = "computer"
    }
}
