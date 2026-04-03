#!/usr/bin/env python3
"""Retrieve conversations and messages from Slack."""

import argparse
import json
import os
import sys
from datetime import datetime

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


def get_client() -> WebClient:
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        sys.exit("SLACK_BOT_TOKEN environment variable not set")
    return WebClient(token=token)


def list_conversations(client: WebClient, types: str = "public_channel,private_channel,im,mpim") -> list[dict]:
    """List all conversations the bot has access to."""
    conversations = []
    cursor = None
    while True:
        resp = client.conversations_list(types=types, limit=200, cursor=cursor)
        conversations.extend(resp["channels"])
        cursor = resp.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    return conversations


def get_messages(client: WebClient, channel_id: str, limit: int = 100, oldest: str = None, latest: str = None) -> list[dict]:
    """Retrieve messages from a channel."""
    messages = []
    cursor = None
    kwargs = {"channel": channel_id, "limit": min(limit, 200)}
    if oldest:
        kwargs["oldest"] = oldest
    if latest:
        kwargs["latest"] = latest

    while len(messages) < limit:
        if cursor:
            kwargs["cursor"] = cursor
        resp = client.conversations_history(**kwargs)
        messages.extend(resp["messages"])
        if not resp.get("has_more") or len(messages) >= limit:
            break
        cursor = resp["response_metadata"]["next_cursor"]

    return messages[:limit]


def get_thread_replies(client: WebClient, channel_id: str, thread_ts: str) -> list[dict]:
    """Retrieve all replies in a thread."""
    replies = []
    cursor = None
    while True:
        kwargs = {"channel": channel_id, "ts": thread_ts, "limit": 200}
        if cursor:
            kwargs["cursor"] = cursor
        resp = client.conversations_replies(**kwargs)
        replies.extend(resp["messages"])
        cursor = resp.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    return replies


def format_ts(ts: str) -> str:
    return datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M:%S")


def main():
    parser = argparse.ArgumentParser(description="Retrieve Slack conversations")
    sub = parser.add_subparsers(dest="command", required=True)

    # list channels
    list_cmd = sub.add_parser("list", help="List accessible conversations")
    list_cmd.add_argument("--types", default="public_channel,private_channel,im,mpim",
                          help="Comma-separated conversation types")
    list_cmd.add_argument("--json", action="store_true", dest="as_json")

    # fetch messages
    fetch_cmd = sub.add_parser("fetch", help="Fetch messages from a channel")
    fetch_cmd.add_argument("channel", help="Channel ID or name (e.g. C1234567890 or #general)")
    fetch_cmd.add_argument("--limit", type=int, default=100)
    fetch_cmd.add_argument("--oldest", help="Start timestamp (Unix epoch)")
    fetch_cmd.add_argument("--latest", help="End timestamp (Unix epoch)")
    fetch_cmd.add_argument("--threads", action="store_true", help="Fetch replies for threaded messages")
    fetch_cmd.add_argument("--json", action="store_true", dest="as_json")

    # fetch a specific thread
    thread_cmd = sub.add_parser("thread", help="Fetch all replies in a thread")
    thread_cmd.add_argument("channel", help="Channel ID")
    thread_cmd.add_argument("ts", help="Parent message timestamp")
    thread_cmd.add_argument("--json", action="store_true", dest="as_json")

    args = parser.parse_args()
    client = get_client()

    try:
        if args.command == "list":
            conversations = list_conversations(client, types=args.types)
            if args.as_json:
                print(json.dumps(conversations, indent=2))
            else:
                for c in conversations:
                    name = c.get("name") or c.get("user") or c["id"]
                    ctype = c.get("is_im") and "DM" or c.get("is_mpim") and "group DM" or \
                            (c.get("is_private") and "private") or "public"
                    print(f"{c['id']:>15}  [{ctype:>8}]  {name}")

        elif args.command == "fetch":
            channel_id = args.channel.lstrip("#")
            # resolve name → ID if needed
            if not channel_id.startswith("C") and not channel_id.startswith("D") and not channel_id.startswith("G"):
                convos = list_conversations(client)
                match = next((c for c in convos if c.get("name") == channel_id), None)
                if not match:
                    sys.exit(f"Channel '{channel_id}' not found")
                channel_id = match["id"]

            messages = get_messages(client, channel_id, limit=args.limit,
                                     oldest=args.oldest, latest=args.latest)

            if args.threads:
                for msg in messages:
                    if msg.get("reply_count", 0) > 0:
                        msg["replies"] = get_thread_replies(client, channel_id, msg["ts"])[1:]  # skip parent

            if args.as_json:
                print(json.dumps(messages, indent=2))
            else:
                for msg in reversed(messages):
                    user = msg.get("user") or msg.get("bot_id") or "unknown"
                    ts = format_ts(msg["ts"])
                    text = msg.get("text", "").replace("\n", " ")[:120]
                    print(f"[{ts}] {user}: {text}")
                    if args.threads and msg.get("replies"):
                        for reply in msg["replies"]:
                            ru = reply.get("user") or "unknown"
                            rt = format_ts(reply["ts"])
                            rt_text = reply.get("text", "").replace("\n", " ")[:100]
                            print(f"  └ [{rt}] {ru}: {rt_text}")

        elif args.command == "thread":
            replies = get_thread_replies(client, args.channel, args.ts)
            if args.as_json:
                print(json.dumps(replies, indent=2))
            else:
                for msg in replies:
                    user = msg.get("user") or msg.get("bot_id") or "unknown"
                    ts = format_ts(msg["ts"])
                    text = msg.get("text", "").replace("\n", " ")[:120]
                    print(f"[{ts}] {user}: {text}")

    except SlackApiError as e:
        sys.exit(f"Slack API error: {e.response['error']}")


if __name__ == "__main__":
    main()
