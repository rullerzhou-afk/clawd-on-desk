#!/usr/bin/env python3
"""
Watch Buddy Bridge — BLE Central sidecar for the Clawd watch backend.

Connects to a Wear OS watch running the Clawd app (BLE Peripheral) and
forwards session snapshots from stdin to GATT characteristic CWD1, approval
requests to CWD2, and relays approval responses from CWD3 back to stdout.

stdio protocol (newline-delimited JSON, same as clawstick sidecar):

  stdin  <- {"type":"snapshot","payload":{...}}
  stdin  <- {"type":"approval_request","requestId":"...","tool":"Bash",...}
  stdin  <- {"type":"connect","address":"AA:BB:CC:DD:EE:FF"}
  stdin  <- {"type":"scan"}
  stdin  <- {"type":"stop"}

  stdout -> {"type":"status","connected":true,"deviceName":"Android Watch"}
  stdout -> {"type":"devices","items":[{"address":"...","name":"...","rssi":-54}]}
  stdout -> {"type":"approval_response","requestId":"...","decision":"allow"}
  stdout -> {"type":"error","code":"...","message":"..."}
"""

import asyncio
import json
import sys
import argparse

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.stdout.write(json.dumps({
        "type": "error",
        "code": "MISSING_BLEAK",
        "message": "Python 'bleak' package is not installed. Run: pip install bleak",
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)

CWD_SERVICE = "00000cd0-0000-1000-8000-00805f9b34fb"
CWD1_STATE = "00000cd1-0000-1000-8000-00805f9b34fb"
CWD2_APPROVAL_REQ = "00000cd2-0000-1000-8000-00805f9b34fb"
CWD3_APPROVAL_RESP = "00000cd3-0000-1000-8000-00805f9b34fb"
CWD4_META = "00000cd4-0000-1000-8000-00805f9b34fb"

RECONNECT_DELAYS = [2, 5, 10, 15, 30, 30, 30]


def emit(obj):
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def emit_status(connected, device_name=None):
    msg = {"type": "status", "connected": connected}
    if device_name:
        msg["deviceName"] = device_name
    emit(msg)


def emit_error(code, message):
    emit({"type": "error", "code": code, "message": message})


async def scan_for_watch(name_prefix, timeout=10.0):
    devices_advs = await BleakScanner.discover(timeout=timeout, return_adv=True)
    results = []
    for addr, (device, adv) in devices_advs.items():
        uuids = adv.service_uuids or []
        name = device.name or ""
        if CWD_SERVICE in uuids or (name_prefix and name.startswith(name_prefix)):
            results.append({
                "address": device.address,
                "name": name,
                "rssi": adv.rssi,
            })
    return results


async def read_stdin_lines(queue, on_eof=None):
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            if on_eof:
                on_eof()
            await queue.put(None)
            break
        text = line.decode("utf-8", errors="replace").strip()
        if text:
            try:
                await queue.put(json.loads(text))
            except json.JSONDecodeError:
                pass


async def run(args):
    client = None
    connected_name = None
    last_address = None
    last_snapshot_data = None
    reconnect_attempt = 0
    reconnect_task = None
    stopping = False
    stdin_queue = asyncio.Queue()

    def on_stdin_eof():
        nonlocal stopping
        stopping = True

    stdin_task = asyncio.ensure_future(read_stdin_lines(stdin_queue, on_eof=on_stdin_eof))
    stdin_task.add_done_callback(lambda t: t.exception() if not t.cancelled() and t.exception() else None)

    import signal
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: stdin_queue.put_nowait(None))

    async def schedule_reconnect():
        nonlocal reconnect_task
        if stopping or reconnect_task is not None:
            return
        addr = last_address
        if not addr:
            reconnect_task = asyncio.ensure_future(reconnect_via_scan())
        else:
            reconnect_task = asyncio.ensure_future(reconnect_to(addr))

    async def reconnect_to(address):
        nonlocal reconnect_task, reconnect_attempt
        delay = RECONNECT_DELAYS[min(reconnect_attempt, len(RECONNECT_DELAYS) - 1)]
        reconnect_attempt += 1
        await asyncio.sleep(delay)
        try:
            if stopping or (client and client.is_connected):
                return
            await connect_to(address)
            if not client or not client.is_connected:
                await schedule_reconnect()
        finally:
            reconnect_task = None

    async def reconnect_via_scan():
        nonlocal reconnect_task, reconnect_attempt
        delay = RECONNECT_DELAYS[min(reconnect_attempt, len(RECONNECT_DELAYS) - 1)]
        reconnect_attempt += 1
        await asyncio.sleep(delay)
        try:
            if stopping or (client and client.is_connected):
                return
            await do_scan()
            if not client or not client.is_connected:
                await schedule_reconnect()
        finally:
            reconnect_task = None

    async def force_disconnect():
        nonlocal client
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
            client = None
            emit_status(False)
            if not stopping:
                await schedule_reconnect()

    def on_disconnect(_client):
        nonlocal client
        client = None
        emit_status(False)
        if not stopping:
            asyncio.ensure_future(schedule_reconnect())

    def on_cwd3_notify(_sender, data):
        try:
            resp = json.loads(data.decode("utf-8"))
            emit({
                "type": "approval_response",
                "requestId": resp.get("requestId", ""),
                "decision": resp.get("decision", "deny"),
            })
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            emit_error("CWD3_PARSE_ERROR", f"Bad approval response: {e}")

    async def connect_to(address):
        nonlocal client, connected_name, last_address, reconnect_attempt
        if client and client.is_connected:
            await client.disconnect()

        try:
            c = BleakClient(address, disconnected_callback=on_disconnect)
            await c.connect(timeout=args.connect_timeout)
            if not c.is_connected:
                emit_error("CONNECT_FAILED", f"failed to connect to {address}")
                return

            meta_bytes = await c.read_gatt_char(CWD4_META)
            meta = json.loads(meta_bytes.decode("utf-8"))
            connected_name = meta.get("deviceName", address)

            await c.start_notify(CWD3_APPROVAL_RESP, on_cwd3_notify)

            client = c
            last_address = address
            reconnect_attempt = 0
            emit_status(True, connected_name)
            if last_snapshot_data is not None:
                try:
                    await c.write_gatt_char(CWD1_STATE, last_snapshot_data)
                except Exception:
                    pass
        except Exception as e:
            emit_error("CONNECT_FAILED", str(e))

    async def do_scan():
        try:
            items = await scan_for_watch(args.name_prefix, timeout=args.scan_timeout)
            emit({"type": "devices", "items": items})
            if args.address:
                for item in items:
                    if item["address"].lower() == args.address.lower():
                        await connect_to(item["address"])
                        return
            elif len(items) == 1:
                await connect_to(items[0]["address"])
        except Exception as e:
            emit_error("SCAN_FAILED", str(e))

    # Initial action: connect directly or scan
    if args.address:
        await connect_to(args.address)
    else:
        await do_scan()

    if not client or not client.is_connected:
        await schedule_reconnect()

    # Main loop: read stdin commands, with periodic health check
    while True:
        try:
            msg = await asyncio.wait_for(stdin_queue.get(), timeout=15.0)
        except asyncio.TimeoutError:
            if client and client.is_connected:
                try:
                    await client.read_gatt_char(CWD4_META)
                except Exception:
                    emit_error("HEALTH_CHECK_FAILED", "CWD4 read failed, reconnecting")
                    await force_disconnect()
                    continue
                if last_snapshot_data is not None:
                    try:
                        await client.write_gatt_char(CWD1_STATE, last_snapshot_data)
                    except Exception:
                        await force_disconnect()
            elif not client or not client.is_connected:
                if not reconnect_task and not stopping:
                    await schedule_reconnect()
            continue
        if msg is None:
            break

        msg_type = msg.get("type", "")

        if msg_type == "snapshot":
            payload = msg.get("payload", msg)
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            last_snapshot_data = data.encode("utf-8")
            if client and client.is_connected:
                try:
                    await client.write_gatt_char(CWD1_STATE, last_snapshot_data)
                except Exception as e:
                    emit_error("WRITE_FAILED", str(e))
                    await force_disconnect()

        elif msg_type == "approval_request":
            if client and client.is_connected:
                req = {k: v for k, v in msg.items() if k != "type"}
                data = json.dumps(req, ensure_ascii=False, separators=(",", ":"))
                try:
                    await client.write_gatt_char(CWD2_APPROVAL_REQ, data.encode("utf-8"))
                except Exception as e:
                    emit_error("WRITE_FAILED", str(e))
                    await force_disconnect()

        elif msg_type == "connect":
            addr = msg.get("address", "")
            if addr:
                if reconnect_task:
                    reconnect_task.cancel()
                    reconnect_task = None
                reconnect_attempt = 0
                await connect_to(addr)
                if not client or not client.is_connected:
                    if not stopping:
                        await schedule_reconnect()

        elif msg_type == "scan":
            if reconnect_task:
                reconnect_task.cancel()
                reconnect_task = None
            reconnect_attempt = 0
            await do_scan()

        elif msg_type == "stop":
            break

    stopping = True
    if reconnect_task:
        reconnect_task.cancel()
    if client and client.is_connected:
        await client.disconnect()
    emit_status(False)


def main():
    parser = argparse.ArgumentParser(description="Watch Buddy Bridge")
    parser.add_argument("--backend", default="watch")
    parser.add_argument("--name-prefix", default="Clawd")
    parser.add_argument("--address", default="")
    parser.add_argument("--scan-timeout", type=float, default=10.0)
    parser.add_argument("--connect-timeout", type=float, default=15.0)
    args = parser.parse_args()

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
