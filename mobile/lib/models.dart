/// Shared data types. These mirror the desktop app's wire protocol so the
/// phone and PC interoperate.

class Peer {
  final String id;
  String name;
  String ip;
  int port;
  String? fingerprint;
  String? os;
  String? version;
  int lastSeen;
  bool manual;

  Peer({
    required this.id,
    required this.name,
    required this.ip,
    required this.port,
    this.fingerprint,
    this.os,
    this.version,
    int? lastSeen,
    this.manual = false,
  }) : lastSeen = lastSeen ?? DateTime.now().millisecondsSinceEpoch;
}

enum TransferDir { incoming, outgoing }

class Transfer {
  final String id;
  final TransferDir dir;
  final String peerName;
  final String fileName;
  final int total;
  int transferred;
  String status; // pending | active | done | error | declined | canceled
  String? savedPath;

  Transfer({
    required this.id,
    required this.dir,
    required this.peerName,
    required this.fileName,
    required this.total,
    this.transferred = 0,
    this.status = 'pending',
    this.savedPath,
  });

  double get progress => total > 0 ? (transferred / total).clamp(0, 1) : 0;
}

class ChatMessage {
  final bool mine; // true = sent by us
  final String text;
  final int ts;
  bool failed;

  ChatMessage({required this.mine, required this.text, required this.ts, this.failed = false});

  Map<String, dynamic> toJson() => {'mine': mine, 'text': text, 'ts': ts, 'failed': failed};
  factory ChatMessage.fromJson(Map<String, dynamic> j) =>
      ChatMessage(mine: j['mine'] == true, text: j['text'] ?? '', ts: j['ts'] ?? 0, failed: j['failed'] == true);
}

/// A pending incoming transfer awaiting the user's Accept/Decline.
class IncomingRequest {
  final String fromName;
  final List<Map<String, dynamic>> files; // [{name, size}]
  final int totalSize;
  IncomingRequest({required this.fromName, required this.files, required this.totalSize});
}
