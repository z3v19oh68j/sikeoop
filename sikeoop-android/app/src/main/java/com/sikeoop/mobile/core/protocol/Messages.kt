package com.sikeoop.mobile.core.protocol

/**
 * 协议 v1 的消息形状。唯一来源是电脑端的 `src/shared/protocol.ts`，
 * 这里只声明手机端要用的那部分，字段名保持一致。
 * Kotlin 端手写模型，不靠代码生成；两边的测试都读 `protocol/fixtures/` 里的样例。
 */
object Protocol {
    const val VERSION = 1
}

/** 请求：{"jsonrpc":"2.0","id":1,"method":"chat.send","params":{...}} */
data class RpcRequest(
    val jsonrpc: String = "2.0",
    val id: Long,
    val method: String,
    val params: Map<String, Any?>? = null,
)

data class RpcError(val code: Int, val message: String)

data class RpcResponse(
    val jsonrpc: String = "2.0",
    val id: Long,
    val result: Any? = null,
    val error: RpcError? = null,
)

/** 内核发给客户端的五种通知。 */
sealed interface ServerNotice {
    /** AgentEvent 原样转发，遇到不认识的类型直接忽略。 */
    data class Event(val type: String, val payload: Map<String, Any?> = emptyMap()) : ServerNotice

    /** 鲸鱼娘当前的状态。 */
    data class Status(val status: String) : ServerNotice

    /** 需要人回应的请求。 */
    data class Ask(val id: String, val kind: String, val payload: Map<String, Any?> = emptyMap()) : ServerNotice

    /** 电脑在线还是离线。 */
    data class Presence(val online: Boolean) : ServerNotice

    /** 内核的警告。 */
    data class Log(val level: String, val message: String) : ServerNotice
}

/** 手机端能调的方法名，见设计稿 §7。 */
object Methods {
    const val INITIALIZE = "initialize"
    const val SESSION_SNAPSHOT = "session.snapshot"
    const val CHAT_SEND = "chat.send"
    const val CHAT_CANCEL = "chat.cancel"
    const val APPROVAL_RESPOND = "approval.respond"
    const val QUESTION_ANSWER = "question.answer"
    const val TURN_UNDO = "turn.undo"
    const val DIFF_GET = "diff.get"
    const val AGENTS_LIST = "agents.list"
    const val AGENTS_RESPOND = "agents.respond"
}
