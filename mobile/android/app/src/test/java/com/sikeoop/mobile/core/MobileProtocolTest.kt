package com.sikeoop.mobile.core

import java.io.File
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileProtocolTest {
    @Test
    fun allDesktopFixturesParseAsJsonRpc() {
        val directory = File(javaClass.classLoader!!.getResource("fixtures")!!.toURI())
        val fixtures = directory.listFiles { file -> file.extension == "json" }!!.sortedBy { it.name }
        assertEquals("expected all checked-in P0 JSON fixtures", 26, fixtures.size)
        fixtures.forEach { fixture ->
            val frame = MobileProtocol.parseFrame(fixture.readText())
            assertEquals("2.0", frame.jsonrpc)
        }
    }

    @Test
    fun typedChatRequestCanBeDecodedAfterDispatch() {
        val file = File(javaClass.classLoader!!.getResource("fixtures/chat.send.request.json")!!.toURI())
        val frame = MobileProtocol.parseFrame(file.readText())
        val params = MobileProtocol.json.decodeFromJsonElement<RpcRequestBody>(frame.params!!)
        assertEquals("修复登录接口", params.text)
        assertEquals("lazy", params.mode)
    }

    @Test
    fun parserRejectsWrongVersionAndNonAllowlistedMethods() {
        val wrongVersion = """{"jsonrpc":"1.0","id":"1","method":"chat.send","params":{}}"""
        val unknown = """{"jsonrpc":"2.0","id":"1","method":"filesystem.read","params":{}}"""
        runCatching { MobileProtocol.parseFrame(wrongVersion) }.onSuccess { error("wrong version accepted") }
        runCatching { MobileProtocol.parseFrame(unknown) }.onSuccess { error("unknown method accepted") }
    }
}
