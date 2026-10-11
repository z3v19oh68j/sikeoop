package com.sikeoop.mobile.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

const val MOBILE_PROTOCOL_VERSION = 1

@Serializable
data class RpcError(val code: Int, val message: String, val data: JsonElement? = null)

/** Flexible JSON-RPC 2.0 frame. Method-specific DTOs are decoded only after allowlist dispatch. */
@Serializable
data class RpcFrame(
    val jsonrpc: String,
    val id: JsonPrimitive? = null,
    val method: String? = null,
    val params: JsonObject? = null,
    val result: JsonElement? = null,
    val error: RpcError? = null,
)

@Serializable
data class RpcRequestBody(val requestId: String, val text: String, val mode: String = "lazy")

object MobileProtocol {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    val allowedMethods = setOf(
        "initialize", "session.snapshot", "chat.send", "chat.cancel", "approval.respond",
        "question.answer", "turn.undo", "diff.get", "agents.list", "agents.respond",
    )

    fun parseFrame(text: String): RpcFrame {
        val frame = json.decodeFromString<RpcFrame>(text)
        require(frame.jsonrpc == "2.0") { "Unsupported JSON-RPC version" }
        require((frame.method != null) xor (frame.result != null || frame.error != null)) { "Invalid JSON-RPC frame shape" }
        if (frame.method != null) require(frame.method in allowedMethods || frame.method.startsWith("mobile.")) { "Unknown RPC method" }
        return frame
    }
}
