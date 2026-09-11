"""
Test Redis RESP protocol parser with XREADGROUP response format.
No Redis connection needed - pure unit test.

Usage: python3 test/test-stream-resp-parser.py
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools", "ev-notifier"))
from ev_notifier import RedisProtocol, redis_array


def build_resp_xreadgroup_reply(stream_key, messages):
    """
    Build raw RESP bytes for XREADGROUP response:
    *1           - 1 stream result
      *2         - [stream_key, messages_array]
        $N...stream_key
        *M       - M messages
          *2     - [msg_id, fields]
            $N...msg_id
            *K   - K field pairs [field1, val1, ...]
              $N...field1
              $N...val1
    """
    parts = []

    if not messages:
        parts.append(b"$-1\r\n")
        return b"".join(parts)

    parts.append(b"*1\r\n")
    parts.append(b"*2\r\n")

    key_bytes = stream_key.encode()
    parts.append(b"$%d\r\n%s\r\n" % (len(key_bytes), key_bytes))

    parts.append(b"*%d\r\n" % len(messages))
    for msg_id, data_json in messages:
        parts.append(b"*2\r\n")

        mid_bytes = msg_id.encode()
        parts.append(b"$%d\r\n%s\r\n" % (len(mid_bytes), mid_bytes))

        data_bytes = json.dumps(data_json).encode()
        parts.append(b"*2\r\n")

        field_bytes = b"data"
        parts.append(b"$%d\r\n%s\r\n" % (len(field_bytes), field_bytes))

        parts.append(b"$%d\r\n%s\r\n" % (len(data_bytes), data_bytes))

    return b"".join(parts)


def test_parse_single_message():
    """XREADGROUP with 1 message"""
    raw = build_resp_xreadgroup_reply(
        "auth:notifications:stream",
        [("1726065000000-0", {"ts": 1726065000, "type": "new_activation", "payload": {"redeem_code": "TEST-CODE"}})]
    )
    proto = RedisProtocol()
    proto.feed(raw)
    replies = proto.parse_all()

    assert len(replies) == 1, f"Expected 1 reply, got {len(replies)}"
    reply = replies[0]
    # Unwrap top-level *1 array
    if isinstance(reply, list) and len(reply) == 1:
        reply = reply[0]
    assert isinstance(reply, list), f"Expected list, got {type(reply)}"
    assert len(reply) >= 2, f"Expected >=2 elements, got {len(reply)}"

    stream_name = reply[0]
    messages = reply[1]
    assert stream_name == "auth:notifications:stream", f"Stream name mismatch: {stream_name}"
    assert isinstance(messages, list), f"Expected list for messages, got {type(messages)}"
    assert len(messages) == 1, f"Expected 1 message, got {len(messages)}"

    msg_entry = messages[0]
    msg_id = msg_entry[0]
    fields = msg_entry[1]
    assert msg_id == "1726065000000-0", f"Msg ID mismatch: {msg_id}"
    assert "data" in fields, f"Fields: {fields}"

    data_idx = fields.index("data")
    payload = json.loads(fields[data_idx + 1])
    assert payload["type"] == "new_activation"
    assert payload["payload"]["redeem_code"] == "TEST-CODE"

    print("  PASS: single message parse")


def test_parse_multiple_messages():
    """XREADGROUP with 3 messages"""
    raw = build_resp_xreadgroup_reply(
        "auth:notifications:stream",
        [
            ("1726065000000-0", {"ts": 1, "type": "new_activation", "payload": {"redeem_code": "C1"}}),
            ("1726065000001-0", {"ts": 2, "type": "page_visit", "payload": {"page": "/home"}}),
            ("1726065000002-0", {"ts": 3, "type": "activation_failure", "payload": {"reason": "Invalid code"}}),
        ]
    )
    proto = RedisProtocol()
    proto.feed(raw)
    replies = proto.parse_all()

    reply = replies[0]
    if isinstance(reply, list) and len(reply) == 1:
        reply = reply[0]
    messages = reply[1]
    assert len(messages) == 3, f"Expected 3 messages, got {len(messages)}"

    types = []
    for msg_entry in messages:
        msg_id = msg_entry[0]
        fields = msg_entry[1]
        data_idx = fields.index("data")
        payload = json.loads(fields[data_idx + 1])
        types.append(payload["type"])

    assert types == ["new_activation", "page_visit", "activation_failure"], f"Types mismatch: {types}"
    print("  PASS: multiple messages parse")


def test_parse_timeout():
    """XREADGROUP timeout returns nil bulk string"""
    raw = b"$-1\r\n"
    proto = RedisProtocol()
    proto.feed(raw)
    replies = proto.parse_all()

    assert replies == [], f"Timeout should yield empty list, got: {replies}"
    print("  PASS: timeout nil response")


def test_parse_partial_feed():
    """Messages arriving in chunks (partial reads)"""
    raw = build_resp_xreadgroup_reply(
        "auth:notifications:stream",
        [
            ("1726065000000-0", {"ts": 1, "type": "new_activation", "payload": {}}),
            ("1726065000001-0", {"ts": 2, "type": "page_visit", "payload": {}}),
        ]
    )

    mid = len(raw) // 3
    proto = RedisProtocol()

    proto.feed(raw[:mid])
    replies1 = proto.parse_all()
    assert replies1 == [], f"Partial feed should yield empty: {replies1}"

    proto.feed(raw[mid:])
    replies2 = proto.parse_all()
    assert len(replies2) == 1, f"Full feed should yield 1 reply: {replies2}"
    reply = replies2[0]
    if isinstance(reply, list) and len(reply) == 1:
        reply = reply[0]
    messages = reply[1]
    assert len(messages) == 2, f"Expected 2 messages: {messages}"

    print("  PASS: partial feed reassembly")


def test_build_xgroup_create():
    """XGROUP CREATE command format"""
    cmd = redis_array("XGROUP", "CREATE", "auth:notifications:stream", "ev-notifiers", "$", "MKSTREAM")
    expected = b"*6\r\n$6\r\nXGROUP\r\n$6\r\nCREATE\r\n$25\r\nauth:notifications:stream\r\n$12\r\nev-notifiers\r\n$1\r\n$\r\n$8\r\nMKSTREAM\r\n"
    assert cmd == expected, f"XGROUP CREATE:\n  Expected: {expected}\n  Got:      {cmd}"
    print("  PASS: XGROUP CREATE command format")


def test_build_xreadgroup():
    """XREADGROUP command format"""
    cmd = redis_array(
        "XREADGROUP", "GROUP", "ev-notifiers", "mac-consumer",
        "COUNT", "10", "BLOCK", "5000",
        "STREAMS", "auth:notifications:stream", ">"
    )
    expected = (
        b"*11\r\n"
        b"$10\r\nXREADGROUP\r\n"
        b"$5\r\nGROUP\r\n"
        b"$12\r\nev-notifiers\r\n"
        b"$12\r\nmac-consumer\r\n"
        b"$5\r\nCOUNT\r\n"
        b"$2\r\n10\r\n"
        b"$5\r\nBLOCK\r\n"
        b"$4\r\n5000\r\n"
        b"$7\r\nSTREAMS\r\n"
        b"$25\r\nauth:notifications:stream\r\n"
        b"$1\r\n>\r\n"
    )
    assert cmd == expected, f"XREADGROUP format mismatch"
    print("  PASS: XREADGROUP command format")


def test_build_xack():
    """XACK command format"""
    cmd = redis_array("XACK", "auth:notifications:stream", "ev-notifiers", "1726065000000-0")
    expected = b"*4\r\n$4\r\nXACK\r\n$25\r\nauth:notifications:stream\r\n$12\r\nev-notifiers\r\n$15\r\n1726065000000-0\r\n"
    assert cmd == expected, f"XACK format mismatch"
    print("  PASS: XACK command format")


def test_build_auth():
    """AUTH command format"""
    cmd = redis_array("AUTH", "test-token-123")
    expected = b"*2\r\n$4\r\nAUTH\r\n$14\r\ntest-token-123\r\n"
    assert cmd == expected, f"AUTH format mismatch"
    print("  PASS: AUTH command format")


def test_escape_special_chars():
    """Parse message with special JSON characters"""
    raw = build_resp_xreadgroup_reply(
        "auth:notifications:stream",
        [("1726065000000-0", {"ts": 1, "type": "page_visit", "payload": {"page": "/api/admin?token=abc&x=y\nnewline"}})]
    )
    proto = RedisProtocol()
    proto.feed(raw)
    replies = proto.parse_all()

    msg_entry = replies[0][0][1][0]
    fields = msg_entry[1]
    data_idx = fields.index("data")
    payload = json.loads(fields[data_idx + 1])
    assert payload["payload"]["page"] == "/api/admin?token=abc&x=y\nnewline"
    print("  PASS: special characters in payload")


if __name__ == "__main__":
    print("=" * 60)
    print("Stream RESP Protocol Parser Tests")
    print("=" * 60)

    tests = [
        ("single message parse", test_parse_single_message),
        ("multiple messages parse", test_parse_multiple_messages),
        ("timeout nil response", test_parse_timeout),
        ("partial feed reassembly", test_parse_partial_feed),
        ("XGROUP CREATE command", test_build_xgroup_create),
        ("XREADGROUP command", test_build_xreadgroup),
        ("XACK command", test_build_xack),
        ("AUTH command", test_build_auth),
        ("special characters", test_escape_special_chars),
    ]

    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f"  FAIL: {name}: {e}")
            failed += 1
            import traceback
            traceback.print_exc()

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {len(tests)} total")
    if failed:
        print("SOME TESTS FAILED!")
        sys.exit(1)
    else:
        print("ALL TESTS PASSED!")