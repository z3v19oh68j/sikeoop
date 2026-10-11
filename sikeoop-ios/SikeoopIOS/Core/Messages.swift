import Foundation
import CoreFoundation


/// 协议 v1 的消息形状。唯一来源是电脑端的 `src/shared/protocol.ts`，
/// 这里只声明手机端要用的那部分，字段名保持一致。
/// Swift 端手写模型，不靠代码生成；两边的测试都读 `protocol/fixtures/` 里的样例。
enum Proto {
    static let version = 1
}

/// 请求：{"jsonrpc":"2.0","id":1,"method":"chat.send","params":{...}}
struct RpcRequest {
    var jsonrpc: String = "2.0"
    let id: Int
    let method: String
    var params: [String: Any]? = nil
}

struct RpcError: Equatable {
    let code: Int
    let message: String
}

struct RpcResponse {
    var jsonrpc: String = "2.0"
    let id: Int
    var result: Any? = nil
    var error: RpcError? = nil
}

/// 内核发给客户端的五种通知。
enum ServerNotice {
    /// AgentEvent 原样转发，遇到不认识的类型直接忽略。
    case event(type: String, payload: [String: Any])
    /// 鲸鱼娘当前的状态。
    case status(String)
    /// 需要人回应的请求。
    case ask(id: String, kind: String, payload: [String: Any])
    /// 电脑在线还是离线。
    case presence(online: Bool)
    /// 内核的警告。
    case log(level: String, message: String)
}

/// 手机端能调的方法名，见设计稿 §7。
enum Methods {
    static let initialize = "initialize"
    static let sessionSnapshot = "session.snapshot"
    static let chatSend = "chat.send"
    static let chatCancel = "chat.cancel"
    static let approvalRespond = "approval.respond"
    static let questionAnswer = "question.answer"
    static let turnUndo = "turn.undo"
    static let diffGet = "diff.get"
    static let agentsList = "agents.list"
    static let agentsRespond = "agents.respond"
}

/// JSON-RPC permits both integer and string IDs; encrypted mobile RPC uses strings.
enum RpcId: Hashable {
    case number(Int64)
    case string(String)
    var value: Any { switch self { case .number(let n): return n; case .string(let s): return s } }
    init?(_ value: Any?) {
        if let s = value as? String { self = .string(s) }
        else if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.int64Value) { self = .number(n.int64Value) }
        else { return nil }
    }
}

extension RpcRequest {
    func encoded() throws -> Data {
        var object: [String: Any] = ["jsonrpc": jsonrpc, "id": id, "method": method]
        if let params { object["params"] = params }
        return try WireJSON.encode(object)
    }
}

extension RpcResponse {
    static func decode(_ data: Data) throws -> RpcResponse {
        let o = try WireJSON.object(data)
        guard o["jsonrpc"] as? String == "2.0", case .number(let n) = RpcId(o["id"]), let id = Int(exactly: n) else { throw LinkFailure.invalid("无效的 RPC 响应") }
        let error = (o["error"] as? [String: Any]).map { RpcError(code: $0["code"] as? Int ?? -1, message: $0["message"] as? String ?? "电脑那边出错了") }
        return RpcResponse(id: id, result: o["result"], error: error)
    }
}

extension ServerNotice {
    static func decode(_ data: Data) throws -> ServerNotice? {
        let o = try WireJSON.object(data)
        guard o["jsonrpc"] as? String == "2.0", let p = o["params"] as? [String: Any] else { return nil }
        switch o["method"] as? String {
        case "mobile.event":
            let event = p["event"] as? [String: Any] ?? p
            guard let type = event["type"] as? String else { return nil }
            return .event(type: type, payload: event)
        case "mobile.status": return .status(p["status"] as? String ?? "idle")
        case "mobile.ask": return .ask(id: p["id"] as? String ?? "", kind: p["kind"] as? String ?? "", payload: p["payload"] as? [String: Any] ?? [:])
        case "mobile.presence": return .presence(online: p["online"] as? Bool ?? false)
        case "mobile.log": return .log(level: p["level"] as? String ?? "info", message: p["message"] as? String ?? "")
        default: return nil
        }
    }
}

enum WireJSON {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw LinkFailure.invalid("无效的 JSON 对象") }
        return o
    }
    static func encode(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) }
}
